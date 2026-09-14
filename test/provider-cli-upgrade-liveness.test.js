'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  REQUIRED_QUIESCENT_TICKS,
  checkProviderQuiescence,
  isQuiescentEnough
} = require('../lib/server/provider-cli-upgrade/upgrade-liveness');

function makeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-upgrade-liveness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeState(home, segments, name, body) {
  const dir = path.join(home, 'run', ...segments);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

test('没有任何运行痕迹时判定为闲', (t) => {
  const home = makeHome(t);
  const result = checkProviderQuiescence('codex', { aiHomeDir: home });

  assert.equal(result.busy, false);
  assert.deepEqual(result.evidence, []);
});

test('存活的 app-server 判定为忙', (t) => {
  const home = makeHome(t);
  writeState(home, ['codex-app-server'], 'chat-acct_x.json', { pid: process.pid });
  const result = checkProviderQuiescence('codex', { aiHomeDir: home });

  assert.equal(result.busy, true);
  assert.ok(result.evidence[0].startsWith('app_server:'));
});

// 误判忙只是推迟一轮；误判闲会打断用户正在进行的对话，代价不对称。
test('已死的 app-server 不算忙', (t) => {
  const home = makeHome(t);
  writeState(home, ['codex-app-server'], 'chat-acct_dead.json', { pid: 2147483000 });
  const result = checkProviderQuiescence('codex', { aiHomeDir: home });

  assert.equal(result.busy, false);
});

test('没有 pid 的旧状态文件保守判定为忙', (t) => {
  const home = makeHome(t);
  writeState(home, ['codex-app-server'], 'chat-acct_legacy.json', { port: 1234 });

  assert.equal(checkProviderQuiescence('codex', { aiHomeDir: home }).busy, true);
});

test('PTY 常驻会话判定为忙,且只认本 provider 的', (t) => {
  const home = makeHome(t);
  writeState(home, ['persistent-sessions'], 'aih-kimi-acct_y--p-x.json', {});

  assert.equal(checkProviderQuiescence('codex', { aiHomeDir: home }).busy, false);
  const kimi = checkProviderQuiescence('kimi', { aiHomeDir: home });
  assert.equal(kimi.busy, true);
  assert.ok(kimi.evidence[0].startsWith('session:'));
});

test('provider 名缺失时保守判定为忙', () => {
  assert.equal(checkProviderQuiescence('', { aiHomeDir: '/nonexistent' }).busy, true);
});

// 用「连续观测次数」而非空闲时长：apply 周期本身十几分钟，
// 按 wall-clock 判定的话上一次观测几乎总是过期，闸门等于形同虚设。
test('连续静默次数不足时不放行', () => {
  assert.equal(isQuiescentEnough(0), false);
  assert.equal(isQuiescentEnough(REQUIRED_QUIESCENT_TICKS - 1), false);
  assert.equal(isQuiescentEnough(REQUIRED_QUIESCENT_TICKS), true);
});
