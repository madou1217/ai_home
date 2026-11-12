'use strict';

// 能力快照 → 审批模式可用性：把浏览器里实际消费的快照映射抽成纯函数，锁住
// 「切 relay 模型后 /plan/confirm 收起，切回恢复」的逻辑。浏览器目视由 scripts/chat-switch-model.js 覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const ESBUILD = path.join(REPO_ROOT, 'web', 'node_modules', '.bin', 'esbuild');

let cachedFunction = null;

function loadFunction(t) {
  if (cachedFunction) return cachedFunction;
  if (!fs.existsSync(ESBUILD)) {
    t.skip('web/node_modules 缺少 esbuild');
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-capability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const entry = path.join(dir, 'entry.ts');
  const output = path.join(dir, 'entry.cjs');
  fs.writeFileSync(entry, [
    "import { approvalAvailabilityFrom } from " + JSON.stringify(path.join(REPO_ROOT, 'web/src/features/chat-runtime/capability-availability.ts')) + ";",
    'export { approvalAvailabilityFrom };'
  ].join('\n'));
  const build = spawnSync(ESBUILD, [entry, '--bundle', '--platform=node', '--format=cjs', '--outfile=' + output, '--log-level=error'], {
    encoding: 'utf8',
    timeout: 30000
  });
  assert.equal(build.status, 0, build.stderr || 'esbuild 失败');
  cachedFunction = require(output).approvalAvailabilityFrom;
  return cachedFunction;
}

test('能力快照切换：relay 模型不支持 /plan 与 confirm，切回后恢复', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  const restricted = availabilityFrom({
    capabilities: {
      'mode.plan': { support: 'unsupported', reason: 'grok_acp_unverified_no_account' },
      'interaction.approval': { support: 'unsupported', reason: 'agy_cli_has_no_permission_channel' }
    }
  });
  assert.equal(restricted.plan, 'Grok 的审批通道待接入');
  assert.equal(restricted.confirm, 'Antigravity CLI 没有权限确认通道');

  const restored = availabilityFrom({
    capabilities: {
      'mode.plan': { support: 'supported' },
      'interaction.approval': { support: 'supported' }
    }
  });
  assert.deepEqual(restored, {});
  assert.deepEqual(availabilityFrom(null), {});
});

test('只有 /plan 不支持时只禁用 plan，confirm 保持可用', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: { 'mode.plan': { support: 'unsupported', reason: 'x' } }
  }), { plan: '当前 CLI 不支持此模式' });
});

test('只有审批通道不支持时只禁用 confirm，plan 保持可用', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: { 'interaction.approval': { support: 'unsupported', reason: 'grok_acp_unverified_no_account' } }
  }), { confirm: 'Grok 的审批通道待接入' });
});

test('ZCode Desktop 专用原因映射', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: { 'interaction.approval': { support: 'unsupported', reason: 'zcode_desktop_approval_requires_desktop' } }
  }), { confirm: 'ZCode 的逐项确认由 Desktop 处理，请在 Desktop 中确认' });
});

test('两个模式同时不支持且缺原因时都回退中文文案', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: {
      'mode.plan': { support: 'unsupported' },
      'interaction.approval': { support: 'unsupported', reason: '' }
    }
  }), { confirm: '当前 CLI 不支持此模式', plan: '当前 CLI 不支持此模式' });
});

test('null/空描述符与 bypass 不误禁用', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: {
      'mode.plan': null,
      'interaction.approval': null
    }
  }), {});
  const result = availabilityFrom({
    capabilities: { 'interaction.approval': { support: 'unsupported', reason: 'x' } }
  });
  assert.equal(Object.hasOwn(result, 'bypass'), false);
});

test('支持/降级/缺失描述符都不误禁用', (t) => {
  const availabilityFrom = loadFunction(t);
  if (!availabilityFrom) return;
  assert.deepEqual(availabilityFrom({
    capabilities: {
      'mode.plan': { support: 'supported' },
      'interaction.approval': { support: 'degraded' }
    }
  }), {});
  assert.deepEqual(availabilityFrom({ capabilities: {} }), {});
  assert.deepEqual(availabilityFrom({}), {});
});
