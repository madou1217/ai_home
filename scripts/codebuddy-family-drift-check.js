#!/usr/bin/env node
'use strict';

/**
 * 家族客户端（CodeBuddy / WorkBuddy）**升级漂移检测**。
 *
 * 解决什么问题：我们的 relay 是「复刻官方客户端请求」实现的，复刻依据是某次抓包。
 * 官方客户端升级后可能改头集、加签名、换端点——如果悄悄变了而我们没发现，请求会被
 * 上游按「非官方客户端」拦下（2026-10-21 的 code 11128 事故就是这样来的），或者更糟：
 * 被风控标记。这个工具让「客户端变了」这件事在**发请求之前**就可见。
 *
 * 做三件事：
 *   1. 读本机官方 CLI 的版本与安装信息（不联网、不改配置）；
 *   2. 把「我们复刻的请求画像」与「上次记录的官方画像」逐项对比，输出差异；
 *   3. 版本变了或画像对不上时以非零码退出，可直接进 CI / 定期巡检。
 *
 * 用法：
 *   node scripts/codebuddy-family-drift-check.js            # 检查并打印结论
 *   node scripts/codebuddy-family-drift-check.js --json     # 机器可读
 *   node scripts/codebuddy-family-drift-check.js --record   # 把当前探测结果写成新基线
 *
 * 不联网：只读本机安装目录与仓库内的常量。真实头集对比需要抓包（见 docs 第八节），
 * 那个动作需要真发请求，因此刻意不放进这个工具——它只做「本地可见的漂移」。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(ROOT, 'docs', 'providers', 'codebuddy-family-client-baseline.json');

const {
  CODEBUDDY_FAMILY_CLI_VERSION,
  resolveCodebuddyFamilyCliVersion,
  resolveCodebuddyFamilyUserId,
  buildCodebuddyFamilyUpstreamHeaders
} = require('../lib/account/codebuddy-family-inference');

/** 官方 CLI 的安装数据根（与 provider-storage-policy 的口径一致）。 */
function cliInstallRoots(home) {
  return [
    path.join(home, '.local', 'share', 'codebuddy', 'versions'),
    path.join(home, '.codebuddy-cn', 'versions')
  ];
}

/** 读本机装了哪些版本的官方 CLI。 */
function discoverInstalledVersions(home = os.homedir()) {
  const found = [];
  for (const root of cliInstallRoots(home)) {
    try {
      for (const name of fs.readdirSync(root)) {
        if (/^\d+\.\d+\.\d+/.test(name)) found.push({ version: name, root });
      }
    } catch (_error) { /* 该数据根不存在：跳过。 */ }
  }
  return found.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
}

/**
 * 采集「当前请求画像」：我们实际会发给上游的头名集合与关键取值。
 * 用真实的头构造函数取，不在这里重抄一份字面量——抄一份就会漂移。
 */
function collectHeaderPicture() {
  const headers = buildCodebuddyFamilyUpstreamHeaders('workbuddy', null, {
    sessionKey: 'drift-probe',
    uid: 'drift-probe-uid',
    version: CODEBUDDY_FAMILY_CLI_VERSION
  });
  const names = Object.keys(headers).sort();
  return {
    count: names.length,
    names,
    // 取固定值的头：这些是「身份画像」的常量部分，变了就是官方改了协议。
    constants: Object.fromEntries(
      names
        .filter((name) => !/^x-(conversation|request|root-request|b3|trace)|^(traceparent|b3|baggage)$/.test(name))
        .map((name) => [name, headers[name]])
    )
  };
}

function readBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function writeBaseline(record) {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * 对比当前状态与基线，给出漂移项。
 *
 * 三类漂移分别有不同的处置代价：
 *   - `client_version`：本机官方 CLI 升级了。不一定有问题，但**必须复核**——我们发的是
 *     旧版本号，上游可能按版本做兼容/风控判断。
 *   - `header_added` / `header_removed`：请求画像变了。新增头是我们主动加的（要确认是否有意），
 *     缺失头是**危险信号**（官方可能加了新的必需头，而我们没跟上 → 会重演 11128）。
 *   - `constant_changed`：某个身份头的固定值变了（如 X-Product 从 SaaS 改成别的）。
 */
function detectDrift(current, baseline) {
  const drift = [];
  if (!baseline) return { drift, baselineMissing: true };

  const recordedVersion = String(baseline.client?.resolvedVersion || '');
  const currentVersion = String(current.client?.resolvedVersion || '');
  if (recordedVersion !== currentVersion) {
    drift.push({
      kind: 'client_version',
      detail: `官方 CLI 版本从 ${recordedVersion || '(未记录)'} 变为 ${currentVersion || '(未探测到)'}；` +
        '请复核上游是否按版本做校验（UA / X-IDE-Version 用的是探测值）。'
    });
  }

  const before = new Set(baseline.headers?.names || []);
  const after = new Set(current.headers?.names || []);
  for (const name of after) {
    if (!before.has(name)) drift.push({ kind: 'header_added', detail: `新增请求头 ${name}（确认是否有意为之）` });
  }
  for (const name of before) {
    if (!after.has(name)) drift.push({ kind: 'header_removed', detail: `**缺失**请求头 ${name}（可能是官方新增的必需头，需抓包复核）` });
  }

  const beforeConst = baseline.headers?.constants || {};
  const afterConst = current.headers?.constants || {};
  for (const [name, value] of Object.entries(afterConst)) {
    if (name in beforeConst && beforeConst[name] !== value) {
      drift.push({ kind: 'constant_changed', detail: `${name} 的取值从 ${JSON.stringify(beforeConst[name])} 变为 ${JSON.stringify(value)}` });
    }
  }
  return { drift, baselineMissing: false };
}

function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const record = argv.includes('--record');
  const home = os.homedir();

  const installed = discoverInstalledVersions(home);
  const resolvedVersion = resolveCodebuddyFamilyCliVersion();
  const current = {
    checkedAt: new Date().toISOString(),
    client: {
      installedVersions: installed.map((row) => row.version),
      resolvedVersion,
      // 探测不到时用的是常量兜底——这一点必须可见，否则会误以为「版本很新」。
      usedFallbackVersion: resolvedVersion === CODEBUDDY_FAMILY_CLI_VERSION
        && !installed.some((row) => row.version === CODEBUDDY_FAMILY_CLI_VERSION)
    },
    headers: collectHeaderPicture()
  };

  if (record) {
    writeBaseline(current);
    console.log(`[aih] 已记录家族客户端基线: ${path.relative(ROOT, BASELINE_PATH)}`);
    console.log(`      官方 CLI 版本: ${resolvedVersion}（本机装了 ${installed.length} 个版本）`);
    console.log(`      请求画像头数: ${current.headers.count}`);
    return 0;
  }

  const { drift, baselineMissing } = detectDrift(current, readBaseline());
  if (asJson) {
    console.log(JSON.stringify({ ...current, drift, baselineMissing }, null, 2));
    return drift.length ? 1 : 0;
  }

  console.log(`[aih] 家族客户端漂移检查`);
  console.log(`  官方 CLI 版本: ${resolvedVersion}${current.client.usedFallbackVersion ? '（⚠️ 探测失败，用的是常量兜底）' : ''}`);
  console.log(`  本机已装版本: ${installed.map((row) => row.version).join(', ') || '(未发现)'}`);
  console.log(`  请求画像头数: ${current.headers.count}`);

  if (baselineMissing) {
    console.log('\n⚠️ 尚无基线。先跑一次 --record 建立基线，之后每次升级 CLI 都重跑本工具对比。');
    return 0;
  }
  if (!drift.length) {
    console.log('\n✅ 无漂移：客户端版本与请求画像都与基线一致。');
    return 0;
  }
  console.log(`\n⚠️ 检出 ${drift.length} 项漂移，**先复核再发请求**：`);
  for (const item of drift) console.log(`  - [${item.kind}] ${item.detail}`);
  console.log('\n复核步骤见 docs/architecture/codebuddy-family-channel-verification.md 第八节：');
  console.log('  用本地转发代理劫持官方 CLI 抓一次真实请求，与 lib 里的头构造逐项 diff。');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  main,
  discoverInstalledVersions,
  collectHeaderPicture,
  detectDrift,
  cliInstallRoots
};
