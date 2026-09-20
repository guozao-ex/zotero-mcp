/**
 * SentencePiece / **unigram** 分词器（XLM-R 系多语种模型）。
 *
 * 与 `tokenizer.ts` 的 WordPiece 分词器**同一接口**（`vocab` / `vocabSize` / `maxContentTokens` /
 * `countTokens` / `encode`），因此 `chunk.ts` 不需要任何改动。
 *
 * 三步，顺序与 HuggingFace `tokenizer.json` 一致：
 *   1. **normalizer**（`{"type":"Precompiled","precompiled_charsmap":"…"}`）：SentencePiece 的规范化表——
 *      一个序列化的 **Darts 双数组**（trie）+ 替换串区。逐位置取**最长匹配**并替换；没命中的合法 UTF-8 字符原样复制；
 *      非法字节消费 1 字节并输出 U+FFFD。**不是**「小写化 + 去音标」（XLM-R 是 cased 模型）。
 *   2. **pre_tokenizer**（`WhitespaceSplit` → `Metaspace(add_prefix_space)`）：先按空白切开，再给每段前面加 `▁`。
 *   3. **model**（`Unigram`）：在词表上按**最大对数概率路径**做 **Viterbi** 解码（**不是贪心最长匹配**）。
 *      未登录字符落 `[UNK]`，其分数取 `minScore - 10.0`（SentencePiece 的 unk penalty）。
 */

import type { EncodeOptions, EncodedText, WordPieceTokenizer } from './tokenizer.ts';

const METASPACE = '\u2581';

// ---------------------------------------------------------------------------
// Precompiled charsmap（Darts 双数组）
// ---------------------------------------------------------------------------

/** darts-clone 的 unit 语义（`DoubleArrayUnit`）。 */
const u32 = (units: Uint32Array, index: number): number => units[index] ?? 0;
const unitHasLeaf = (unit: number): boolean => ((unit >>> 8) & 1) === 1;
const unitValue = (unit: number): number => unit & 0x7fffffff;
const unitLabel = (unit: number): number => unit & 0x800000ff;
const unitOffset = (unit: number): number =>
  (unit & (1 << 9)) === 0 ? unit >>> 10 : (unit >>> 10) * 256;

export interface PrecompiledCharsMap {
  /** 逐字节做最长匹配替换（与 SentencePiece `Normalizer::NormalizePrefix` 同语义）。 */
  normalize(input: string): string;
  readonly trieUnits: number;
}

/**
 * 解析 `precompiled_charsmap`：`[u32 LE trie 字节数][trie][以 NUL 分隔的替换串区]`。
 */
export function parsePrecompiledCharsMap(base64: string): PrecompiledCharsMap {
  const bin = Buffer.from(base64, 'base64');
  const trieBytes = bin.readUInt32LE(0);
  const units = new Uint32Array(trieBytes >>> 2);
  for (let i = 0; i < units.length; i += 1) units[i] = bin.readUInt32LE(4 + i * 4);
  const normalized = bin.subarray(4 + trieBytes);

  const readString = (offset: number): string => {
    let end = offset;
    while (end < normalized.length && normalized[end] !== 0) end += 1;
    return normalized.toString('utf8', offset, end);
  };

  /** 从 `bytes[start]` 起的最长匹配；无匹配返回 null。 */
  const longestMatch = (bytes: Buffer, start: number): { text: string; length: number } | null => {
    let nodePos = 0;
    let unit = u32(units, 0);
    let best: { text: string; length: number } | null = null;
    for (let i = start; i < bytes.length; i += 1) {
      const byte = bytes[i] as number;
      nodePos ^= unitOffset(unit) ^ byte;
      unit = u32(units, nodePos);
      if (unitLabel(unit) !== byte) break;
      if (unitHasLeaf(unit)) {
        const value = unitValue(u32(units, nodePos ^ unitOffset(unit)));
        best = { text: readString(value), length: i - start + 1 };
      }
    }
    return best;
  };

  const decodeOne = (bytes: Buffer, start: number): { text: string; length: number } | null => {
    const first = bytes[start] as number;
    let length = 0;
    if (first < 0x80) length = 1;
    else if ((first & 0xe0) === 0xc0) length = 2;
    else if ((first & 0xf0) === 0xe0) length = 3;
    else if ((first & 0xf8) === 0xf0) length = 4;
    if (length === 0 || start + length > bytes.length) return null;
    for (let i = 1; i < length; i += 1) {
      if (((bytes[start + i] as number) & 0xc0) !== 0x80) return null;
    }
    const text = bytes.toString('utf8', start, start + length);
    return text.includes('\uFFFD') ? null : { text, length };
  };

  return {
    trieUnits: units.length,
    normalize(input: string): string {
      const bytes = Buffer.from(input, 'utf8');
      let out = '';
      let i = 0;
      while (i < bytes.length) {
        const hit = longestMatch(bytes, i);
        if (hit !== null) {
          out += hit.text;
          i += hit.length;
          continue;
        }
        const one = decodeOne(bytes, i);
        if (one === null) {
          out += '\uFFFD'; // 非法 UTF-8：只消费 1 字节（与 SentencePiece 一致）
          i += 1;
        } else {
          out += one.text;
          i += one.length;
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Unigram 模型 + Viterbi
// ---------------------------------------------------------------------------

export interface UnigramVocab {
  /** piece → id。 */
  readonly vocab: Map<string, number>;
  /** id → 对数概率（SentencePiece 的 piece score）。 */
  readonly scores: Float64Array;
  readonly unkId: number;
  /** `[UNK]` 的分数：`minScore - 10.0`（SentencePiece 的 kUnkPenalty），解析期算一次。 */
  readonly unkScore: number;
}

/** SentencePiece 的 `kUnkPenalty`。 */
const UNK_PENALTY = 10;

export function parseUnigramVocab(raw: unknown): UnigramVocab {
  const model = (raw as { model?: { type?: string; unk_id?: number; vocab?: [string, number][] } }).model;
  if (model === undefined || model.type !== 'Unigram' || !Array.isArray(model.vocab)) {
    throw new Error('不是 Unigram 模型的 tokenizer.json（缺少 model.type = "Unigram"）');
  }
  const vocab = new Map<string, number>();
  const scores = new Float64Array(model.vocab.length);
  let minScore = Number.POSITIVE_INFINITY;
  for (let id = 0; id < model.vocab.length; id += 1) {
    const entry = model.vocab[id] as [string, number];
    vocab.set(entry[0], id);
    scores[id] = entry[1];
    if (entry[1] < minScore) minScore = entry[1];
  }
  return { vocab, scores, unkId: model.unk_id ?? 0, unkScore: minScore - UNK_PENALTY };
}

/** Viterbi：返回 piece 序列（未登录字符返回 id = unkId）。 */
export function viterbiTokenize(text: string, model: UnigramVocab, maxPieceLength = 32): number[] {
  const n = text.length;
  if (n === 0) return [];
  const best = new Float64Array(n + 1).fill(Number.NEGATIVE_INFINITY);
  const backStart = new Int32Array(n + 1).fill(-1);
  const backId = new Int32Array(n + 1).fill(-1);
  best[0] = 0;
  const unkScore = model.unkScore;
  for (let i = 0; i < n; i += 1) {
    const base = best[i] as number;
    if (base === Number.NEGATIVE_INFINITY) continue;
    const limit = Math.min(maxPieceLength, n - i);
    for (let length = 1; length <= limit; length += 1) {
      const piece = text.slice(i, i + length);
      // 单码元，或一个代理对（占两个 UTF-16 码元）= 一个字符：没有词表命中时落 UNK
      const isOneChar = length === 1 || (length === 2 && (text.charCodeAt(i) & 0xfc00) === 0xd800);
      const id = model.vocab.get(piece);
      let score: number;
      let useId: number;
      if (id !== undefined) {
        score = model.scores[id] as number;
        useId = id;
      } else if (isOneChar) {
        score = unkScore;
        useId = model.unkId;
      } else {
        continue;
      }
      const candidate = base + score;
      if (candidate > (best[i + length] as number)) {
        best[i + length] = candidate;
        backStart[i + length] = i;
        backId[i + length] = useId;
      }
    }
  }
  const ids: number[] = [];
  let cursor = n;
  while (cursor > 0) {
    const start = backStart[cursor] as number;
    if (start < 0) throw new Error('Viterbi 回溯失败');
    ids.push(backId[cursor] as number);
    cursor = start;
  }
  return ids.reverse();
}

// ---------------------------------------------------------------------------
// 组装成与 WordPiece 同形的分词器
// ---------------------------------------------------------------------------

interface TokenizerJson {
  added_tokens?: { id: number; content: string }[];
  normalizer?: { type?: string; precompiled_charsmap?: string };
  model?: unknown;
}

export interface CreateUnigramTokenizerOptions {
  maxContentTokens?: number;
}

export function createUnigramTokenizer(
  tokenizerJsonText: string,
  options: CreateUnigramTokenizerOptions = {},
): WordPieceTokenizer {
  const raw = JSON.parse(tokenizerJsonText) as TokenizerJson;
  const model = parseUnigramVocab(raw);
  const charsMapBase64 = raw.normalizer?.precompiled_charsmap;
  if (raw.normalizer?.type !== 'Precompiled' || typeof charsMapBase64 !== 'string') {
    throw new Error('tokenizer.json 的 normalizer 不是 Precompiled，无法用 unigram 分词器');
  }
  const charsMap = parsePrecompiledCharsMap(charsMapBase64);
  const special = new Map<string, number>();
  for (const token of raw.added_tokens ?? []) special.set(token.content, token.id);
  const cls = special.get('<s>');
  const sep = special.get('</s>');
  const unk = special.get('<unk>') ?? model.unkId;
  if (cls === undefined || sep === undefined) throw new Error('tokenizer.json 缺少 <s> / </s>');
  const maxContentTokens = options.maxContentTokens ?? 510;

  const toIds = (text: string): number[] => {
    const normalized = charsMap.normalize(text);
    const ids: number[] = [];
    for (const piece of normalized.split(/\s+/u)) {
      if (piece.length === 0) continue;
      const prepared = piece.startsWith(METASPACE) ? piece : `${METASPACE}${piece}`;
      for (const id of viterbiTokenize(prepared, model)) ids.push(id === model.unkId ? unk : id);
    }
    return ids;
  };

  return {
    vocab: model.vocab,
    vocabSize: model.vocab.size,
    maxContentTokens,
    countTokens: (text) => toIds(text).length,
    encode: (text, encodeOptions: EncodeOptions = {}) => {
      const limit = Math.min(encodeOptions.maxTokens ?? maxContentTokens + 2, maxContentTokens + 2);
      const content = toIds(text).slice(0, Math.max(1, limit - 2));
      const ids = [cls, ...content, sep];
      return {
        ids,
        attentionMask: ids.map(() => 1),
        tokenTypeIds: ids.map(() => 0),
      } satisfies EncodedText;
    },
  };
}
