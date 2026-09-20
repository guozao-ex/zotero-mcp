/**
 * 最小 ZIP 读写（只覆盖 `.docx` 需要的部分），不引入第三方依赖。
 *
 * 设计要点：**未被改动的条目按原始字节整段复制**（本地头 + 压缩数据 + 可选的
 * 数据描述符），因此重新打包后这些条目的压缩字节、压缩方式与顺序都与原文件一致；
 * 只有被替换的条目才重建本地头并重新压缩。中央目录按新的偏移重写。
 *
 * 不支持 ZIP64（`.docx` 不会用到）；遇到 ZIP64 或未知压缩方式时如实抛错，
 * 由调用方走降级路径。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;

/** 单个条目解压后的字节上限：`.docx` 的正常体量远低于此值，用于挡住异常输入。 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** 标准 CRC-32（IEEE 802.3），与 ZIP 条目里的校验值一致。 */
export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  /** 0 = 存储，8 = deflate。 */
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  versionMadeBy: number;
  versionNeeded: number;
  modTime: number;
  modDate: number;
  internalAttributes: number;
  externalAttributes: number;
  /** 本地记录原始字节；被替换过的条目为 null（重新打包时重建）。 */
  raw: Buffer | null;
  /** 解压后的内容。 */
  data: Buffer;
}

export interface ZipArchive {
  entries: ZipEntry[];
  comment: Buffer;
}

function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let index = buffer.length - 22; index >= minimum; index -= 1) {
    if (buffer.readUInt32LE(index) === SIG_EOCD) return index;
  }
  throw new Error('不是合法的 ZIP：找不到中央目录结尾记录');
}

/** 解析 ZIP（`.docx`）为条目清单；条目内容已解压。 */
export function readZip(buffer: Buffer): ZipArchive {
  if (buffer.length < 22) throw new Error('不是合法的 ZIP：文件过短');
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);
  const comment = buffer.subarray(eocd + 22, eocd + 22 + commentLength);
  if (directoryOffset === 0xffffffff || count === 0xffff || directorySize === 0xffffffff) {
    throw new Error('不支持 ZIP64 格式的 .docx');
  }
  if (directoryOffset + directorySize > buffer.length) {
    throw new Error('不是合法的 ZIP：中央目录越界');
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error('不是合法的 ZIP：中央目录条目签名错误');
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const modTime = buffer.readUInt16LE(cursor + 12);
    const modDate = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const internalAttributes = buffer.readUInt16LE(cursor + 36);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + entryCommentLength;

    if (localOffset === 0xffffffff || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error(`不支持 ZIP64 条目：${name}`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`条目过大，拒绝解压：${name}（${uncompressedSize} 字节）`);
    }
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`不是合法的 ZIP：${name} 的本地头签名错误`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`不是合法的 ZIP：${name} 数据越界`);
    let rawEnd = dataEnd;
    if ((flags & 0x08) !== 0) {
      // 数据描述符：可选签名（4 字节）+ crc/压缩大小/原始大小（12 字节）
      const hasSignature =
        dataEnd + 4 <= buffer.length && buffer.readUInt32LE(dataEnd) === SIG_DESCRIPTOR;
      rawEnd = dataEnd + (hasSignature ? 16 : 12);
    }
    if (rawEnd > buffer.length) throw new Error(`不是合法的 ZIP：${name} 的数据描述符越界`);

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`不支持的压缩方式 ${method}（条目 ${name}）`);

    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      uncompressedSize,
      versionMadeBy,
      versionNeeded,
      modTime,
      modDate,
      internalAttributes,
      externalAttributes,
      raw: Buffer.from(buffer.subarray(localOffset, rawEnd)),
      data,
    });
  }
  return { entries, comment: Buffer.from(comment) };
}

/**
 * 用新内容替换某个条目（返回新的归档对象，不修改入参）。
 *
 * 保留原有压缩方式（存储条目仍存储），并把该条目的 `raw` 置空以便重新打包时重建；
 * 其余条目的原始字节不受影响。
 */
export function replaceEntry(archive: ZipArchive, name: string, content: Buffer): ZipArchive {
  const index = archive.entries.findIndex((entry) => entry.name === name);
  if (index < 0) throw new Error(`ZIP 中不存在条目：${name}`);
  const original = archive.entries[index] as ZipEntry;
  const replaced: ZipEntry = {
    ...original,
    data: Buffer.from(content),
    uncompressedSize: content.length,
    crc: crc32(content),
    raw: null,
  };
  const entries = [...archive.entries];
  entries[index] = replaced;
  return { entries, comment: archive.comment };
}

/** 按当前条目状态重新打包为 ZIP 字节。 */
export function writeZip(archive: ZipArchive): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of archive.entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    let localRecord: Buffer;
    let flags = entry.flags;
    let crc = entry.crc;
    let compressedSize = entry.compressedSize;
    let uncompressedSize = entry.uncompressedSize;
    let method = entry.method;

    if (entry.raw !== null) {
      localRecord = entry.raw;
    } else {
      const compressed = method === 0 ? entry.data : deflateRawSync(entry.data, { level: 9 });
      method = method === 0 ? 0 : 8;
      flags = flags & ~0x08; // 大小已知，不再需要数据描述符
      crc = crc32(entry.data);
      compressedSize = compressed.length;
      uncompressedSize = entry.data.length;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(SIG_LOCAL, 0);
      header.writeUInt16LE(Math.max(entry.versionNeeded, 20), 4);
      header.writeUInt16LE(flags, 6);
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(entry.modTime, 10);
      header.writeUInt16LE(entry.modDate, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(compressedSize, 18);
      header.writeUInt32LE(uncompressedSize, 22);
      header.writeUInt16LE(nameBuffer.length, 26);
      header.writeUInt16LE(0, 28);
      localRecord = Buffer.concat([header, nameBuffer, compressed]);
    }

    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIG_CENTRAL, 0);
    header.writeUInt16LE(entry.versionMadeBy, 4);
    header.writeUInt16LE(Math.max(entry.versionNeeded, 20), 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(entry.modTime, 12);
    header.writeUInt16LE(entry.modDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressedSize, 20);
    header.writeUInt32LE(uncompressedSize, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(entry.internalAttributes, 36);
    header.writeUInt32LE(entry.externalAttributes, 38);
    header.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([header, nameBuffer]));

    chunks.push(localRecord);
    offset += localRecord.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(archive.entries.length, 8);
  eocd.writeUInt16LE(archive.entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(archive.comment.length, 20);

  return Buffer.concat([...chunks, centralBuffer, eocd, archive.comment]);
}

/** 从「条目名 → 内容」构造一个全新的 ZIP（用于生成最小 `.docx`）。 */
export function createZip(files: { name: string; content: string | Buffer }[]): Buffer {
  const archive: ZipArchive = {
    entries: files.map((file) => {
      const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
      return {
        name: file.name,
        method: 8,
        flags: 0,
        crc: crc32(data),
        compressedSize: 0,
        uncompressedSize: data.length,
        versionMadeBy: 20,
        versionNeeded: 20,
        modTime: 0,
        modDate: 0x21, // 1980-01-01，避免依赖本地时区
        internalAttributes: 0,
        externalAttributes: 0,
        raw: null,
        data,
      };
    }),
    comment: Buffer.alloc(0),
  };
  return writeZip(archive);
}

/** OOXML 主文档部件名（注入只改这一个条目）。 */
export const DOCUMENT_PART = 'word/document.xml';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

/**
 * 生成一份最小但合法的 `.docx`：标题段落 + 每个引用占位符一个段落 +
 * 参考文献块段落（后者始终生成，注入时按占位符位置替换）。
 */
export function buildMinimalDocx(options: { title: string; placeholders: string[] }): Buffer {
  const paragraphs = [options.title, ...options.placeholders].map(paragraphXml);
  return createZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    {
      name: DOCUMENT_PART,
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        paragraphs.join('') +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
        '</w:body></w:document>',
    },
  ]);
}

function paragraphXml(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`;
}

/** XML 文本转义（元素内容用；`"` 不需要转义但转义后同样合法）。 */
export function escapeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
