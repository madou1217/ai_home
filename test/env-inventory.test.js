'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'architecture', 'env-flags.md');
const SNAPSHOT = path.join(ROOT, 'docs', 'architecture', 'env-flags.snapshot.json');
const INTERNAL_DOC = path.join(ROOT, 'docs', 'architecture', 'env-flags.internal.md');
const CATALOG_DOC = path.join(ROOT, 'docs', 'architecture', 'env-flags.catalog.md');
const { ENV_MEANINGS } = require('../lib/config/env-catalog');
const { PUBLIC_ENV_VARS, PUBLIC_ENV_LIMIT } = require('../lib/config/public-env');

function readSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

function collectNow() {
  // 直接复用采集器的纯函数，避免 spawn 输出被 pipe 缓冲截断。
  return require('../scripts/collect-env-flags').collect();
}

test('环境变量清单存在且可解析（npm run env:inventory -- --write）', () => {
  assert.ok(fs.existsSync(DOC), 'docs/architecture/env-flags.md 必须存在');
  assert.ok(fs.existsSync(INTERNAL_DOC), 'docs/architecture/env-flags.internal.md 必须存在');
  assert.ok(fs.existsSync(SNAPSHOT), 'docs/architecture/env-flags.snapshot.json 必须存在');
  const snapshot = readSnapshot();
  assert.ok(snapshot.generatedAt);
  assert.ok(Array.isArray(snapshot.entries) && snapshot.entries.length > 0);
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /公开变量/);
});

test('公开环境变量白名单不超过 10 个，且每个都在源码里真实存在', () => {
  assert.ok(PUBLIC_ENV_VARS.length > 0);
  assert.ok(
    PUBLIC_ENV_VARS.length <= PUBLIC_ENV_LIMIT,
    `公开环境变量 ${PUBLIC_ENV_VARS.length} 个，超过上限 ${PUBLIC_ENV_LIMIT}；新增前先回答能不能进 server config / WebUI`
  );
  const names = PUBLIC_ENV_VARS.map((item) => item.name);
  assert.equal(new Set(names).size, names.length, '公开变量不能重名');
  for (const item of PUBLIC_ENV_VARS) {
    assert.match(String(item.summary || ''), /\S/, `${item.name} 缺少用途说明`);
    assert.ok(item.default !== undefined, `${item.name} 缺少默认值`);
    assert.match(String(item.configEquivalent || ''), /\S/, `${item.name} 必须写明等价 config 入口或说明为什么没有`);
  }
  const known = new Set(collectNow().entries.map((entry) => entry.name));
  const missing = names.filter((name) => !known.has(name));
  assert.deepEqual(missing, [], `公开变量在源码里不存在（白名单写错或变量已删除）：${missing.join(', ')}`);
});

test('环境准入文档只出现公开变量（内部变量单独一份，不对外承诺）', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const allowed = new Set(PUBLIC_ENV_VARS.map((item) => item.name));
  const tokens = new Set((doc.match(/AIH_[A-Z0-9_]+/g) || []));
  const leaked = [...tokens].filter((name) => !allowed.has(name));
  assert.deepEqual(leaked, [], `公开文档里出现了非公开变量：${leaked.join(', ')}`);
  for (const item of PUBLIC_ENV_VARS) {
    assert.ok(doc.includes(item.name), `公开文档缺少 ${item.name}`);
  }
});

test('内部变量清单覆盖全部非公开变量（明细可以很长，但必须完整）', () => {
  const snapshot = readSnapshot();
  const internalDoc = fs.readFileSync(INTERNAL_DOC, 'utf8');
  const publicNames = new Set(PUBLIC_ENV_VARS.map((item) => item.name));
  const internal = snapshot.entries.map((entry) => entry.name).filter((name) => !publicNames.has(name));
  assert.ok(internal.length > 0);
  const missing = internal.filter((name) => !internalDoc.includes(`\`${name}\``));
  assert.deepEqual(missing, [], `内部清单漏了：${missing.slice(0, 10).join(', ')}`);
});

test('快照登记的公开集合与白名单一致', () => {
  const snapshot = readSnapshot();
  assert.equal(snapshot.publicEnvLimit, PUBLIC_ENV_LIMIT);
  assert.deepEqual(snapshot.public, PUBLIC_ENV_VARS.map((item) => item.name));
});

test('新增环境变量必须登记：代码里出现的 AIH_* 不能在快照里缺席', () => {
  const snapshot = readSnapshot();
  const registered = new Set(snapshot.entries.map((entry) => entry.name));
  const now = collectNow();
  const missing = now.entries.map((entry) => entry.name).filter((name) => !registered.has(name));
  assert.deepEqual(
    missing,
    [],
    `检测到未登记的环境变量：${missing.join(', ')}\n新增环境变量后请重跑 npm run env:inventory -- --write 并在文档里写明用途（一个语义只用一个名字）。`
  );
  // 反向：快照里的变量如果代码里已经彻底没有了，也该重跑采集把它删掉（防文档烂掉）。
  const current = new Set(now.entries.map((entry) => entry.name));
  const stale = snapshot.entries.map((entry) => entry.name).filter((name) => !current.has(name));
  assert.deepEqual(stale, [], `这些变量在代码里已不存在，请重跑 npm run env:inventory -- --write：${stale.join(', ')}`);
});

test('成对开关（ENABLE/DISABLE）必须显式登记理由，否则视为反模式', () => {
  const snapshot = readSnapshot();
  const names = new Set(snapshot.entries.map((entry) => entry.name));
  const pairs = snapshot.entries
    .filter((entry) => /ENABLE/.test(entry.name) && names.has(entry.name.replace('ENABLE', 'DISABLE')))
    .map((entry) => ({ enable: entry.name, disable: entry.name.replace('ENABLE', 'DISABLE') }));
  // 目前只有 codex 远程代理这一对是历史兼容，已在脚本文档里登记；新增必须同时改文档说明。
  const allowed = new Set();
  const unexpected = pairs.filter((pair) => !allowed.has(pair.enable));
  assert.deepEqual(
    unexpected,
    [],
    `一个语义不要用两个变量：把 ${unexpected.map((pair) => `${pair.enable}/${pair.disable}`).join('、')} 合并成一个开关，或登记进 scripts/collect-env-flags.js 的 ALLOWED_FLAG_PAIRS。`
  );
});

test('开关类变量必须逐个出现在（公开或内部）文档里（不能只活在代码里）', () => {
  const snapshot = readSnapshot();
  const docs = fs.readFileSync(DOC, 'utf8') + fs.readFileSync(INTERNAL_DOC, 'utf8');
  const flags = snapshot.entries.filter((entry) => entry.category === 'flag');
  assert.ok(flags.length > 0);
  for (const entry of flags) {
    assert.ok(docs.includes(`\`${entry.name}\``), `开关 ${entry.name} 必须出现在环境变量文档里`);
  }
});

test('AIH 数据根目录只有一处解析（同义别名不许再各写一遍）', () => {
  const helper = fs.readFileSync(path.join(ROOT, 'lib', 'runtime', 'aih-home.js'), 'utf8');
  assert.match(helper, /env\.AIH_HOME_DIR \|\| env\.AI_HOME/);
  // 手写这条别名链的模块只允许 helper 自己 + 生成的 bootstrap 模板。
  const offenders = [];
  for (const dir of ['lib', 'bin', 'scripts']) {
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
        const relative = path.relative(ROOT, full).split(path.sep).join('/');
        if (relative === 'lib/runtime/aih-home.js') continue;
        if (relative === 'lib/cli/services/node/bootstrap-assets.js') continue; // 远端自举脚本不能 require 本地模块
        const source = fs.readFileSync(full, 'utf8');
        if (/AIH_HOME_DIR\s*\|\|\s*[^\n]*\bAI_HOME\b/.test(source)) offenders.push(relative);
      }
    };
    walk(path.join(ROOT, dir));
  }
  assert.deepEqual(offenders, [], `这些文件又手写了 AIH_HOME_DIR 别名链，请改用 lib/runtime/aih-home.js：${offenders.join(', ')}`);
});

test('每个 AIH_* 都有中文含义（目录与扫描双向一致）', () => {
  const names = collectNow().entries.map((entry) => entry.name);
  const missing = names.filter((name) => !String(ENV_MEANINGS[name] || '').trim());
  assert.deepEqual(missing, [], `这些变量缺含义，请在 lib/config/env-catalog.js 补一行：${missing.join(', ')}`);
  const extra = Object.keys(ENV_MEANINGS).filter((name) => !names.includes(name));
  assert.deepEqual(extra, [], `目录里有代码中已不存在的变量，请删除：${extra.join(', ')}`);
});

test('目录文档覆盖全部变量且含义与 catalog 一致', () => {
  const doc = fs.readFileSync(CATALOG_DOC, 'utf8');
  const missing = [];
  for (const [name, meaning] of Object.entries(ENV_MEANINGS)) {
    if (!doc.includes(`\`${name}\``) || !doc.includes(meaning)) missing.push(name);
  }
  assert.deepEqual(missing, [], `docs/architecture/env-flags.catalog.md 与 catalog 不一致（重跑 npm run env:inventory -- --write）：${missing.slice(0, 10).join(', ')}`);
});
