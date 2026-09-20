/**
 * 本地 ONNX 嵌入后端（MiniLM 量化模型）。
 *
 * 设计要点：
 *   - 默认后端就是本地 ONNX（`ZOTERO_MCP_EMBED_BACKEND=local`），不依赖任何云服务；D5 的云后端
 *     只是「显式可选」，本轮不实现。
 *   - 模型与词表按需下载到缓存目录（`cache/models/<modelId>/`），**逐个文件校验 sha256**；
 *     拿不到模型时返回可读的不可用原因，由上层降级，绝不抛未捕获异常。
 *   - 池化用 attention mask 加权的 mean pooling + L2 归一化，与 sentence-transformers 的
 *     `all-MiniLM-L6-v2` 一致，因此余弦相似度可直接比较。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SPECIAL_IDS, createTokenizer } from './tokenizer.ts';
import { createUnigramTokenizer } from './tokenizer-unigram.ts';
import type { WordPieceTokenizer } from './tokenizer.ts';

export interface ModelAsset {
  name: string;
  url: string;
  sha256: string;
  /** 期望字节数（0 表示不校验长度）。 */
  bytes: number;
}

export interface ModelSpec {
  id: string;
  /** 向量维度（写进索引，维度变化必须整库重建）。 */
  dim: number;
  /** 位置上限（含特殊 token）。 */
  maxTokens: number;
  /**
   * 分词器类型：`wordpiece`（BERT 系词表 `vocab.txt`，缺省）或 `unigram`
   * （XLM-R 系的 SentencePiece `tokenizer.json`，Viterbi 解码）。缺省保持既有行为。
   */
  tokenizerKind?: 'wordpiece' | 'unigram';
  /** 词表选项（对齐该模型 `tokenizer_config.json` 的 do_lower_case / tokenize_chinese_chars）。 */
  tokenizer?: { cased?: boolean; cjk?: boolean };
  assets: ModelAsset[];
}

/** 默认模型：Xenova 的 all-MiniLM-L6-v2 量化 ONNX（v1 固定版本，逐文件校验 sha256）。 */
export const DEFAULT_MODEL: ModelSpec = {
  id: 'all-MiniLM-L6-v2-quantized',
  dim: 384,
  maxTokens: 512,
  assets: [
    {
      name: 'model_quantized.onnx',
      url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx',
      sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
      bytes: 22972370,
    },
    {
      name: 'vocab.txt',
      url: 'https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/vocab.txt',
      sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      bytes: 0,
    },
  ],
};

/** 中文优化模型（BERT-Chinese WordPiece 词表；`do_lower_case=false` + `tokenize_chinese_chars=true`）。 */
export const CHINESE_MODEL: ModelSpec = {
  id: 'bge-small-zh-v1.5-quantized',
  dim: 512,
  maxTokens: 512,
  tokenizer: { cased: true, cjk: true },
  assets: [
    {
      name: 'model_quantized.onnx',
      url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
      sha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
      bytes: 24010842,
    },
    {
      name: 'vocab.txt',
      url: 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/vocab.txt',
      sha256: '45bbac6b341c319adc98a532532882e91a9cefc0329aa57bac9ae761c27b291c',
      bytes: 109540,
    },
  ],
};

/**
 * 多语种模型（XLM-R 系，SentencePiece **unigram** 词表 25 万条）。
 *
 * dim 384 与缺省英文模型同维，便于「只换词表/分词器」的对照；资产体积远大于 BERT 系
 * （ONNX 118 MB + `tokenizer.json` 17 MB），下载与磁盘占用见 `docs/Q1_CHINESE_SEMANTIC.md`。
 */
export const MULTILINGUAL_MODEL: ModelSpec = {
  id: 'paraphrase-multilingual-MiniLM-L12-v2-quantized',
  dim: 384,
  maxTokens: 512,
  tokenizerKind: 'unigram',
  assets: [
    {
      name: 'model_quantized.onnx',
      url: 'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/onnx/model_quantized.onnx',
      sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc',
      bytes: 118308126,
    },
    {
      name: 'tokenizer.json',
      url: 'https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/main/tokenizer.json',
      sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441',
      bytes: 17082913,
    },
  ],
};

/** 可选模型注册表（id → spec）。缺省仍是英文 MiniLM，行为不变。 */
export const MODEL_REGISTRY: Record<string, ModelSpec> = {
  [DEFAULT_MODEL.id]: DEFAULT_MODEL,
  [CHINESE_MODEL.id]: CHINESE_MODEL,
  [MULTILINGUAL_MODEL.id]: MULTILINGUAL_MODEL,
};

/** `ZOTERO_MCP_INDEX_MODEL` 的别名（便于用户记）。 */
const MODEL_ALIASES: Record<string, string> = {
  default: DEFAULT_MODEL.id,
  english: DEFAULT_MODEL.id,
  en: DEFAULT_MODEL.id,
  chinese: CHINESE_MODEL.id,
  zh: CHINESE_MODEL.id,
  multilingual: MULTILINGUAL_MODEL.id,
  multi: MULTILINGUAL_MODEL.id,
};

/**
 * 解析模型选择：显式参数 > `ZOTERO_MCP_INDEX_MODEL` > 缺省。
 *
 * 未知值**必须可读拒绝**（不得静默回落到缺省）——静默回落会让用户以为在用中文模型、实际拿到英文索引，
 * 正是「中文检索不可用却没人发现」的成因之一。
 */
export function resolveModelSpec(requested?: string, env: NodeJS.ProcessEnv = process.env): ModelSpec {
  const raw = (requested ?? env['ZOTERO_MCP_INDEX_MODEL'] ?? '').trim();
  if (raw.length === 0) return DEFAULT_MODEL;
  const id = MODEL_ALIASES[raw.toLowerCase()] ?? raw;
  const spec = MODEL_REGISTRY[id];
  if (spec === undefined) {
    throw new Error(
      `未知的语义模型：${raw}（可用：${Object.keys(MODEL_ALIASES).join(' / ')}，或模型 id：${Object.keys(MODEL_REGISTRY).join(' / ')}）`,
    );
  }
  return spec;
}

export function modelDir(modelsDir: string, spec: ModelSpec = DEFAULT_MODEL): string {
  return join(modelsDir, spec.id);
}

export interface ModelStatus {
  available: boolean;
  modelId: string;
  dim: number;
  maxTokens: number;
  dir: string;
  reason: string | null;
}

function sha256Of(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 检查模型文件是否齐备且哈希一致（只读）。 */
export function inspectModel(modelsDir: string, spec: ModelSpec = DEFAULT_MODEL): ModelStatus {
  const dir = modelDir(modelsDir, spec);
  for (const asset of spec.assets) {
    const path = join(dir, asset.name);
    if (!existsSync(path)) {
      return { available: false, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: `缺少模型文件 ${asset.name}（${path}）` };
    }
    const buffer = readFileSync(path);
    if (asset.bytes > 0 && buffer.length !== asset.bytes) {
      return { available: false, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: `${asset.name} 字节数不符：期望 ${asset.bytes}，实际 ${buffer.length}` };
    }
    if (sha256Of(buffer) !== asset.sha256) {
      return { available: false, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: `${asset.name} 的 sha256 与清单不符（文件可能损坏）` };
    }
  }
  return { available: true, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: null };
}

export interface DownloadModelOptions {
  modelsDir: string;
  spec?: ModelSpec;
  fetchImpl?: typeof fetch;
  /** false 时只检查不下载（用于只读路径 / 测试）。 */
  download?: boolean;
}

/** 按需下载模型资产；已存在且哈希一致时不动网络。 */
export async function ensureModel(options: DownloadModelOptions): Promise<ModelStatus> {
  const spec = options.spec ?? DEFAULT_MODEL;
  const dir = modelDir(options.modelsDir, spec);
  const current = inspectModel(options.modelsDir, spec);
  if (current.available) return current;
  if (options.download === false) return current;

  mkdirSync(dir, { recursive: true });
  const fetchImpl = options.fetchImpl ?? fetch;
  for (const asset of spec.assets) {
    const path = join(dir, asset.name);
    if (existsSync(path)) {
      const buffer = readFileSync(path);
      if (sha256Of(buffer) === asset.sha256 && (asset.bytes === 0 || buffer.length === asset.bytes)) continue;
    }
    const response = await fetchImpl(asset.url);
    if (!response.ok) return { available: false, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: `下载 ${asset.name} 失败：HTTP ${response.status}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    const digest = sha256Of(buffer);
    if (digest !== asset.sha256) {
      return { available: false, modelId: spec.id, dim: spec.dim, maxTokens: spec.maxTokens, dir, reason: `下载 ${asset.name} 的 sha256 不匹配：期望 ${asset.sha256.slice(0, 16)}，实际 ${digest.slice(0, 16)}` };
    }
    writeFileSync(path, buffer);
  }
  return inspectModel(options.modelsDir, spec);
}

export interface Embedder {
  modelId: string;
  dim: number;
  maxTokens: number;
  tokenizer: WordPieceTokenizer;
  /** 逐条编码；返回已 L2 归一化的向量。 */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

export interface CreateEmbedderOptions extends DownloadModelOptions {
  /** 每批编码的文本条数（默认 16）。 */
  batchSize?: number;
}

interface OrtModule {
  InferenceSession: { create(path: string, options?: unknown): Promise<OrtSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: readonly number[]) => unknown;
}

interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
  release?(): Promise<void>;
}

export class EmbedderUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`本地嵌入不可用：${reason}`);
    this.name = 'EmbedderUnavailableError';
    this.reason = reason;
  }
}

/**
 * 从模型的输出里挑「序列级」张量名：优先标准名，其次第一个最后一维等于模型维度的三维张量。
 *
 * 必须按维度校验：上游有些导出其实是 MLM 头（实测 `Xenova/bert-base-multilingual-cased` 的第一个输出叫
 * `logits`、形状 `[1,seq,119547]` = 词表大小），照单全收会把 119547 维「向量」写进索引，
 * 最后只得到一条莫名其妙的 SQLite 维度报错。返回 null 表示没有可用输出（调用方给可读拒绝）。
 */
export function pickSequenceOutputName(
  outputNames: readonly string[],
  dimsOf: (name: string) => readonly number[] | null,
  dim: number,
): string | null {
  const preferred = ['last_hidden_state', 'token_embeddings', 'hidden_states', 'encoder_outputs'];
  const ordered = [...preferred.filter((name) => outputNames.includes(name)), ...outputNames];
  for (const name of ordered) {
    const dims = dimsOf(name);
    if (dims !== null && dims.length === 3 && dims[2] === dim) return name;
  }
  return null;
}

/** 建嵌入器；模型不可用或 onnxruntime 缺失时抛 `EmbedderUnavailableError`（调用方据此降级）。 */
export async function createEmbedder(options: CreateEmbedderOptions): Promise<Embedder> {
  const status = await ensureModel(options).catch((error: unknown) => ({
    available: false,
    modelId: (options.spec ?? DEFAULT_MODEL).id,
    dim: (options.spec ?? DEFAULT_MODEL).dim,
    maxTokens: (options.spec ?? DEFAULT_MODEL).maxTokens,
    dir: modelDir(options.modelsDir, options.spec ?? DEFAULT_MODEL),
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (!status.available) throw new EmbedderUnavailableError(status.reason ?? '模型不可用');

  let ort: OrtModule;
  try {
    ort = (await import('onnxruntime-node')) as unknown as OrtModule;
  } catch (error) {
    throw new EmbedderUnavailableError(`onnxruntime-node 不可用：${error instanceof Error ? error.message : String(error)}`);
  }

  const spec = options.spec ?? DEFAULT_MODEL;
  const tokenizer =
    spec.tokenizerKind === 'unigram'
      ? createUnigramTokenizer(readFileSync(join(status.dir, 'tokenizer.json'), 'utf8'), {
          maxContentTokens: status.maxTokens - 2,
        })
      : createTokenizer(readFileSync(join(status.dir, 'vocab.txt'), 'utf8'), {
          maxContentTokens: status.maxTokens - 2,
          // 词表选项按模型自身配置（cased / CJK 逐字切分）
          cased: spec.tokenizer?.cased === true,
          cjk: spec.tokenizer?.cjk !== false,
        });
  const session = await ort.InferenceSession.create(join(status.dir, 'model_quantized.onnx'), { executionProviders: ['cpu'] });
  const batchSize = options.batchSize ?? 16;

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const encoded = texts.map((text) => tokenizer.encode(text));
    const length = Math.max(...encoded.map((entry) => entry.ids.length));
    const batch = encoded.length;
    const ids = new BigInt64Array(batch * length);
    const mask = new BigInt64Array(batch * length);
    const types = new BigInt64Array(batch * length);
    encoded.forEach((entry, row) => {
      for (let column = 0; column < length; column += 1) {
        const target = row * length + column;
        const id = entry.ids[column] ?? SPECIAL_IDS.pad;
        ids[target] = BigInt(id);
        mask[target] = BigInt(entry.attentionMask[column] ?? 0);
        types[target] = BigInt(entry.tokenTypeIds[column] ?? 0);
      }
    });
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', ids, [batch, length]),
      attention_mask: new ort.Tensor('int64', mask, [batch, length]),
      token_type_ids: new ort.Tensor('int64', types, [batch, length]),
    };
    const output = await session.run(feeds);
    // 取「序列级」输出：优先标准名，其次第一个最后一维等于模型维度的三维张量。
    // 必须校验维度——上游有些导出其实是 MLM 头（实测 Xenova/bert-base-multilingual-cased 的
    // 第一个输出叫 `logits`、形状 [1,seq,119547]=词表大小），若照单全收会把 119547 维「向量」写进
    // 索引，最后变成一条莫名其妙的 SQLite 维度报错。
    const pickedName = pickSequenceOutputName(
      session.outputNames,
      (name) => output[name]?.dims ?? null,
      status.dim,
    );
    const picked = pickedName === null ? undefined : ([pickedName, output[pickedName]] as const);
    if (picked === undefined) {
      const shapes = session.outputNames
        .map((name) => `${name}=${JSON.stringify(output[name]?.dims ?? null)}`)
        .join('，');
      throw new EmbedderUnavailableError(
        `模型 ${status.modelId} 没有输出维度为 ${status.dim} 的序列级张量（实际输出：${shapes}）：该导出可能不是句子编码器（例如只导出了 MLM 头）`,
      );
    }
    const first = picked[1] as NonNullable<(typeof picked)[1]>;
    const [, sequence, hidden] = first.dims as [number, number, number];
    const vectors: Float32Array[] = [];
    for (let row = 0; row < batch; row += 1) {
      const vector = new Float32Array(hidden);
      let counted = 0;
      for (let token = 0; token < sequence; token += 1) {
        if ((encoded[row]?.attentionMask[token] ?? 0) === 0) continue;
        counted += 1;
        for (let index = 0; index < hidden; index += 1) {
          vector[index] = (vector[index] ?? 0) + (first.data[row * sequence * hidden + token * hidden + index] ?? 0);
        }
      }
      const divisor = counted === 0 ? 1 : counted;
      let norm = 0;
      for (let index = 0; index < hidden; index += 1) {
        vector[index] = (vector[index] ?? 0) / divisor;
        norm += (vector[index] ?? 0) ** 2;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let index = 0; index < hidden; index += 1) vector[index] = (vector[index] ?? 0) / norm;
      }
      vectors.push(vector);
    }
    return vectors;
  }

  return {
    modelId: status.modelId,
    dim: status.dim,
    maxTokens: status.maxTokens,
    tokenizer,
    embed: async (texts) => {
      const out: Float32Array[] = [];
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        out.push(...(await embedBatch(texts.slice(offset, offset + batchSize))));
      }
      return out;
    },
    dispose: async () => {
      await session.release?.();
    },
  };
}
