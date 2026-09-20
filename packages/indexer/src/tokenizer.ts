/**
 * 最小 WordPiece 分词器（读模型自带 `vocab.txt`）。
 *
 * 为什么自研：M5 的验收要求「按模型真实 token 上限自适应截断，禁止硬编码字符数」，所以必须真的
 * 按模型词表数 token；而引入第三方 tokenizer 会额外带进一棵依赖树。BERT 系的 WordPiece 规则是
 * 公开且稳定的：小写化 + 去音标 + 标点切分 + 贪心最长匹配（续接词加 `##` 前缀）。
 *
 * 与 HuggingFace `BertTokenizer`（do_lower_case=true）对齐的行为：
 *   - 空白切分后，标点单独成 token（不合并到相邻词）；
 *   - **CJK 逐字成 token**：英文 BERT 词表里没有中文词，整句中文会被判成 `[UNK]`；
 *   - 控制字符与空白一律丢弃；
 *   - 无法匹配的子串退化为 `[UNK]`；
 *   - 特殊 token：`[PAD]=0`、`[UNK]=100`、`[CLS]=101`、`[SEP]=102`。
 */

export const PAD_TOKEN = '[PAD]';
export const UNK_TOKEN = '[UNK]';
export const CLS_TOKEN = '[CLS]';
export const SEP_TOKEN = '[SEP]';

/** BERT 词表里的固定 id（MiniLM 沿用该词表）。 */
export const SPECIAL_IDS = { pad: 0, unk: 100, cls: 101, sep: 102 } as const;

export interface EncodeOptions {
  /** 含特殊 token 的总长度上限；超出时按右截断保留 `[CLS]` 与结尾 `[SEP]`。 */
  maxTokens?: number;
}

export interface EncodedText {
  ids: number[];
  attentionMask: number[];
  tokenTypeIds: number[];
}

/** 词表文本（每行一个 token）→ token → id 映射。 */
export function parseVocab(vocabText: string): Map<string, number> {
  const vocab = new Map<string, number>();
  const lines = vocabText.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const token = lines[index] ?? '';
    if (token.length === 0 && index === lines.length - 1) continue; // 结尾空行
    vocab.set(token, index);
  }
  return vocab;
}

// ASCII 标点 + 常见全角/CJK 标点与破折号（HuggingFace BasicTokenizer 的 `_is_punctuation` 覆盖
// Unicode P* 类别；此前只列 ASCII，导致「AI，人工智能」这类混排多出 [UNK]）。
const PUNCTUATION = /[!-/:-@[-`{-~\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65\u2010-\u2015\u2026\u2027\u2032\u2033\u00b7]/u;
/**
 * CJK（含日文假名与韩文音节）：**每个字单独成 token**。
 *
 * 这不是可选优化：MiniLM 的词表是英文 BERT 词表，一整句中文会被贪心匹配判成 `[UNK]`，
 * 于是中文文献的向量全是同一个「未知」向量，语义检索形同虚设。HuggingFace 的 BasicTokenizer
 * 同样对 CJK 逐字切分。
 */
const CJK = /[一-鿿㐀-䶿豈-﫿぀-ヿ가-힯]/u;

export interface BasicTokenizeOptions {
  /**
   * `do_lower_case`：缺省 true（既有英文模型）。`false` 时保留大小写——中文与多语种 BertTokenizer 的
   * `tokenizer_config.json` 都是 `do_lower_case=false`。
   */
  cased?: boolean;
  /** `tokenize_chinese_chars`：缺省 true（中日韩字符逐字切分，BERT 既有语义；中文句子没有空格，不切分会让整句落 [UNK]）。 */
  cjk?: boolean;
}

/** 小写 + 去音标 + 标点切分（HuggingFace BasicTokenizer 的可移植子集，含 cased / CJK 选项）。 */
export function basicTokenize(text: string, options: BasicTokenizeOptions = {}): string[] {
  const cased = options.cased === true;
  const cjk = options.cjk !== false;
  const out: string[] = [];
  // HF 口径：uncased 做 NFD + 去音标 + 小写；cased（do_lower_case=false）**不做**去音标与小写
  const normalized = cased ? text : text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '').toLowerCase();
  let current = '';
  const flush = () => {
    if (current.length > 0) out.push(current);
    current = '';
  };
  for (const char of normalized) {
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    if (PUNCTUATION.test(char)) {
      flush();
      out.push(char);
      continue;
    }
    if (CJK.test(char)) {
      if (cjk) {
        flush();
        out.push(char);
        continue;
      }
      current += char;
      continue;
    }
    current += char;
  }
  flush();
  return out;
}

export interface WordPieceTokenizer {
  /** token → id；判断某个词是否在词表里时用得上。 */
  readonly vocab: Map<string, number>;
  readonly vocabSize: number;
  /** 不含特殊 token 的内容 token 上限（模型位置上限 − 2）。 */
  readonly maxContentTokens: number;
  /** 只数内容 token（不含 `[CLS]` / `[SEP]`）。 */
  countTokens(text: string): number;
  /** 编码成模型输入（含 `[CLS]` / `[SEP]` 与 attention mask）。 */
  encode(text: string, options?: EncodeOptions): EncodedText;
}

/** 贪心最长匹配：把单个词切成词表里的子词（续接加 `##`）。 */
function wordPiece(word: string, vocab: Map<string, number>): string[] {
  if (word.length === 0) return [];
  const pieces: string[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let matched: string | null = null;
    while (start < end) {
      const candidate = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`;
      if (vocab.has(candidate)) {
        matched = candidate;
        break;
      }
      end -= 1;
    }
    if (matched === null) return [UNK_TOKEN]; // 整词退化为 [UNK]
    pieces.push(matched);
    start = end;
  }
  return pieces;
}

/**
 * 建分词器。
 *
 * `maxContentTokens` 缺省 510（BERT 系位置上限 512 − `[CLS]` − `[SEP]`）；调用方可以从模型元数据
 * 传真实上限，但不得用「字符数 ÷ 常数」近似。
 */
export interface CreateTokenizerOptions extends BasicTokenizeOptions {
  maxContentTokens?: number;
}

export function createTokenizer(vocabText: string, options: CreateTokenizerOptions = {}): WordPieceTokenizer {
  const vocab = parseVocab(vocabText);
  if (!vocab.has(CLS_TOKEN) || !vocab.has(SEP_TOKEN)) {
    throw new Error('词表缺少 [CLS] / [SEP]，不是 BERT 系词表');
  }
  const maxContentTokens = options.maxContentTokens ?? 510;
  if (!Number.isInteger(maxContentTokens) || maxContentTokens <= 0) {
    throw new Error(`maxContentTokens 必须是正整数，收到：${String(options.maxContentTokens)}`);
  }
  const toIds = (text: string): number[] => {
    const ids: number[] = [];
    for (const word of basicTokenize(text, { cased: options.cased === true, cjk: options.cjk !== false })) {
      for (const piece of wordPiece(word, vocab)) {
        ids.push(vocab.get(piece) ?? SPECIAL_IDS.unk);
      }
    }
    return ids;
  };
  return {
    vocab,
    vocabSize: vocab.size,
    maxContentTokens,
    countTokens: (text) => toIds(text).length,
    encode: (text, encodeOptions = {}) => {
      const limit = Math.min(encodeOptions.maxTokens ?? maxContentTokens + 2, maxContentTokens + 2);
      const contentLimit = Math.max(1, limit - 2);
      const content = toIds(text).slice(0, contentLimit);
      const ids = [SPECIAL_IDS.cls, ...content, SPECIAL_IDS.sep];
      return {
        ids,
        attentionMask: ids.map(() => 1),
        tokenTypeIds: ids.map(() => 0),
      };
    },
  };
}
