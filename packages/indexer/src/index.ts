/**
 * `@zotero-mcp/indexer`：M5 的本地语义索引。
 *
 * 只读文库：正文来自 Zotero 的全文端点，向量与模型落本地缓存（`cache/index`、`cache/models`）。
 * 对外只有四个能力：分块、嵌入、索引（build / update / status）、段落级检索。
 */

export {
  PAD_TOKEN,
  UNK_TOKEN,
  CLS_TOKEN,
  SEP_TOKEN,
  SPECIAL_IDS,
  basicTokenize,
  parseVocab,
  createTokenizer,
} from './tokenizer.ts';
export type { EncodeOptions, EncodedText, WordPieceTokenizer } from './tokenizer.ts';
export {
  createUnigramTokenizer,
  parsePrecompiledCharsMap,
  parseUnigramVocab,
  viterbiTokenize,
} from './tokenizer-unigram.ts';
export type { CreateUnigramTokenizerOptions, PrecompiledCharsMap, UnigramVocab } from './tokenizer-unigram.ts';

export { chunkText, itemFingerprint, splitParagraphs, splitSentences } from './chunk.ts';
export type { Chunk, ChunkOptions, TextSegment } from './chunk.ts';

export {
  CHINESE_MODEL,
  MULTILINGUAL_MODEL,
  DEFAULT_MODEL,
  MODEL_REGISTRY,
  EmbedderUnavailableError,
  pickSequenceOutputName,
  resolveModelSpec,
  createEmbedder,
  ensureModel,
  inspectModel,
  modelDir,
} from './embedder.ts';
export type { CreateEmbedderOptions, DownloadModelOptions, Embedder, ModelAsset, ModelSpec, ModelStatus } from './embedder.ts';

export {
  INDEX_SCHEMA_VERSION,
  openIndexStore,
  readIndexStatus,
  resolveIndexDir,
  resolveVecExtension,
} from './store.ts';
export type { IndexMeta, IndexStatus, IndexStore, SearchHit } from './store.ts';

export {
  IndexUnavailableError,
  buildIndex,
  defaultModelsDir,
  indexStatus,
  updateIndex,
} from './indexer.ts';
export type { IndexOptions, IndexReport, IndexStatusReport, IndexTimings } from './indexer.ts';

export { DEFAULT_LIMIT, MAX_LIMIT, scoreFromDistance, semanticSearch } from './search.ts';
export type { SemanticHit, SemanticSearchOptions, SemanticSearchResult } from './search.ts';
