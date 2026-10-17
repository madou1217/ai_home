'use strict';

// server config 的「可设置项目录」只有一张描述符表（lib/server/server-config-schema.js）。
// 这组测试守三件事：
//   1) 表与存储默认值一一对应（加了字段没登记 / 登记了不存在的字段都会红）；
//   2) 表里写的旗标真的能被解析器落到对应 key（旗标改名/删掉会红）；
//   3) `aih server config list` 的三种输出（表格 / --one-line / --json）覆盖全部字段且不泄露 secret。

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_SERVER_CONFIG } = require('../lib/server/server-config-store');
const {
  SERVER_CONFIG_FIELDS,
  SERVER_CONFIG_GROUP_ORDER,
  getServerConfigField
} = require('../lib/server/server-config-schema');
const {
  displayWidth,
  formatValue,
  renderServerConfigList
} = require('../lib/server/server-config-list');
const { parseServerConfigArgs, runServerConfigCommand } = require('../lib/server/server-config-command');

const SAMPLE_CONFIG = {
  apiKey: 'sk-super-secret',
  managementKey: 'mk-super-secret',
  port: 9600,
  relayUdp: 'off',
  maxAttempts: 5
};

test('every stored config key has exactly one descriptor', () => {
  const keys = SERVER_CONFIG_FIELDS.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(DEFAULT_SERVER_CONFIG).sort());

  const validTypes = ['ip', 'port', 'bool', 'url', 'hosts', 'secret', 'int', 'enum', 'csv', 'duration'];
  const validApplies = ['serve-arg', 'process-env', 'runtime'];
  for (const field of SERVER_CONFIG_FIELDS) {
    assert.ok(field.summary && field.summary.length >= 8, `${field.key} 缺少 summary`);
    assert.ok(validTypes.includes(field.type), `${field.key} 的 type 无效: ${field.type}`);
    assert.ok(validApplies.includes(field.applies), `${field.key} 的 applies 无效: ${field.applies}`);
    assert.ok(Array.isArray(field.env), `${field.key} 的 env 必须是数组`);
    assert.ok(SERVER_CONFIG_GROUP_ORDER.includes(field.group), `${field.key} 的 group 未登记`);
    assert.equal(getServerConfigField(field.key), field);
    if (field.default !== undefined) {
      assert.deepEqual(field.default, DEFAULT_SERVER_CONFIG[field.key], `${field.key} 的 default 与存储不一致`);
    }
  }
});

test('descriptor flags parse into the documented key and value', () => {
  for (const field of SERVER_CONFIG_FIELDS) {
    assert.ok(Array.isArray(field.samples) && field.samples.length > 0, `${field.key} 缺少 samples`);
    for (const sample of field.samples) {
      const parsed = parseServerConfigArgs(['set', ...sample.args]);
      assert.deepEqual(
        parsed.patch,
        { [field.key]: sample.expect },
        `${field.key} 的旗标没有落到预期键值：${sample.args.join(' ')}`
      );
      assert.equal(parsed.hasPatch, true);
    }
    if (field.clearFlag) {
      assert.ok(field.clear, `${field.key} 声明了 clearFlag 却没有 clear 期望值`);
      const cleared = parseServerConfigArgs(['set', field.clearFlag]);
      assert.deepEqual(cleared.patch, { [field.key]: field.clear.expect }, `${field.key} 的清空无效`);
    }
  }
});

test('list output covers every option and masks secrets', () => {
  const text = renderServerConfigList(SAMPLE_CONFIG, { color: false, columns: 120 });
  for (const field of SERVER_CONFIG_FIELDS) {
    assert.ok(text.includes(field.key), `list 缺少 ${field.key}`);
    assert.ok(text.includes(field.flag), `list 缺少旗标 ${field.flag}`);
    assert.ok(text.includes(field.summary.slice(0, 8)), `list 缺少 ${field.key} 的说明`);
    assert.ok(text.includes(field.group), `list 缺少分组 ${field.group}`);
    if (field.clearFlag) assert.ok(text.includes(field.clearFlag), `list 缺少清空旗标 ${field.clearFlag}`);
  }
  assert.equal(text.includes('sk-super-secret'), false);
  assert.equal(text.includes('mk-super-secret'), false);
  assert.ok(text.includes('configured'));
});

test('list --json is machine readable and never carries secret values', () => {
  const raw = renderServerConfigList(SAMPLE_CONFIG, { json: true });
  const parsed = JSON.parse(raw);
  assert.equal(parsed.store, 'config:server');
  assert.equal(parsed.count, SERVER_CONFIG_FIELDS.length);
  assert.equal(parsed.fields.length, SERVER_CONFIG_FIELDS.length);
  assert.equal(raw.includes('sk-super-secret'), false);

  const apiKey = parsed.fields.find((field) => field.key === 'apiKey');
  assert.equal(apiKey.secret, true);
  assert.equal(apiKey.current, 'configured');
  assert.deepEqual(apiKey.env, ['AIH_SERVER_API_KEY', 'AIH_SERVER_CLIENT_KEY']);
  assert.equal(parsed.fields.find((field) => field.key === 'relayUdp').current, 'off');
  assert.equal(parsed.fields.find((field) => field.key === 'port').current, 9600);

  const filtered = JSON.parse(renderServerConfigList(SAMPLE_CONFIG, { json: true, filter: 'relay' }));
  assert.equal(filtered.count, 5);
  assert.ok(filtered.fields.every((field) => field.key.startsWith('relay')));
});

test('list --one-line keeps one record per option', () => {
  const lines = renderServerConfigList(SAMPLE_CONFIG, { oneLine: true, color: false })
    .split('\n')
    .filter((line) => line.includes(' | '));
  assert.equal(lines.length, SERVER_CONFIG_FIELDS.length);
  for (const line of lines) {
    const parts = line.split(' | ');
    assert.equal(parts.length, 9, `一行式字段数不对: ${line}`);
    assert.ok(parts.every((part) => part.trim().length > 0), `一行式有空字段: ${line}`);
  }
});

test('list parses aliases, filter and read-only guard', () => {
  assert.equal(parseServerConfigArgs(['list']).list, true);
  assert.equal(parseServerConfigArgs(['ls']).list, true);
  assert.equal(parseServerConfigArgs(['-l']).list, true);
  assert.equal(parseServerConfigArgs(['--list']).list, true);
  // --one-line / --verbose 只对目录有意义，单独给出时按 list 处理，不能静默忽略。
  assert.equal(parseServerConfigArgs(['--one-line']).list, true);
  assert.equal(parseServerConfigArgs(['--verbose']).list, true);
  assert.equal(parseServerConfigArgs(['list', 'relay']).filter, 'relay');
  assert.equal(parseServerConfigArgs(['list', 'relay', '--json']).json, true);
  assert.equal(parseServerConfigArgs(['list']).hasPatch, false);

  assert.throws(() => parseServerConfigArgs(['list', '--port', '1234']), /只读/);
  assert.throws(() => parseServerConfigArgs(['list', 'host', 'port']), /一个过滤/);
  assert.throws(() => parseServerConfigArgs(['--one-line', '--relay-udp', 'off']), /只读/);
});

test('runServerConfigCommand prints the catalog and exits 0', async () => {
  const deps = {
    readServerConfig: () => ({ ...DEFAULT_SERVER_CONFIG, relayUdp: 'off' })
  };
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let listCode;
  let helpCode;
  try {
    listCode = await runServerConfigCommand(['list', 'relay-udp'], deps);
    helpCode = await runServerConfigCommand(['--help'], deps);
  } finally {
    console.log = originalLog;
  }
  assert.equal(listCode, 0);
  assert.equal(helpCode, 0);
  const text = logs.join('\n');
  assert.ok(text.includes('relayUdp'));
  assert.ok(text.includes('--relay-udp on|off|default'));
  assert.ok(text.includes('aih server config list'));
});

test('display width counts CJK as two columns and wraps without splitting words', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('中文'), 4);
  assert.equal(formatValue({ secret: true }, ''), 'missing');
  assert.equal(formatValue({ secret: true }, 'sk-x'), 'configured');
  assert.equal(formatValue({ type: 'duration' }, 3600000), '3600000 (1h)');
  assert.equal(formatValue({ type: 'int', zeroMeans: '3' }, 0), '0 (=3)');
  assert.equal(formatValue({ type: 'csv' }, ['a', 'b']), 'a,b');
  assert.equal(formatValue({ type: 'csv' }, []), '-');
});

