'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyManagedAihProviderSection } = require('../lib/cli/services/pty/codex-config-sync');

const SQ = String.fromCharCode(39);
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

test('applyManagedAihProviderSection 幂等：重复 auth 子表收敛为单表', () => {
  const block = [
    '[model_providers.aih_server]',
    'name = "AIH Server"',
    'wire_api = "responses"',
    '',
    '[model_providers.aih_server.auth]',
    "command = 'D:/node.exe'",
    "args = ['C:/probe.js']"
  ].join(NL);
  const header = '[model_providers.aih_server]';
  // 模拟历史 bug 现场：两个 auth 子表并存（每次 set-default 追加一个）
  const base = [
    header,
    'name = "AIH Server"',
    '[model_providers.aih_server.auth]',
    "command = 'd:/old.exe'",
    '[model_providers.aih_server.auth]',
    "command = 'D:/newer.exe'"
  ].join(NL);
  const count = (t) => (t.match(new RegExp(`^${BS}[model_providers${BS}.aih_server${BS}.auth${BS}]`, 'gm')) || []).length;
  assert.equal(count(base), 2);
  const once = applyManagedAihProviderSection(base, header, block);
  assert.equal(count(once), 1, '重复 auth 子表应收敛为一个');
  const twice = applyManagedAihProviderSection(once, header, block);
  assert.equal(count(twice), 1, '重复执行必须幂等');
  assert.ok(twice.includes('D:/node.exe'));
  assert.equal(twice.includes('old.exe'), false);
});
