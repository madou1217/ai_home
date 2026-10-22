'use strict';

// GeoIP 本地库：provider 策略链（字段级合并 + 不可用自动切换）与下载器（校验 + 原子替换）。
// 全部用**替身**，不依赖「这台机器有没有 mmdb 文件」——真实文件的解析另有真机冒烟。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { test } = require('node:test');
const zlib = require('node:zlib');

const { GeoLookupChain, canContribute, mergeFields } = require('../lib/runtime/geo/chain');
const { lookupExitIp, normalizeIp, parseTraceField } = require('../lib/runtime/geo/exit-ip');
const { candidateMonths, downloadDbipCity, looksLikeMmdb } = require('../lib/runtime/geo/download');
const { resolveGeoFile, listGeoFiles } = require('../lib/runtime/geo/paths');

function provider(id, capabilities, lookup, available = () => true) {
  return { id, name: id, capabilities, available, lookup };
}

test('the chain merges fields across providers and skips ones that cannot contribute', () => {
  const asked = [];
  const chain = new GeoLookupChain({
    providers: [
      provider('city', { country: true, region: true, city: true, asn: false }, (ip) => {
        asked.push('city');
        return { country: 'US', region: 'California', city: 'San Jose' };
      }),
      provider('country', { country: true }, () => { asked.push('country'); return { country: 'US' }; }),
      provider('asn', { asn: true }, () => { asked.push('asn'); return { asn: 'AS13335', org: 'Cloudflare' }; })
    ]
  });
  const result = chain.lookup('1.1.1.1');
  assert.equal(result.ok, true);
  // 国家/省州/城市来自 city 库，ASN 来自 asn 库 —— 字段级合并。
  assert.deepEqual(
    [result.geo.country, result.geo.region, result.geo.city, result.geo.asn, result.geo.org],
    ['US', 'California', 'San Jose', 'AS13335', 'Cloudflare']
  );
  assert.deepEqual(result.providers, ['city', 'asn']);
  // country 库补不上还缺的字段（国家已有、ASN 它没有）→ 被跳过，省一次查询。
  assert.ok(!asked.includes('country'), '不该问补不上字段的库');
  assert.deepEqual(result.attempts.find((a) => a.providerId === 'country'), { providerId: 'country', error: 'not_needed' });
});

test('the chain falls through unavailable and not-found providers, and reports why', () => {
  const chain = new GeoLookupChain({
    providers: [
      provider('missing-file', { country: true }, () => ({ country: 'XX' }), () => false),
      provider('not-in-db', { country: true }, () => null),
      provider('throwing', { country: true }, () => { throw new Error('reader boom'); }),
      provider('good', { country: true, asn: true }, () => ({ country: 'JP', asn: 'AS2497' }))
    ]
  });
  const result = chain.lookup('203.0.113.9');
  assert.equal(result.ok, true);
  assert.deepEqual([result.geo.country, result.geo.asn], ['JP', 'AS2497']);
  assert.deepEqual(result.attempts.map((a) => [a.providerId, a.error]), [
    ['missing-file', 'unavailable'],
    ['not-in-db', 'not_found'],
    ['throwing', 'reader boom'],
    ['good', undefined]
  ]);
  // 全都查不到 → 明确失败，不是「返回空对象」。
  const none = new GeoLookupChain({ providers: [provider('empty', { country: true }, () => null)] });
  assert.deepEqual([none.lookup('1.2.3.4').ok, none.lookup('1.2.3.4').error], [false, 'geo_not_found']);
  assert.equal(none.lookup('').error, 'invalid_ip');
});

test('field merge never overwrites an earlier non-empty value', () => {
  const merged = mergeFields({ country: 'US' }, { country: 'CN', city: 'Beijing' });
  assert.deepEqual(merged, { country: 'US', city: 'Beijing' });
  assert.equal(canContribute(provider('country', { country: true }), { country: 'US' }), false);
  assert.equal(canContribute(provider('asn', { asn: true }), { country: 'US' }), true);
});

test('exit IP lookup only accepts real IP literals and falls through endpoints', async () => {
  assert.equal(normalizeIp('1.2.3.4'), '1.2.3.4');
  assert.equal(normalizeIp('2606:4700::1111'), '2606:4700::1111');
  assert.equal(normalizeIp('<html>oops</html>'), '');
  assert.equal(normalizeIp(''), '');
  assert.equal(parseTraceField('fl=1\nip=9.9.9.9\nh=x', 'ip'), '9.9.9.9');

  // 第一个端点返回 HTML（不是 IP）→ 切下一个；第二个（ifconfig，纯文本形状）→ 成功。
  const seen = [];
  const result = await lookupExitIp({
    fetch: async (url) => {
      seen.push(url);
      if (url.includes('ipify')) return { ok: true, text: async () => '<html>blocked</html>' };
      return { ok: true, text: async () => '5.6.7.8' };
    }
  });
  assert.deepEqual([result.ok, result.ip], [true, '5.6.7.8']);
  assert.equal(seen.length, 2);
  // 全失败 → 明确错误，且带每个端点的原因。
  const failed = await lookupExitIp({ fetch: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /ipify/);
});

test('download candidates walk back a month and the mmdb marker is required', () => {
  const months = candidateMonths(new Date(Date.UTC(2026, 0, 15)), 3);
  assert.deepEqual(months, ['2026-01', '2025-12', '2025-11']);
  // mmdb 元数据标记在文件尾部。
  const fake = Buffer.concat([Buffer.alloc(2048), Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')]);
  assert.equal(looksLikeMmdb(fake), true);
  assert.equal(looksLikeMmdb(Buffer.from('not an mmdb')), false);
});

test('the downloader verifies before replacing and never leaves a broken file behind', async (t) => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-geo-dl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = nodePath.join(dir, 'geo', 'dbip-city-lite.mmdb');

  // 1) 服务端给的不是 mmdb（例如错误页）→ 失败，且不落盘。
  const bad = await downloadDbipCity({
    aiHomeDir: dir,
    fetchImpl: async () => ({ ok: true, headers: { get: () => '100' }, body: gzipStream(Buffer.from('<html>nope</html>')) })
  });
  assert.equal(bad.ok, false);
  assert.equal(fs.existsSync(target), false, '校验不过就不该产生文件');

  // 2) 合法 mmdb → 成功落盘。
  const mmdb = Buffer.concat([Buffer.alloc(4096, 7), Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com')]);
  const progress = [];
  const good = await downloadDbipCity({
    aiHomeDir: dir,
    now: new Date(Date.UTC(2026, 9, 1)),
    fetchImpl: async () => ({ ok: true, headers: { get: () => String(mmdb.length) }, body: gzipStream(mmdb) }),
    onProgress: (event) => progress.push(event.phase)
  });
  assert.equal(good.ok, true);
  assert.equal(good.month, '2026-10');
  assert.equal(fs.readFileSync(target).length, mmdb.length);
  assert.ok(progress.includes('downloading') && progress.includes('done'));

  // 3) 下载中途失败：旧文件必须原样保留（原子替换的意义）。
  const before = fs.readFileSync(target);
  const broken = await downloadDbipCity({
    aiHomeDir: dir,
    fetchImpl: async () => ({ ok: true, headers: { get: () => '100' }, body: gzipStream(Buffer.from('garbage')) })
  });
  assert.equal(broken.ok, false);
  assert.deepEqual(fs.readFileSync(target), before, '失败的下载不该破坏已有文件');
});

test('geo file resolution prefers the managed copy and never writes to client apps', (t) => {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-geo-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fakeFs = {
    statSync: (filePath) => {
      if (filePath === nodePath.join(dir, 'geo', 'GeoLite2-Country.mmdb')) return { isFile: () => true, size: 1024 };
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  };
  const found = resolveGeoFile('country', { fs: fakeFs, aiHomeDir: dir, homeDir: '/nonexistent-home' });
  assert.deepEqual(found, { path: nodePath.join(dir, 'geo', 'GeoLite2-Country.mmdb'), source: 'managed' });
  // 没有托管文件、也没有客户端文件 → null（「有则复用，没有就不用」，绝不报错）。
  assert.equal(resolveGeoFile('city', { fs: fakeFs, aiHomeDir: dir, homeDir: '/nonexistent-home' }), null);
  assert.deepEqual(listGeoFiles({ fs: fakeFs, aiHomeDir: dir, homeDir: '/nonexistent-home' }).map((f) => f.kind), ['country']);
});

/** 把 buffer 压成 gzip 的 Web ReadableStream（模拟 fetch 的 body）。 */
function gzipStream(buffer) {
  const gzipped = zlib.gzipSync(buffer);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(gzipped));
      controller.close();
    }
  });
}
