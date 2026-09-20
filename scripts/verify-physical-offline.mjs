#!/usr/bin/env node
/**
 * 物理断网实测（路线图成功标准 1 的最后一环）。
 *
 * **为什么需要它**：`npm run verify:offline` 是进程级禁网**替身**——它证明核心路径不需要非回环
 * 网络，但不能证明「网卡被拔掉时仍可用」。本命令把那一环变成实测。
 *
 * **断网期间独立执行**：不需要智能体在线、不需要网络、不需要 Zotero 运行。全程约 1–2 分钟
 * （契约测试是大头），每条探测与每个阶段都会**即时打印**，不会出现长时间无输出的假死观感。
 *
 *   1. 非回环可达性探测（DNS / 公网 TCP / 公网 HTTPS，各带硬超时）**必须全部失败**，否则判定
 *      「网络仍可达」并拒绝出证据（退出码 2，绝不写出或覆盖既有证据）；
 *   2. 回环上的读写闭环（读 → dry-run → 一次授权提交 → 回读 → 回滚 → 回读）必须 ok；
 *   3. 契约测试必须退出码 0；
 *   4. 结果写成机读 JSON（默认 `.audit/physical-offline.json`，`--out` 可覆盖）。
 *
 * **只读**：本脚本不执行任何网络配置变更（不禁用网卡、不改路由、不改防火墙）。怎么断网由你决定
 * ——那属于「需要用户明确同意」的动作。
 *
 * 用法：
 *   npm run verify:offline:physical                 # 断网后直接跑
 *   npm run verify:offline:physical -- --out <path> # 指定证据输出路径
 *   npm run verify:offline:physical -- --force-out  # 允许覆盖已存在的证据文件
 *
 * 退出码：0 = 全部通过；2 = 网络仍可达（拒绝出证据）；1 = 其它失败（含证据已存在且未加 --force-out）。
 */

import { isAbsolute, join, resolve } from 'node:path';

import { runPhysicalOffline } from './physical-offline-lib.mjs';

const repoRoot = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
};
const forceOut = argv.includes('--force-out');
const outArg = flagValue('out');
const outPath = outArg === null ? join(repoRoot, '.audit', 'physical-offline.json') : isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);

const describeProbe = (probe) => `   ${probe.ok ? '✖ 可达' : '✔ 不可达'}  ${probe.kind}  ${probe.target}  ${probe.detail}（${probe.durationMs} ms）`;

console.log('物理断网实测（把成功标准 1 的最后一环从推理变成实测）');
console.log(`证据输出：${outPath}`);
console.log('说明：本脚本不修改任何网络配置；怎么断网由你决定（拔网线 / 关 Wi-Fi / 禁用适配器）。');
console.log('全程约 1–2 分钟（契约测试是大头），每一行都会即时打印。');
console.log('');
console.log('① 非回环可达性探测（全部失败才算断网）：');

const result = await runPhysicalOffline({
  repoRoot,
  outPath,
  forceOut,
  logDir: join(repoRoot, '.audit'),
  onProgress: (event) => {
    if (event.phase === 'probe') {
      console.log(describeProbe(event.probe));
      return;
    }
    if (event.phase === 'step-start') {
      console.log('');
      console.log(event.step === 'loop' ? '② 回环读写闭环：运行中…（约几秒）' : '③ 契约测试：运行中…（约 1 分钟，请稍等）');
      return;
    }
    if (event.phase === 'step-end' && event.step === 'loop') {
      const loop = event.result;
      console.log(`② 回环读写闭环：${loop.summary?.ok === true ? '✔ 通过' : '✖ 未通过'}（退出码 ${loop.exitCode}，${loop.durationMs} ms）`);
      for (const step of loop.summary?.steps ?? []) console.log(`      · ${step.name}：${step.detail}`);
      return;
    }
    if (event.phase === 'step-end' && event.step === 'tests') {
      console.log(`③ 契约测试：${event.result.exitCode === 0 ? '✔ 通过' : '✖ 未通过'}（退出码 ${event.result.exitCode}，${event.result.durationMs} ms）`);
      for (const failure of event.result.failingTests ?? []) {
        console.log(`      ✖ ${failure.name}`);
        for (const detail of failure.details ?? []) console.log(`          ${detail}`);
      }
      if (event.result.exitCode !== 0 && (event.result.failingTests ?? []).length === 0) {
        for (const line of event.result.tail ?? []) console.log(`      ${line}`);
      }
      if (typeof event.result.logFile === 'string') console.log(`      完整日志：${event.result.logFile}`);
    }
  },
});

if (result.mode === 'refuse') {
  console.log('');
  console.log(`结论：✖ ${result.reason}`);
  console.log('请在真正断网（拔网线 / 关闭 Wi-Fi / 禁用网卡）后重跑本命令；既有证据文件未被改动。');
  console.log('提示：如果关了 Wi-Fi 仍显示可达，多半还有 TUN / VPN 虚拟网卡或代理在跑，把它们也退出再试。');
} else {
  console.log('');
  if (result.mode === 'refused-overwrite') {
    console.log(`✖ ${result.reason}`);
  } else {
    console.log(`证据已写入：${outPath}`);
    console.log(`结论：${result.evidence?.conclusion?.ok === true ? '✔ 物理断网下的读写闭环与契约测试全部通过' : '✖ 存在未通过项，见上（证据已如实写入）'}`);
    console.log('');
    console.log('恢复网络后请告知智能体：它会读取该文件、蒸馏成 docs/evidence/ 并更新结项报告。');
  }
}
process.exitCode = result.exitCode;
