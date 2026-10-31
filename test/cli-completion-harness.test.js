'use strict';

// TAB 补全的命令面：所有候选都来自声明表（command-tree）+ 注入的数据源，不碰真实磁盘。
//
// 守的是"位置"而不是具体名单：
//   aih <TAB>                      命令 + provider + 历史
//   aih harness <TAB>              外部 harness id（来自 harness/catalog）
//   aih harness pi --provider <TAB> 所有 provider
//   aih harness pi --provider X --account <TAB>  X 的账号 id
//   aih codex <TAB>                动作 + 账号
//   aih codex 1 <TAB>              动作（账号位之后仍然给动作）
//   aih codex 1 resume <TAB>       会话 id（带账号上下文，aih 活跃会话排在前面）

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCompletion } = require('../lib/cli/complete/resolve');
const { listProviderNames } = require('../lib/cli/complete/command-tree');
const { parseHarnessArgs, formatHarnessList, runHarnessCommand } = require('../lib/cli/commands/harness/router');

const ACCOUNTS = {
  codex: [
    { cliAccountId: '1', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa' },
    { cliAccountId: '2', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb' }
  ],
  codebuddycn: [{ cliAccountId: '1', accountRef: 'acct_cccccccccccccccccccc' }]
};

function context(overrides = {}) {
  return {
    historyEntries: [],
    listAccounts: (provider) => ACCOUNTS[provider] || [],
    listSessions: (provider, accountRef) => ([
      { id: 'aaaa-1111', title: '正在跑的会话', updatedAt: '1793440000000', live: Boolean(accountRef) },
      { id: 'bbbb-2222', title: '历史会话', updatedAt: '1793430000000' }
    ]).map((session) => (provider === 'codex' ? session : null)).filter(Boolean),
    ...overrides
  };
}

function values(items) {
  return items.map((item) => item.value);
}

test('aih harness <TAB>：只给注册表里的外部 harness', () => {
  assert.deepEqual(values(resolveCompletion(['harness', ''], context())), ['pi', 'dsh', 'dsh-tui', '--provider', '--account', '--model', '--json', '--list', '--help']);
});

test('aih harness pi --provider <TAB>：给所有 provider', () => {
  const items = values(resolveCompletion(['harness', 'pi', '--provider', ''], context()));
  assert.deepEqual(items.sort(), [...listProviderNames()].sort());
});

test('aih harness pi --provider codex --account <TAB>：只给该 provider 的账号', () => {
  assert.deepEqual(
    values(resolveCompletion(['harness', 'pi', '--provider', 'codex', '--account', ''], context())),
    ['1', '2']
  );
});

test('aih codex <TAB>：动作 + 账号都在', () => {
  const items = values(resolveCompletion(['codex', ''], context()));
  assert.ok(items.includes('resume'));
  assert.ok(items.includes('sessions'));
  assert.ok(items.includes('1'));
  assert.ok(items.includes('2'));
});

test('aih codex 1 <TAB>：账号位之后仍然给动作', () => {
  const items = values(resolveCompletion(['codex', '1', ''], context()));
  assert.ok(items.includes('resume'), items.join(','));
  assert.ok(items.includes('fork'));
  assert.ok(items.includes('delete'));
});

test('aih codex 1 resume <TAB>：会话 id，且带账号上下文（活跃会话优先）', () => {
  const items = resolveCompletion(['codex', '1', 'resume', ''], context());
  assert.deepEqual(values(items), ['aaaa-1111', 'bbbb-2222']);
  assert.match(items[0].description, /活跃/);
  assert.doesNotMatch(items[1].description, /活跃/);
});

test('-- 之后不给候选（原生参数交给 shell）', () => {
  assert.deepEqual(resolveCompletion(['codex', '--', 'resume', ''], context()), []);
});

test('aih harness 参数解析：值与 -- 之后的原生参数分开', () => {
  const parsed = parseHarnessArgs(['pi', '--provider', 'Codex', '--account', '2', '--model=x', '--json', '--', '--verbose', 'hi']);
  assert.equal(parsed.harnessId, 'pi');
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.account, '2');
  assert.equal(parsed.model, 'x');
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed.nativeArgs, ['--verbose', 'hi']);
});

test('aih harness：未知 harness / 缺 provider 时明确报错', async () => {
  const errors = [];
  const codeUnknown = await runHarnessCommand(['nope', '--provider', 'codex'], {
    fs: require('node:fs'),
    aiHomeDir: '/tmp/aih-none',
    hostHomeDir: '/tmp',
    env: {},
    stdout: { write() {} },
    stderr: { write: (text) => errors.push(String(text)) }
  });
  assert.equal(codeUnknown, 1);
  assert.match(errors.join(''), /未知 harness/);

  errors.length = 0;
  const codeNoProvider = await runHarnessCommand(['pi'], {
    fs: require('node:fs'),
    aiHomeDir: '/tmp/aih-none',
    hostHomeDir: '/tmp',
    env: {},
    stdout: { write() {} },
    stderr: { write: (text) => errors.push(String(text)) }
  });
  assert.equal(codeNoProvider, 1);
  assert.match(errors.join(''), /--provider/);
});

test('aih harness 列表包含注册表里的每个 id 与用法提示', () => {
  const text = formatHarnessList([
    { id: 'pi', label: 'Pi', description: '轻量' },
    { id: 'dsh', label: 'DSH' }
  ]);
  assert.match(text, /pi/);
  assert.match(text, /dsh/);
  assert.match(text, /aih harness <id> --provider/);
});

test('aih server config set --relay-udp <TAB>：枚举取值来自描述符表', () => {
  const items = values(resolveCompletion(['server', 'config', 'set', '--relay-udp', ''], context()));
  assert.deepEqual(items, ['default', 'on', 'off']);
});

test('aih claim <provider> --account <TAB>：没有 --provider 也能就近认出 provider', () => {
  assert.deepEqual(
    values(resolveCompletion(['claim', 'codebuddycn', '--account', ''], context())).filter((value) => value === '1'),
    ['1']
  );
});

test('会话候选支持按标题片段命中（id 记不住也能找到）', () => {
  const items = resolveCompletion(['codex', 'resume', '跑'], context());
  assert.deepEqual(values(items), ['aaaa-1111']);
});

test('aih harness --account codex:2 简写等价于 --provider codex --account 2', () => {
  const parsed = parseHarnessArgs(['pi', '--account', 'codex:2']);
  assert.equal(parsed.provider, 'codex');
  assert.equal(parsed.account, '2');
});

test('aih resume <TAB>：直接给最近会话，注释里一定有标题与 provider', () => {
  const ctx = context({
    listResumeSessions: () => ([
      { id: '01a1-abc', title: '部署脚本排查', provider: 'codex', updatedAt: 1793440000000 },
      { id: '01a1-def', title: '', provider: 'claude', updatedAt: 1793430000000 }
    ])
  });
  const items = resolveCompletion(['resume', ''], ctx);
  assert.deepEqual(values(items), ['01a1-abc', '01a1-def']);
  assert.match(items[0].description, /部署脚本排查/);
  assert.match(items[0].description, /codex/);
  assert.match(items[1].description, /无标题/);
});

test('aih export <TAB>：不抢 shell 的文件补全', () => {
  assert.deepEqual(resolveCompletion(['export', ''], context()), []);
  assert.deepEqual(resolveCompletion(['import', ''], context()), []);
});

test('aih edge apply <TAB>：给引擎名（frp / nginx / caddy）', () => {
  const items = values(resolveCompletion(['edge', 'apply', ''], context()));
  assert.ok(items.includes('frp'));
  assert.ok(items.includes('nginx'));
  assert.ok(items.includes('caddy'));
});

test('会话说明：标题始终存在（没有标题也要有占位与时间）', () => {
  const ctx = context({
    listSessions: () => [{ id: 'aaaa-1111', title: '', updatedAt: '1793440000000' }]
  });
  const [item] = resolveCompletion(['codex', 'resume', ''], ctx);
  assert.match(item.description, /无标题/);
  assert.match(item.description, /\d{4}-\d{2}-\d{2}/);
});

test('aih ss <TAB>：pane 名候选，注释带项目描述与运行状态', () => {
  const ctx = context({
    listPersistentSessions: () => ([
      { name: 'p-ai_home-1-ab', description: '✳ 本地合并取代 AWS', live: true, here: true },
      { name: 'p-other-2-cd', description: '列出上游接口', live: true, here: false }
    ])
  });
  const items = resolveCompletion(['ss', ''], ctx);
  assert.deepEqual(values(items).slice(0, 2), ['p-ai_home-1-ab', 'p-other-2-cd']);
  assert.match(items[0].description, /当前目录/);
  assert.match(items[0].description, /本地合并取代 AWS/);
  assert.match(items[0].description, /运行中/);
  // 子命令旗标仍然在
  assert.ok(values(items).includes('--list'));
});

test('aih ss <名字>：解析成 target，不再当成非法参数', () => {
  const { parseGlobalSessionsArgs } = require('../lib/cli/services/ai-cli/persistent-session-list');
  const parsed = parseGlobalSessionsArgs(['p-ai_home-1-ab']);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.target, 'p-ai_home-1-ab');
  assert.deepEqual(parseGlobalSessionsArgs(['--list']), { ok: true, help: false, detail: true });
});
