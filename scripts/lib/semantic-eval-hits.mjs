/**
 * 评测层的命中聚合：**段落级命中 → 条目级**（每篇只保留一个名次）。
 *
 * 为什么需要：`zotero_search(mode=semantic)` 按规格返回**段落级**命中
 * （见 docs/comet/specs/semantic-index/spec.md：返回 itemKey / text / score / charRange / pageLabel），
 * 同一附件可能有多个分块命中。而 top-N 精度与人工判定材料必须是**条目级**：
 * 否则同一篇会重复占名次，等于给它多次计分。
 *
 * 保留规则：**显式取该篇的最高分块**，不依赖输入顺序。
 * （此前评测脚本用的是「首个命中」，只在 `search.hits` 恰好降序时才等价于最高分——注释与代码不一致。）
 */
export function dedupeHitsByItem(hits) {
  const best = new Map();
  for (const hit of hits ?? []) {
    const key = hit === null || hit === undefined ? undefined : hit.itemKey;
    if (key === undefined || key === null) continue;
    const previous = best.get(key);
    if (previous === undefined || Number(hit.score) > Number(previous.score)) best.set(key, hit);
  }
  return [...best.values()];
}
