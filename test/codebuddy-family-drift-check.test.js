'use strict';

// 家族客户端漂移检测工具的回归测试。
//
// 这个工具的**全部价值**在于「真的能发现漂移」——一个永远返回 0 的检查器比没有更糟，
// 因为它会让人以为已经复核过了。所以这里逐类注入漂移，断言它确实被检出。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectHeaderPicture,
  detectDrift,
  discoverInstalledVersions
} = require('../scripts/codebuddy-family-drift-check');

function baselineFrom(current) {
  return { client: current.client, headers: current.headers };
}

test('collectHeaderPicture 取自真实头构造函数（不重抄字面量）', () => {
  const picture = collectHeaderPicture();
  // 与构造函数的输出必须逐项一致——抄一份字面量就会漂移。
  const { buildCodebuddyFamilyUpstreamHeaders } = require('../lib/account/codebuddy-family-inference');
  const live = Object.keys(buildCodebuddyFamilyUpstreamHeaders('workbuddy', null, {
    sessionKey: 'drift-probe', uid: 'drift-probe-uid', version: '2.63.2'
  })).sort();
  assert.deepEqual(picture.names, live);
  // 动态 ID 不进 constants（它们每次请求都变，进基线只会产生噪音）。
  for (const name of picture.names) {
    if (/^x-(conversation|request|root-request|b3|trace)|^(traceparent|b3|baggage)$/.test(name)) {
      assert.equal(name in picture.constants, false, `${name} 是动态头，不该进 constants`);
    }
  }
});

test('无漂移时报告为空', () => {
  const current = { client: { resolvedVersion: '2.161.4' }, headers: collectHeaderPicture() };
  const { drift, baselineMissing } = detectDrift(current, baselineFrom(current));
  assert.equal(baselineMissing, false);
  assert.deepEqual(drift, []);
});

test('检出官方 CLI 版本升级', () => {
  const current = { client: { resolvedVersion: '2.200.0' }, headers: collectHeaderPicture() };
  const base = { client: { resolvedVersion: '2.161.4' }, headers: collectHeaderPicture() };
  const { drift } = detectDrift(current, base);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'client_version');
});

test('检出缺失的必需头（官方加了新头而我们没跟上）', () => {
  const current = { client: { resolvedVersion: '2.161.4' }, headers: collectHeaderPicture() };
  const base = { ...current, headers: { ...current.headers, names: [...current.headers.names, 'x-brand-new-required'] } };
  const { drift } = detectDrift(current, base);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].kind, 'header_removed');
  assert.match(drift[0].detail, /x-brand-new-required/);
});

test('检出新增头与身份常量变化', () => {
  const current = { client: { resolvedVersion: '2.161.4' }, headers: collectHeaderPicture() };
  const base = baselineFrom(current);
  const added = { ...current, headers: { ...current.headers, names: [...current.headers.names, 'x-extra'] } };
  assert.equal(detectDrift(added, base).drift[0].kind, 'header_added');
  const changed = {
    ...current,
    headers: { ...current.headers, constants: { ...current.headers.constants, 'x-product': 'SaaS-Enterprise' } }
  };
  const result = detectDrift(changed, base).drift.find((item) => item.kind === 'constant_changed');
  assert.ok(result, '取值变化必须被检出');
  assert.match(result.detail, /SaaS-Enterprise/);
});

test('无基线时明确报告 baselineMissing，而不是假装没漂移', () => {
  const current = { client: { resolvedVersion: '2.161.4' }, headers: collectHeaderPicture() };
  const { drift, baselineMissing } = detectDrift(current, null);
  assert.equal(baselineMissing, true);
  assert.deepEqual(drift, []);
});

test('discoverInstalledVersions 只认版本号目录，且在缺目录时返回空而不抛错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-drift-'));
  try {
    const versions = path.join(tmp, '.local', 'share', 'codebuddy', 'versions');
    fs.mkdirSync(path.join(versions, '2.161.4'), { recursive: true });
    fs.mkdirSync(path.join(versions, 'not-a-version'), { recursive: true });
    const found = discoverInstalledVersions(tmp);
    assert.deepEqual(found.map((row) => row.version), ['2.161.4']);
    // 缺目录的 home：返回空数组，不抛。
    assert.deepEqual(discoverInstalledVersions(path.join(tmp, 'nope')), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
