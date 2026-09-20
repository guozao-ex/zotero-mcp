/**
 * `.bib` 的 year 口径核对（供真机只读断言与契约测试共用）。
 *
 * 真实库里存在没有 `date` 的条目，Zotero 不会为它们导出 `year`；因此规则是
 * 「**条目有 date 时**其导出条目必须含 year」，而不是「每个条目都必须含 year」。
 *
 * 这里把判定逻辑做成纯函数，好处是：它既能被真机断言调用，也能被契约测试用构造数据
 * 直接驱动——包括「有 date 却缺 year」必须判失败这条守卫本身，避免它退化成永远为真的死代码
 * （change 12 的独立验收正是因为该守卫无法失败而判过失败）。
 */

/**
 * @param {{ key: string, hasDate: boolean, validation: { ok: boolean, keys: string[], issues: { problem: string }[], missingYear: string[] } }[]} entries
 *   每个条目：Zotero 条目 key、该条目是否有 `date`、以及它自己那份导出文本的校验结果。
 * @returns {{ failures: string[], undated: string[], bibKeys: string[], datedKeys: string[] }}
 */
export function auditBibYears(entries) {
  const failures = [];
  const undated = [];
  const bibKeys = [];
  const datedKeys = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { failures: ['没有任何可核对的条目'], undated, bibKeys, datedKeys };
  }
  for (const entry of entries) {
    const key = typeof entry?.key === 'string' ? entry.key : '(未知条目)';
    const validation = entry?.validation;
    if (validation === undefined || validation === null) {
      failures.push(`${key}：缺少校验结果`);
      continue;
    }
    bibKeys.push(...(Array.isArray(validation.keys) ? validation.keys : []));
    if (validation.ok !== true) {
      const problems = Array.isArray(validation.issues) ? validation.issues.map((issue) => issue.problem).join('；') : '结构校验未通过';
      failures.push(`${key}：${problems}`);
      continue;
    }
    const missingYear = Array.isArray(validation.missingYear) ? validation.missingYear : [];
    if (missingYear.length === 0) {
      if (entry.hasDate === true) datedKeys.push(key);
      continue;
    }
    if (entry.hasDate === true) {
      // 有 date 却没有 year：这才是真正的失败（Zotero 应当导出 year）
      failures.push(`${key}：有 date 却缺少 year`);
    } else {
      undated.push(key);
    }
  }
  return { failures, undated, bibKeys, datedKeys };
}

/** 人类可读的一句话结论（断言通过时显示）。 */
export function describeBibYears(result) {
  const parts = [`${result.bibKeys.length} 条，引用键 ${result.bibKeys.join(', ')}`];
  if (result.undated.length > 0) {
    parts.push(`${result.undated.length} 条没有日期因而没有 year（${result.undated.join(', ')}）`);
  }
  return parts.join('；');
}
