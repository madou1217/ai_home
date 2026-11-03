'use strict';

// 七家 Provider 的「登录完成」校验器（web-account-auth-oauth-tokens.js）。
//
// 这些函数决定 WebUI / CLI 登录作业在不看 PTY 输出、只查磁盘时「算不算登录成功」：
//   - 文件在 ≠ 完成：token 字段不全（例如只有 refresh_token、没有 access_token，
//     或 kimi 只有 access_token）都算没登完；
//   - 坏 JSON / 空文件一律按「未完成」处理，不能抛。
//
// 表驱动跑四类样本：缺文件、坏 JSON、字段不全、字段齐全。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hasOauthCompletionArtifacts } = require('../lib/server/web-account-auth-oauth-tokens');

function withTemp(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-oauth-validator-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// dirKey：这份凭据挂在 configDir 还是 runtimeDir 下（只有 opencode 是后者）。
const CASES = [
  {
    provider: 'codex',
    dirKey: 'configDir',
    file: ['auth.json'],
    valid: [JSON.stringify({ tokens: { access_token: 'a', refresh_token: 'r' } })],
    invalid: [
      JSON.stringify({ tokens: { access_token: 'a' } }),          // 缺 refresh
      JSON.stringify({ tokens: null }),                            // tokens 不是对象
      JSON.stringify({})                                           // 完全没 tokens
    ]
  },
  {
    provider: 'claude',
    dirKey: 'configDir',
    file: ['.credentials.json'],
    valid: [
      JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }),
      JSON.stringify({ claude_ai_oauth: { access_token: 'a' } })   // 旧拼写
    ],
    invalid: [
      JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }),
      JSON.stringify({})
    ]
  },
  {
    provider: 'gemini',
    dirKey: 'configDir',
    file: ['oauth_creds.json'],
    valid: [JSON.stringify({ access_token: 'a' })],
    invalid: [JSON.stringify({ refresh_token: 'r' }), JSON.stringify({})]
  },
  {
    provider: 'agy',
    dirKey: 'configDir',
    file: ['antigravity-oauth-token'],
    valid: [
      JSON.stringify({ token: { access_token: 'a' } }),
      JSON.stringify({ token: { refresh_token: 'r' } })
    ],
    invalid: [
      JSON.stringify({ token: { access_token: '   ' } }),          // 全空白
      JSON.stringify({ token: 'not-an-object' }),
      JSON.stringify({})
    ]
  },
  {
    provider: 'opencode',
    dirKey: 'runtimeDir',
    file: ['.local', 'share', 'opencode', 'auth.json'],
    valid: [
      JSON.stringify({ openai: { key: 'k' } }),
      JSON.stringify({ opencode: { accessToken: 'a' } }),
      JSON.stringify({ 'opencode-go': { refresh_token: 'r' } })
    ],
    invalid: [
      JSON.stringify({ openai: { key: '   ' } }),
      JSON.stringify({ openai: 'not-a-record' }),
      JSON.stringify({})
    ]
  },
  {
    provider: 'grok',
    dirKey: 'configDir',
    file: ['auth.json'],
    valid: [
      JSON.stringify({ key: 'k' }),                                // 单档形态
      JSON.stringify({ profileA: { access_token: 'a' } }),         // 多档形态
      JSON.stringify({ profileA: { refreshToken: 'r' } })
    ],
    invalid: [JSON.stringify({ profileA: { unrelated: 1 } }), JSON.stringify({})]
  },
  {
    provider: 'kimi',
    dirKey: 'configDir',
    file: ['credentials', 'kimi-code.json'],
    valid: [
      JSON.stringify({ credentials: { refresh_token: 'r' } }),
      JSON.stringify({ auth: { refreshToken: 'r' } })               // 旧快照
    ],
    // access-only 不算可用账号：刷新不了，等于登不进去。
    invalid: [JSON.stringify({ credentials: { access_token: 'a' } }), JSON.stringify({})]
  }
];

for (const item of CASES) {
  test(`${item.provider}：缺文件 / 坏 JSON / 字段不全都不算完成，字段齐全才算`, () => {
    const job = (dir) => (item.dirKey === 'runtimeDir'
      ? { provider: item.provider, runtimeDir: dir }
      : { provider: item.provider, configDir: dir });
    const write = (dir, text) => {
      const target = path.join(dir, ...item.file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };

    withTemp((root) => {
      assert.equal(hasOauthCompletionArtifacts(job(root), fs), false, '文件还没落地');
    });

    withTemp((root) => {
      write(root, '{ this is not json');
      assert.equal(hasOauthCompletionArtifacts(job(root), fs), false, '坏 JSON 不能让作业崩');
    });

    withTemp((root) => {
      write(root, '');
      assert.equal(hasOauthCompletionArtifacts(job(root), fs), false, '空文件不算完成');
    });

    for (const payload of item.invalid) {
      withTemp((root) => {
        write(root, payload);
        assert.equal(hasOauthCompletionArtifacts(job(root), fs), false, `不该算完成：${payload}`);
      });
    }

    for (const payload of item.valid) {
      withTemp((root) => {
        write(root, payload);
        assert.equal(hasOauthCompletionArtifacts(job(root), fs), true, `应算完成：${payload}`);
      });
    }
  });
}

test('opencode：读的是 runtimeDir 下的 XDG 数据目录，不是 configDir', () => {
  withTemp((root) => {
    const runtimeDir = path.join(root, 'rt');
    const configDir = path.join(root, 'cfg');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'auth.json'), JSON.stringify({ openai: { key: 'k' } }));
    // 只写在 configDir 里不算：opencode 的 auth.json 在数据目录。
    assert.equal(hasOauthCompletionArtifacts({ provider: 'opencode', runtimeDir, configDir }, fs), false);
  });
});

test('grok：多档档案只认「其中一档有可用字段」，不是看有没有别的档', () => {
  const { hasGrokOauthTokens } = require('../lib/server/web-account-auth-oauth-tokens');
  const check = (payload) => withTemp((root) => {
    fs.writeFileSync(path.join(root, 'auth.json'), payload);
    return hasGrokOauthTokens(root, fs);
  });

  // 多档：只要有一档带 token 就算登录完成（grok 按档位轮换）。
  assert.equal(check(JSON.stringify({
    profileA: { unrelated: 1 },
    profileB: { accessToken: 'a' },
    profileC: { refresh_token: 'r' }
  })), true);

  // 多档全废：空白字段 / 字符串档 / null 档，都不算。
  assert.equal(check(JSON.stringify({
    profileA: { key: '   ' },
    profileB: 'not-a-record',
    profileC: null,
    profileD: 42
  })), false);

  // 单档自描述形态优先：顶层有 access_token 就只看顶层，不把内部键当档位。
  assert.equal(check(JSON.stringify({ access_token: 'a', profileA: { unrelated: 1 } })), true);

  // 顶层 token 是空串 → 落回多档，档位里有可用字段仍然算完成。
  assert.equal(check(JSON.stringify({ access_token: '', profileA: { key: 'k' } })), true);

  // 顶层 token 是全空白 → 与空串同样处理。按「非空」判定会把这一档挡掉，
  // 真实登录写下的档位就白写了（这是线上会判成未登录的边界）。
  assert.equal(check(JSON.stringify({ access_token: '   ', profileA: { key: 'k' } })), true);
  assert.equal(check(JSON.stringify({ access_token: '\t\n ', profileC: { refresh_token: 'r' } })), true);
  assert.equal(check(JSON.stringify({ key: '  ', refresh_token: ' ', profileA: { accessToken: 'a' } })), true);

  // 顶层只剩空白、档位也全是空白 → 仍然不算完成。
  assert.equal(check(JSON.stringify({ access_token: '  ', profileA: { key: '\t' } })), false);

  // 顶层 refresh_token 也算单档自描述。
  assert.equal(check(JSON.stringify({ refresh_token: 'r' })), true);

  // 数组形态不是档案表：一律判否，不能把元素当档位。
  assert.equal(check(JSON.stringify([{ access_token: 'a' }, { key: 'k' }])), false);

  // JSON 是 null / 空对象：没有任何档位。
  assert.equal(check('null'), false);
  assert.equal(check('{}'), false);
});
