'use strict';

// CodeBuddy 家族「成员身份」的单一事实来源守卫。
//
// 背景：同一个事实（这个家族有哪几支）曾在仓库里同时存在 5 份定义 + 8 处内联字面量：
//   lib/runtime/codebuddy-family-layouts.js   FAMILY_PROVIDERS / normalizeFamilyProvider
//   lib/account/codebuddy-billing.js          CODEBUDDY_FAMILY_PROVIDERS
//   lib/account/codebuddy-account-status.js   FAMILY
//   lib/sessions/session-reader-codebuddy.js  CODEBUDDY_FAMILY_PROVIDERS
//   以及各调用点的 ['codebuddy','codebuddycn','workbuddy','workbuddycn'].includes(...)
// 每一份都得同步，漏一处就是「加了一支，某一层静默不认它」——用量归属、SQL 过滤、
// 会话能力判定会悄悄失准，且不会有任何报错。
//
// 现在唯一真值来源是布局模块的 FAMILY_PROVIDERS，其余全部派生。本文件守三件事：
//   ① 所有派生点（含每张 provider→X 表的键集合）解析为同一集合；
//   ② lib/ 下不得再出现「把四支列在一起」的第二份名单；
//   ③ 谓词对非家族输入必须为假——否则它退化成恒真，① 就成了空保证。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const layouts = require('../lib/runtime/codebuddy-family-layouts');
const billing = require('../lib/account/codebuddy-billing');
const accountStatus = require('../lib/account/codebuddy-account-status');
const sessionReader = require('../lib/sessions/session-reader-codebuddy');
const inference = require('../lib/account/codebuddy-family-inference');
const credentialSource = require('../lib/account/codebuddy-credential-source');

const CANONICAL = [...layouts.FAMILY_PROVIDERS].sort();

test('家族成员身份只有一个真值来源，所有派生点与它一致', () => {
  const derived = [
    ['layouts.normalizeFamilyProvider', CANONICAL.filter((p) => layouts.normalizeFamilyProvider(p) === p)],
    ['layouts 家族谓词', CANONICAL.filter((p) => layouts.isCodebuddyFamilyProvider(p))],
    ['billing.CODEBUDDY_FAMILY_PROVIDERS', [...billing.CODEBUDDY_FAMILY_PROVIDERS].sort()],
    ['billing 家族谓词', CANONICAL.filter((p) => billing.isCodebuddyFamilyProvider(p))],
    ['account-status 家族谓词', CANONICAL.filter((p) => accountStatus.isCodebuddyFamilyProvider(p))],
    ['session-reader.CODEBUDDY_FAMILY_PROVIDERS', [...sessionReader.CODEBUDDY_FAMILY_PROVIDERS].sort()]
  ];
  for (const [name, list] of derived) {
    assert.deepEqual(list, CANONICAL, `${name} 与真值来源不一致`);
  }
});

// 每张 provider→X 表必须**恰好**覆盖家族集合：缺行会让新成员静默缺能力，
// 多行则说明表里混进了非家族 provider（会让非家族账号走进家族专用路径）。
test('每张 provider→X 表恰好覆盖家族集合', () => {
  const tables = [
    ['layouts.AUTH_FILE_NAMES', layouts.AUTH_FILE_NAMES],
    ['layouts.DESKTOP_APP_NAMES', layouts.DESKTOP_APP_NAMES],
    ['billing.CODEBUDDY_FAMILY_AUTH_PATHS', billing.CODEBUDDY_FAMILY_AUTH_PATHS],
    ['billing.CODEBUDDY_FAMILY_BILLING_ENDPOINTS', billing.CODEBUDDY_FAMILY_BILLING_ENDPOINTS],
    ['inference.CODEBUDDY_FAMILY_INFERENCE_BASE_URLS', inference.CODEBUDDY_FAMILY_INFERENCE_BASE_URLS],
    ['credential-source.PRIMARY', credentialSource.PRIMARY]
  ];
  for (const [name, table] of tables) {
    assert.deepEqual(Object.keys(table).sort(), CANONICAL, `${name} 的键集合不等于家族集合`);
  }
});

test('lib/ 下不再有第二份家族名单', () => {
  // 白名单只允许两类，且都写明为什么不能派生：
  //   - 真值来源自己；
  //   - host-observed-providers.js：**零依赖叶子模块**（文件内声明是为了防 require 成环），
  //     四支显式列出；漏补墓碑由 host-account-sync-registry.test.js 的
  //     「注册表覆盖 ⊆ 墓碑列表」抓到（注册表已派生自 FAMILY_PROVIDERS）。
  //   - codebuddy-credential-source.js：逐 provider 的常量表（四支值各不相同，无法派生），
  //     它的键集合由上面「每张 provider→X 表恰好覆盖家族集合」那条守着。
  const allowed = new Set([
    path.join('lib', 'runtime', 'codebuddy-family-layouts.js'),
    path.join('lib', 'account', 'host-observed-providers.js'),
    path.join('lib', 'account', 'codebuddy-credential-source.js')
  ]);
  const window = 6;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const relative = path.relative(ROOT, full);
      if (allowed.has(relative)) continue;
      const lines = fs.readFileSync(full, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const block = lines.slice(index, index + window).join('\n');
        if (CANONICAL.every((member) => block.includes(`'${member}'`))) {
          offenders.push(`${relative}:${index + 1}`);
          break;
        }
      }
    }
  };
  walk(path.join(ROOT, 'lib'));
  assert.deepEqual(offenders, [], `这些位置又出现了家族名单：${offenders.join(', ')}`);
});

test('家族谓词对非家族输入必须为假', () => {
  const predicates = [
    ['layouts', layouts.isCodebuddyFamilyProvider],
    ['billing', billing.isCodebuddyFamilyProvider],
    ['account-status', accountStatus.isCodebuddyFamilyProvider]
  ];
  for (const [name, predicate] of predicates) {
    for (const input of ['', 'codex', 'claude', 'workbuddy-x', 'codebuddy.ai', 'codebuddyc', null, undefined, 42]) {
      assert.equal(predicate(input), false, `${name} 把 ${JSON.stringify(input)} 当成了家族成员`);
    }
  }
  // 大小写与空白归一后仍要认出来（CLI 输入常见形态）。
  assert.equal(layouts.isCodebuddyFamilyProvider('  CodeBuddyCN '), true);
  assert.equal(billing.isCodebuddyFamilyProvider(' WorkBuddy '), true);
  assert.equal(accountStatus.isCodebuddyFamilyProvider('WorkBuddyCN'), true);
});
