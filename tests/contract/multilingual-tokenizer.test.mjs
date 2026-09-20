import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createUnigramTokenizer,
  parsePrecompiledCharsMap,
  parseUnigramVocab,
  viterbiTokenize,
} from '../../packages/indexer/src/tokenizer-unigram.ts';
import { createTokenizer } from '../../packages/indexer/src/tokenizer.ts';

const MODEL_DIR = join(process.cwd(), 'cache', 'models', 'paraphrase-multilingual-MiniLM-L12-v2-quantized');
const readTokenizerJson = () => readFileSync(join(MODEL_DIR, 'tokenizer.json'), 'utf8');

/**
 * 本文件的 5 个用例都需要**多语种模型自己的** `tokenizer.json`（17 MB，`cache/models/` 下，gitignored）。
 * 仓库既有惯例：模型缓存缺失时用 `skip` 而不是让 CI 变红（同 `semantic-index.test.mjs` 的 `VOCAB_READY`）。
 * 需要时用 `npm run report:index`（或任一次建索引）把它下载到本机缓存。
 */
const TOKENIZER_READY = existsSync(join(MODEL_DIR, 'tokenizer.json'));
const SKIP = TOKENIZER_READY ? false : '本机没有多语种模型的 tokenizer.json 缓存（cache/models/…，gitignored）';

/**
 * 金标准夹具：由 **HuggingFace `tokenizers`** 用同一个 `tokenizer.json` 生成
 * （`Tokenizer.from_file(...).encode(text).ids`），生成脚本见 `.audit/tmp/gold.py`，
 * 需要 `pip install tokenizers`。**期望值不来自本实现**，因此不是自证。
 */
const GOLD = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'multilingual-tokenizer-gold.json'), 'utf8'),
);
const sampleOf = (text) => {
  const hit = GOLD.samples.find((sample) => sample.text === text);
  assert.notEqual(hit, undefined, `夹具里缺少样本：${text}`);
  return hit.ids;
};

test('Q1/A1：unigram 分词器与 HuggingFace 参考逐 token 相同（中英混排、重音、全角、CJK、未登录字符）', { skip: SKIP }, () => {
  const tokenizer = createUnigramTokenizer(readTokenizerJson(), { maxContentTokens: 510 });
  assert.equal(GOLD.samples.length >= 12, true, '金标准样本数不得少于 12 组');
  // 夹具必须覆盖「未登录字符落 [UNK]」（XLM-R 的 unk_id = 3）
  assert.equal(
    GOLD.samples.some((sample) => sample.ids.includes(3)),
    true,
    '夹具里至少要有一条样本含 [UNK]（id 3）',
  );
  for (const sample of GOLD.samples) {
    if (sample.ids.includes(3)) {
      assert.deepEqual(tokenizer.encode(sample.text).ids, sample.ids, `UNK 样本不匹配：${sample.text}`);
    }
  }
  for (const sample of GOLD.samples) {
    assert.deepEqual(tokenizer.encode(sample.text).ids, sample.ids, `样本不匹配：${sample.text}`);
  }
});

test('Q1/A2：Viterbi 不是贪心最长匹配——两者切分不同，且实现给出的是 Viterbi（金标准）结果', { skip: SKIP }, () => {
  const model = parseUnigramVocab(JSON.parse(readTokenizerJson()));
  // 实测分歧样本（HF 参考复核）：Viterbi 走 `Xin|ji|ang`（ids 53190,658,1463），贪心最长匹配走 `Xin|jian|g`（53190,78958,177）
  const text = 'Xinjiang';
  const prepared = `\u2581${text}`;
  // 金标准（HF）在该文本上的内容 token（去掉 <s> / </s>）就是 Viterbi 路径
  const expected = sampleOf(text).slice(1, -1);
  assert.deepEqual(viterbiTokenize(prepared, model), expected, '实现必须给出 Viterbi 路径');
  // 贪心最长匹配：每步取词表里能匹配的最长 piece
  const greedy = [];
  for (let i = 0; i < prepared.length; ) {
    let step = 0;
    for (let length = Math.min(32, prepared.length - i); length >= 1; length -= 1) {
      const id = model.vocab.get(prepared.slice(i, i + length));
      if (id !== undefined) {
        step = length;
        greedy.push(id);
        break;
      }
    }
    i += step > 0 ? step : 1;
  }
  assert.notDeepEqual(greedy, expected, '这段文本上贪心最长匹配必须与 Viterbi 不同（否则本用例没有意义）');
});

test('Q1/A3：normalizer 是 SentencePiece Precompiled 表——cased（不去音标/不小写）+ 全角归一；空格由 Metaspace 变 ▁', { skip: SKIP }, () => {
  const raw = JSON.parse(readTokenizerJson());
  assert.equal(raw.normalizer.type, 'Precompiled');
  const charsMap = parsePrecompiledCharsMap(raw.normalizer.precompiled_charsmap);
  // cased：重音与大小写原样保留（XLM-R 不是 mBERT 的 uncased + strip_accents）
  assert.equal(charsMap.normalize('Café'), 'Café');
  assert.equal(charsMap.normalize('Ünïcödé'), 'Ünïcödé');
  assert.equal(charsMap.normalize('ABC abc'), 'ABC abc');
  // 全角 → 半角：金标准里 `Café 全角ＡＢＣ` 的末段就是 `ABC`（见夹具），故归一后必须是 ASCII
  assert.equal(charsMap.normalize('ＡＢＣ'), 'ABC');
  const tokenizer = createUnigramTokenizer(readTokenizerJson(), { maxContentTokens: 510 });
  assert.deepEqual(tokenizer.encode('Ｃａｆｅ').ids, tokenizer.encode('Cafe').ids, '全角字母必须与半角同 token');
  // Metaspace：▁ 前缀真的进了词表并被用上（夹具里 `Hello world` → ▁Hello / ▁world）
  assert.notEqual(tokenizer.vocab.get('\u2581Hello'), undefined);
  assert.notEqual(tokenizer.vocab.get('\u2581world'), undefined);
});

test('Q1/A4：与 WordPiece 分词器同形（chunk.ts 依赖的接口字段齐全、语义一致）', { skip: SKIP }, () => {
  const unigram = createUnigramTokenizer(readTokenizerJson(), { maxContentTokens: 510 });
  const wordpiece = createTokenizer('x\n[UNK]\n[CLS]\n[SEP]\n[PAD]\n', { maxContentTokens: 10 });
  for (const key of ['vocab', 'vocabSize', 'maxContentTokens', 'countTokens', 'encode']) {
    assert.equal(
      typeof unigram[key],
      typeof wordpiece[key],
      `接口字段 ${key} 必须与 WordPiece 分词器同形`,
    );
  }
  assert.equal(unigram.countTokens('Hello world'), 2);
  assert.equal(unigram.countTokens('新元古代冰川侵蚀作用'), sampleOf('新元古代冰川侵蚀作用').length - 2);
  const encoded = unigram.encode('Hello world');
  assert.deepEqual(encoded.attentionMask, [1, 1, 1, 1]);
  assert.deepEqual(encoded.tokenTypeIds, [0, 0, 0, 0]);
  assert.equal(unigram.encode('Hello world', { maxTokens: 3 }).ids.length, 3);
});

test('Q1/A5：特殊 token 来自 tokenizer.json（XLM-R 的 0/1/2/3，不是 BERT 的 0/100/101/102），且位置上限被严格遵守', { skip: SKIP }, () => {
  const raw = JSON.parse(readTokenizerJson());
  const byContent = new Map(raw.added_tokens.map((token) => [token.content, token.id]));
  assert.equal(byContent.get('<s>'), 0);
  assert.equal(byContent.get('<pad>'), 1);
  assert.equal(byContent.get('</s>'), 2);
  assert.equal(byContent.get('<unk>'), 3);
  const tokenizer = createUnigramTokenizer(readTokenizerJson(), { maxContentTokens: 510 });
  const long = tokenizer.encode('中文测试 '.repeat(400));
  assert.equal(long.ids.length, 512, 'maxContentTokens + 2 必须被严格遵守（不是 BERT 的 512 语义）');
  assert.equal(long.ids[0], 0);
  assert.equal(long.ids[long.ids.length - 1], 2);
});
