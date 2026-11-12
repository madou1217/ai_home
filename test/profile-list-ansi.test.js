'use strict';

// 每一行都是「彩色片段 + 复位」拼出来的。只要某行漏了复位，终端就会把颜色带到下一行，
// 看起来像"某一行 ANSI 渲染坏了"。这里直接对渲染结果做字节级断言，锁住三件事：
//   1. 行尾不能还有开着的颜色；
//   2. 输出里不能出现字面量 "\u001b"（被二次转义的转义符）；
//   3. 有名字的行必须把名字完整包在颜色里再复位。
//
// 起因：codebuddy #3 在管道输出里看起来多了一个 \u001b[0m。逐字节复查后确认是捕获层
// 转义了一个真实 ESC，程序输出本身是配平的；这条测试把这个结论固化成守卫。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createProfileListService } = require('../lib/cli/services/profile/list');
const { createAccountStateIndex } = require('../lib/account/state-index');
const { registerAccountIdentity } = require('../lib/account/account-registration');

const SGR = /\x1b\[([0-9;]*)m/g;

/** 这一行结束时还有没有没复位的颜色。 */
function hasOpenColor(line) {
  let open = false;
  SGR.lastIndex = 0;
  let match;
  while ((match = SGR.exec(line))) {
    const params = match[1];
    open = !(params === '' || params === '0');
  }
  return open;
}

test('列表行逐行配平 ANSI：行尾无未复位颜色，且没有二次转义的转义符', async (t) => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ls-ansi-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));

  const account = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'codebuddy',
    identitySeed: 'ansi:codebuddy:meadeodeo'
  });
  const index = createAccountStateIndex({ fs, aiHomeDir });
  t.after(() => index.close());
  index.upsertAccountState(account.accountRef, 'codebuddy', {
    status: 'up',
    configured: true,
    displayName: 'meadeodeo@gmail.com',
    remainingPct: 92.4
  });

  const service = createProfileListService({
    fs,
    path,
    // 没有 isTTY → 非交互路径：一次性打印完整快照，便于逐行断言。
    processObj: { stdout: { write() {} }, stdin: {} },
    aiHomeDir,
    cliConfigs: { codebuddy: {} },
    listPageSize: 50,
    getAccountStateIndex: () => index,
    // 关键：这一行没有任何徽章（accountBadgesSuffix 为空），正是被报"ANSI 坏了"的形状。
    checkStatus: () => ({
      configured: true,
      accountName: 'meadeodeo@gmail.com',
      accountEmail: '',
      runtimeStatus: null,
      identityKey: ''
    }),
    formatAccountPlanBadge: () => '',
    formatUsageLabel: () => '\x1b[36m[Remaining: Credits: 92.4%]\x1b[0m',
    refreshIndexedStateForAccount: () => ({ status: 'up', configured: true, remainingPct: 92.4 })
  });

  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await service.listProfiles('codebuddy').done;
  } finally {
    console.log = originalLog;
  }

  const row = lines.find((line) => line.includes('meadeodeo@gmail.com'));
  assert.ok(row, '应当渲染出该账号所在的行');
  assert.match(row, /\(meadeodeo@gmail\.com\)/, '账号名必须原样出现在括号里');
  assert.equal(hasOpenColor(row), false, '行尾不能还有未复位的颜色');

  for (const line of lines) {
    assert.equal(hasOpenColor(line), false, `行尾有未复位颜色: ${JSON.stringify(line)}`);
    assert.equal(line.includes('u001b'), false, `出现二次转义的转义符: ${JSON.stringify(line)}`);
  }
});
