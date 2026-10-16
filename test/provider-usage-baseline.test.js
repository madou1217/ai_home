'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listProviderIds } = require('../lib/provider-catalog');
const { buildProviderResumeVerbArgs } = require('../lib/runtime/provider-resume');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'providers', 'agent-cli-usage.md');
const SNAPSHOT = path.join(ROOT, 'docs', 'providers', 'agent-cli-usage.snapshot.json');

function readSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
}

test('用法基线文档与快照必须存在、可解析，且覆盖全部 provider', () => {
  assert.ok(fs.existsSync(DOC), 'docs/providers/agent-cli-usage.md 必须存在（npm run providers:usage -- --write）');
  const snapshot = readSnapshot();
  assert.ok(snapshot.generatedAt, '快照必须带生成时间（便于判断基线新旧）');
  assert.ok(Array.isArray(snapshot.entries) && snapshot.entries.length > 0);

  const providers = listProviderIds();
  const covered = new Set(snapshot.entries.map((entry) => entry.provider));
  for (const provider of providers) {
    assert.ok(covered.has(provider), `${provider} 未出现在用法基线里`);
  }
  for (const entry of snapshot.entries) {
    assert.ok(entry.versionCommand, `${entry.provider} 必须记录版本命令（新版对比的锚点）`);
  }
});

test('文档里每个 provider 的「统一 resume」说法必须与代码事实一致（防文档漂移）', () => {
  const snapshot = readSnapshot();
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const entry of snapshot.entries) {
    const supported = buildProviderResumeVerbArgs(entry.provider, { sessionId: 'probe' }).ok;
    const row = doc.split('\n').find((line) => line.startsWith(`| ${entry.provider} |`));
    assert.ok(row, `文档表格缺少 ${entry.provider} 行`);
    if (supported) {
      assert.match(row, /aih [a-z]+ resume <id>/, `${entry.provider} 支持统一 resume，文档必须写出来`);
    } else {
      assert.match(row, /\| — \|/, `${entry.provider} 不支持统一 resume，文档表格该格必须是 —`);
    }
    // 策略实际下发的 flag 必须写进表格行。
    for (const flag of entry.resumeFlags || []) {
      assert.ok(row.includes(flag), `${entry.provider} 的策略 flag ${flag} 必须出现在文档表格里`);
    }
    // 合同声明的全部会话入口（含未使用的 fork/list 等）必须记录在明细里 —— 升级对比要靠它。
    for (const flag of entry.contractFlags || []) {
      assert.ok(doc.includes(`\`${flag}\``), `${entry.provider} 的合同入口 ${flag} 必须出现在文档里`);
    }
  }
});
