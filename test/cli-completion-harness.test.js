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
const { listModelCandidates, buildScopedAliasCandidates } = require('../lib/cli/complete/candidates');
const { listProviderNames } = require('../lib/cli/complete/command-tree');
const { parseHarnessArgs, formatHarnessList, runHarnessCommand } = require('../lib/cli/commands/harness/router');

const ACCOUNTS = {
  codex: [
    { cliAccountId: '1', accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa' },
    { cliAccountId: '2', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb' }
  ],
  codebuddycn: [{ cliAccountId: '1', accountRef: 'acct_cccccccccccccccccccc' }],
  gemini: [{ cliAccountId: '2', accountRef: 'acct_dddddddddddddddddddd' }]
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
  assert.deepEqual(values(resolveCompletion(['harness', ''], context())), ['pi', 'dsh', 'dsh-tui', '--provider', '--account', '--model', '--model-alias', '--json', '--list', '--help']);
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

test('aih gemini 2 --model <TAB>：模型候选，且把 provider / 账号位传下去', () => {
  const calls = [];
  const items = resolveCompletion(['gemini', '2', '--model', ''], context({
    listModels: (options) => {
      calls.push(options);
      return [{ value: 'gemini-3-pro', description: '本账号模型' }];
    }
  }));
  assert.deepEqual(values(items), ['gemini-3-pro']);
  assert.equal(items[0].group, '模型');
  assert.deepEqual(calls, [{ provider: 'gemini', accountRef: 'acct_dddddddddddddddddddd', accountToken: '2', mode: 'model', current: '' }]);
});

test('aih harness pi --provider codex --account 2 --model-alias <TAB>：走别名模式', () => {
  const calls = [];
  resolveCompletion(['harness', 'pi', '--provider', 'codex', '--account', '2', '--model-alias', ''], context({
    listModels: (options) => {
      calls.push(options);
      return [{ value: 'fast', description: '别名 → gpt-5' }];
    }
  }));
  assert.deepEqual(calls, [{ provider: 'codex', accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', accountToken: '2', mode: 'alias', current: '' }]);
});

test('模型候选按前缀过滤，不匹配的不出现', () => {
  const items = resolveCompletion(['claude', '--model', 'gpt-'], context({
    listModels: () => [
      { value: 'gpt-5', description: '' },
      { value: 'claude-opus-4-6', description: '' }
    ]
  }));
  assert.deepEqual(values(items), ['gpt-5']);
});

// ---- 模型候选的数据源：网关模型投影 → account_models → 别名 ----
// 全部走注入的 fs，不碰真实磁盘，也不发网络请求（补全必须 100ms 内出结果）。

function projectionFs(entries = {}) {
  const path = require('node:path');
  const home = '/fake-aih';
  const files = {};
  for (const [key, models] of Object.entries(entries)) {
    files[path.join(home, 'run', 'harness', 'pi', key, 'models.json')] = JSON.stringify({
      providers: { aih: { models: models.map((id) => ({ id })) } }
    });
  }
  return {
    existsSync: () => false, // 没有 aih.db / 别名库：候选只来自投影
    readFileSync: (file) => {
      if (!Object.hasOwn(files, file)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files[file];
    }
  };
}

test('模型候选：账号维度的网关投影优先于全局 pool', () => {
  const fs = projectionFs({
    acct_aaaaaaaaaaaaaaaaaaaa: ['account-model'],
    pool: ['pool-model']
  });
  const items = listModelCandidates({
    fs,
    aiHomeDir: '/fake-aih',
    provider: 'gemini',
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    mode: 'model'
  });
  assert.deepEqual(items.map((item) => item.value), ['account-model']);
  assert.match(items[0].description, /本账号/);
});

test('模型候选：投影目录也认 CLI 编号（run/harness/pi/41/），没有就退到 pool', () => {
  const byToken = listModelCandidates({
    fs: projectionFs({ 41: ['numbered-model'], pool: ['pool-model'] }),
    aiHomeDir: '/fake-aih',
    provider: 'codex',
    accountToken: '41',
    mode: 'model'
  });
  assert.deepEqual(byToken.map((item) => item.value), ['numbered-model']);

  const byPool = listModelCandidates({
    fs: projectionFs({ pool: ['pool-model'] }),
    aiHomeDir: '/fake-aih',
    provider: 'codex',
    accountToken: '99',
    mode: 'model'
  });
  assert.deepEqual(byPool.map((item) => item.value), ['pool-model']);
  assert.match(byPool[0].description, /网关池/);
});

test('模型候选：投影文件坏了就跳过，不把异常抛到 shell', () => {
  const path = require('node:path');
  const home = '/fake-aih';
  const fs = {
    existsSync: () => false,
    readFileSync: (file) => {
      if (file === path.join(home, 'run', 'harness', 'pi', 'pool', 'models.json')) return '{ not json';
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
  };
  assert.deepEqual(listModelCandidates({ fs, aiHomeDir: home, provider: 'codex', mode: 'model' }), []);
});

test('模型候选：没有 aiHomeDir / 一个文件都没有 → 空列表', () => {
  assert.deepEqual(listModelCandidates({ fs: projectionFs({}), aiHomeDir: '', provider: 'codex' }), []);
  assert.deepEqual(listModelCandidates({ fs: projectionFs({}), aiHomeDir: '/fake-aih', provider: 'codex' }), []);
});

test('模型候选：去重并截到 200 条（补全列表不能无限长）', () => {
  const many = Array.from({ length: 260 }, (_, index) => `m-${index}`);
  const items = listModelCandidates({
    fs: projectionFs({ pool: [...many, 'm-0'] }),
    aiHomeDir: '/fake-aih',
    provider: 'codex',
    mode: 'model'
  });
  assert.equal(items.length, 200);
  assert.equal(new Set(items.map((item) => item.value)).size, 200);
});

test('--model-alias 的候选：别名模式同样给得出模型（别名库为空时也不空手）', () => {
  const items = listModelCandidates({
    fs: projectionFs({ pool: ['glm-4.6'] }),
    aiHomeDir: '/fake-aih',
    provider: 'gemini',
    mode: 'alias'
  });
  assert.deepEqual(items.map((item) => item.value), ['glm-4.6']);
});

test('--model-alias 的候选：别名排在模型前面，带「别名 → 目标」说明', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { saveAliases } = require('../lib/server/model-alias-store');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-alias-cand-'));
  try {
    saveAliases(fs, home, {
      aliases: [
        { id: 'a1', alias: 'fast', target: 'glm-4.6', provider: 'all', enabled: true },
        { id: 'a2', alias: 'off', target: 'glm-5', provider: 'all', enabled: false }
      ]
    });
    const items = listModelCandidates({ aiHomeDir: home, provider: 'gemini', mode: 'alias' });
    const values = items.map((item) => item.value);
    assert.equal(values[0], 'fast', '别名要排在最前');
    assert.match(items[0].description, /别名 → glm-4\.6/);
    assert.ok(values.includes('glm-4.6'), '别名目标也要能直接选');
    assert.ok(!values.includes('off'), '停用的别名不出现');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('模型候选：account_models 在投影之后补齐，并按账号收窄', () => {
  const home = '/fake-aih';
  const rows = [
    { accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa', modelId: 'own-model' },
    { accountRef: 'acct_bbbbbbbbbbbbbbbbbbbb', modelId: 'sibling-model' }
  ];
  // 假 DatabaseSync：只实现 readAccountModelRows 用到的三个调用。
  class FakeDatabaseSync {
    exec() {}
    prepare(sql) {
      assert.match(sql, /FROM account_models/);
      return { all: () => rows };
    }
    close() {}
  }
  const fs = {
    existsSync: () => true,
    readFileSync: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
  };
  const scoped = listModelCandidates({
    fs,
    DatabaseSync: FakeDatabaseSync,
    aiHomeDir: home,
    provider: 'gemini',
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    mode: 'model'
  });
  assert.deepEqual(scoped.map((item) => item.value), ['own-model']);
  assert.match(scoped[0].description, /本账号模型/);

  // 没有 accountRef：给同 provider 的并集。
  const pool = listModelCandidates({
    fs,
    DatabaseSync: FakeDatabaseSync,
    aiHomeDir: home,
    provider: 'gemini',
    mode: 'model'
  });
  assert.deepEqual(pool.map((item) => item.value), ['own-model', 'sibling-model']);
  assert.match(pool[0].description, /同 provider 模型/);
});

test('模型候选：aih.db 读不了就返回空列表（补全不许把异常抛给 shell）', () => {
  const boomFs = {
    existsSync: () => { throw new Error('EACCES'); },
    readFileSync: () => { throw new Error('ENOENT'); }
  };
  assert.deepEqual(listModelCandidates({ fs: boomFs, aiHomeDir: '/fake-aih', provider: 'gemini', mode: 'model' }), []);

  class BrokenDb {
    exec() {}
    prepare() { throw new Error('SQLITE_ERROR'); }
    close() {}
  }
  const okFs = { existsSync: () => true, readFileSync: () => { throw new Error('ENOENT'); } };
  assert.deepEqual(
    listModelCandidates({ fs: okFs, DatabaseSync: BrokenDb, aiHomeDir: '/fake-aih', provider: 'gemini' }),
    []
  );
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
      { name: 'p-ai_home-1-ab', title: '✳ 本地合并取代 AWS', provider: 'claude', createdAt: Date.now() - 90 * 1000, live: true, here: true },
      { name: 'p-other-2-cd', title: '列出上游接口', provider: 'codex', createdAt: Date.now() - 3 * 3600 * 1000, live: true, here: false }
    ])
  });
  const items = resolveCompletion(['ss', ''], ctx);
  assert.deepEqual(values(items).slice(0, 2), ['p-ai_home-1-ab', 'p-other-2-cd']);
  assert.match(items[0].description, /当前目录/);
  assert.match(items[0].description, /本地合并取代 AWS/);
  assert.match(items[0].description, /运行中/);
  assert.match(items[0].description, /claude/);
  assert.match(items[1].description, /3 小时前/);
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

test('aih ss 前缀匹配：精确 > 唯一前缀 > 唯一描述；多义不猜', () => {
  const { matchGlobalSessionTarget } = require('../lib/cli/services/ai-cli/persistent-session-list');
  const rows = [
    { name: 'p-ai_home-aaa-1', description: '本地合并取代 AWS' },
    { name: 'p-ai_home-bbb-2', description: '近10天需求收敛' },
    { name: 'p-other-ccc-3', description: '上游接口消耗' }
  ];

  assert.equal(matchGlobalSessionTarget(rows, 'p-ai_home-aaa-1').reason, 'exact');
  assert.equal(matchGlobalSessionTarget(rows, 'p-ai_home-aaa').chosen.name, 'p-ai_home-aaa-1');
  assert.equal(matchGlobalSessionTarget(rows, 'p-ai_home').reason, 'name-prefix-ambiguous');
  assert.deepEqual(matchGlobalSessionTarget(rows, 'p-ai_home').ambiguous.map((row) => row.name), ['p-ai_home-aaa-1', 'p-ai_home-bbb-2']);
  assert.equal(matchGlobalSessionTarget(rows, '上游').chosen.name, 'p-other-ccc-3');
  assert.equal(matchGlobalSessionTarget(rows, 'nope').reason, 'not-found');
  assert.equal(matchGlobalSessionTarget(rows, '').reason, 'empty');
});

test('ss 标题缓存：写读一致，过期后失效', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cache = require('../lib/runtime/persistent-session-cache');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ss-cache-'));
  try {
    cache.write(home, [{ name: 'p-1', title: '✳ 标题', provider: 'claude', path: '/repo', live: true, created: 1 }]);
    const rows = cache.read(home);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, '✳ 标题');
    assert.equal(rows[0].live, true);

    // 手工把时间戳改旧，模拟过期
    const file = path.join(home, 'run', 'cache', 'complete', cache.CACHE_FILE);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    payload.at = Date.now() - cache.CACHE_TTL_MS - 1000;
    fs.writeFileSync(file, JSON.stringify(payload));
    assert.deepEqual(cache.read(home), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---- 带命名空间的别名目标：provider.model / provider.<账号>.model ----
//
// 模型名会被多家共持（glm-5 同时在 kiro / zcode 名下），只补裸名会落到错的 Provider。
// 候选来源是服务端探测快照（byProvider / byAccount），因为 kiro 这类 Provider 在
// Go 账号库里没有 account_models 行。

test('命名空间候选：provider.model 与 provider.<账号>.model 都带说明', () => {
  const snapshot = {
    byProvider: { kiro: ['glm-5', 'qwen3-coder-next'], codex: ['gpt-6.1-sol'] },
    byAccount: { acct_kiro_2: ['glm-5'] }
  };
  const accounts = [
    { provider: 'kiro', cliAccountId: '2', accountRef: 'acct_kiro_2' },
    // 快照没有该账号的行：退回该 Provider 的模型并集，不能让账号一条都补不出来。
    { provider: 'kiro', cliAccountId: '3', accountRef: 'acct_kiro_3' }
  ];
  const items = buildScopedAliasCandidates(snapshot, accounts);
  const values = items.map((item) => item.value);
  assert.ok(values.includes('kiro.glm-5'), values.join(','));
  assert.ok(values.includes('kiro.2.glm-5'));
  assert.ok(values.includes('kiro.3.glm-5'));
  assert.ok(values.includes('codex.gpt-6.1-sol'));
  // 每个候选都必须有说明，且说明能区分「钉 Provider」与「钉账号」。
  assert.ok(items.every((item) => String(item.description || '').trim().length > 0));
  const providerScoped = items.find((item) => item.value === 'kiro.glm-5');
  const accountScoped = items.find((item) => item.value === 'kiro.2.glm-5');
  assert.match(providerScoped.description, /钉 Provider/);
  assert.match(accountScoped.description, /账号 2/);
  assert.match(accountScoped.description, /钉 Provider \+ 账号/);
});

test('命名空间候选：没有快照 / 空账号列表时返回空，不猜', () => {
  assert.deepEqual(buildScopedAliasCandidates(null, []), []);
  assert.deepEqual(buildScopedAliasCandidates({ byProvider: {} }, [{ provider: 'kiro', cliAccountId: '1', accountRef: 'a' }]), []);
});

test('命名空间候选：前缀 kiro. / kiro.2. 能过滤到对应写法', () => {
  const models = [
    { value: 'kiro.glm-5', description: 'Kiro · glm-5｜钉 Provider' },
    { value: 'kiro.2.glm-5', description: 'Kiro 账号 2 · glm-5｜钉 Provider + 账号' },
    { value: 'gpt-6.1-sol', description: '网关池模型' }
  ];
  const context = { historyEntries: [], listModels: () => models };
  assert.deepEqual(values(resolveCompletion(['codex', '--model-alias', 'kiro.'], context)), ['kiro.glm-5', 'kiro.2.glm-5']);
  assert.deepEqual(values(resolveCompletion(['codex', '--model-alias', 'kiro.2.'], context)), ['kiro.2.glm-5']);
  assert.deepEqual(resolveCompletion(['codex', '--model-alias', 'kiro.2.'], context)[0].group, '模型');
});

test('所有补全候选都带说明（命令面 / 旗标 / 嵌套子命令）', () => {
  const context = {
    historyEntries: [],
    listAccounts: (provider) => ACCOUNTS[provider] || [],
    listSessions: () => [],
    listModels: () => [{ value: 'gpt-6.1-sol', description: '网关池模型' }]
  };
  const positions = [
    [''],
    ['codex', ''],
    ['codex', '1', ''],
    ['codex', '--model-alias', ''],
    ['harness', ''],
    ['harness', 'pi', '--provider', ''],
    ['server', ''],
    ['server', 'config', ''],
    ['server', 'config', 'set', ''],
    ['peer', 'send', '']
  ];
  for (const words of positions) {
    const items = resolveCompletion(words, context);
    const missing = items.filter((item) => !String(item.description || '').trim());
    assert.deepEqual(missing.map((item) => item.value), [], `位置 aih ${words.join(' ')} 有候选缺说明`);
  }
});

test('命名空间候选：账号编号用 CLI 编号（app-state），不是 Go 的内部编号', () => {
  const { readCliAccountRows } = require('../lib/cli/complete/candidates');
  const ref = 'acct_6cca3e9f4f4c823232c1';
  class FakeDatabaseSync {
    exec() {}
    prepare(sql) {
      assert.match(sql, /account_cli_aliases/);
      return { all: () => [{ provider: 'kiro', cliAccountId: '2', accountRef: ref }] };
    }
    close() {}
  }
  const rows = readCliAccountRows('/fake-aih', {
    fs: { existsSync: () => true },
    DatabaseSync: FakeDatabaseSync
  });
  assert.deepEqual(rows, [{ provider: 'kiro', cliAccountId: '2', accountRef: ref }]);
});

test('命名空间候选：空 TAB 不列 provider.account.model（避免几百条淹没列表）', () => {
  const { wantsScopedAliasTargets } = require('../lib/cli/complete/candidates');
  assert.equal(wantsScopedAliasTargets(''), false);
  assert.equal(wantsScopedAliasTargets('gpt'), false);
  assert.equal(wantsScopedAliasTargets('kiro'), true);
  assert.equal(wantsScopedAliasTargets('kiro.'), true);
  assert.equal(wantsScopedAliasTargets('kiro.2.'), true);
});

test('候选说明压成单行：会话标题带换行也不会拆坏补全协议', () => {
  const items = resolveCompletion(['codex', '1', 'resume', ''], context({
    listSessions: () => ([{
      id: 'aaaa-1111',
      title: '第一行\n第二行\t带制表符',
      updatedAt: '1793440000000'
    }])
  }));
  assert.equal(items.length, 1);
  assert.equal(items[0].value, 'aaaa-1111');
  assert.equal(items[0].description.includes('\n'), false);
  assert.match(items[0].description, /第一行 第二行 带制表符/);
});

// ---- aih <cli> auto-switch 的补全 ----
//
// 自动换号是 provider 动作层的成员（和 usage 平级），不是 usage 的子命令：
// 三个位置都要有候选，且不能在 usage 下面再出现一份。

test('aih <cli> auto-switch <TAB>：on / off / status 与旗标都在', () => {
  assert.deepEqual(
    values(resolveCompletion(['codebuddy', 'auto-switch', ''], context())),
    ['on', 'off', 'status', '--help', '--remaining']
  );
});

test('aih <cli> auto-switch <动作> <TAB>：只补这个动作的旗标', () => {
  assert.deepEqual(
    values(resolveCompletion(['codebuddy', 'auto-switch', 'on', ''], context())),
    ['--help', '--remaining']
  );
});

test('aih <cli> <TAB> 有 auto-switch；usage 下不再挂 auto-switch', () => {
  assert.ok(values(resolveCompletion(['codebuddy', ''], context())).includes('auto-switch'));
  assert.ok(!values(resolveCompletion(['codebuddy', 'usage', ''], context())).includes('auto-switch'));
});

// ---- aih peer 的补全 ----
//
// 收件箱式 peer 的命令面：子命令、收件人、消息 id、枚举取值都必须能补，且都带说明。
// 消息 id 在 read / reply 的位置参数与 send --reply-to 共用同一份候选。

test('aih peer <TAB>：子命令齐全且都带说明', () => {
  const items = resolveCompletion(['peer', ''], context());
  const byValue = new Map(items.map((item) => [item.value, item]));
  for (const name of ['list', 'send', 'inbox', 'read', 'reply', 'flush', 'channels']) {
    assert.ok(byValue.has(name), `缺少子命令 ${name}`);
    assert.ok(String(byValue.get(name).description || '').trim().length > 0, `${name} 缺说明`);
  }
});

test('peer read|reply 与 send --reply-to：同一份消息 id，说明含状态', () => {
  const messages = [{ value: 'pm-12345678', detail: 'pending · alice · hello', state: 'pending' }];
  const ctx = context({ listPeerMessageCandidates: () => messages });
  for (const words of [['peer', 'read', ''], ['peer', 'reply', ''], ['peer', 'send', '--reply-to', '']]) {
    const items = resolveCompletion(words, ctx);
    assert.deepEqual(values(items).slice(0, 1), ['pm-12345678'], `位置 aih ${words.join(' ')}`);
    assert.match(items[0].description, /pending · alice · hello/);
  }
});

test('peer 枚举取值：--state / --channel / --mode 都带说明', () => {
  const ctx = context();
  const states = resolveCompletion(['peer', 'inbox', '--state', ''], ctx);
  assert.ok(states.some((item) => item.value === 'failed' && /失败/.test(item.description)), values(states).join(','));
  assert.ok(states.every((item) => String(item.description || '').trim().length > 0));

  const channels = resolveCompletion(['peer', 'list', '--channel', ''], ctx);
  assert.deepEqual(values(channels), ['native', 'inject', 'webui-chat']);
  assert.ok(channels.every((item) => String(item.description || '').trim().length > 0));

  const modes = resolveCompletion(['peer', 'send', '--mode', ''], ctx);
  assert.deepEqual(values(modes), ['bypass']);
  assert.match(modes[0].description, /native/);
});
