'use strict';

// relaycore 的架构守卫：抽象层里不得出现任何 Provider 名字面量。
//
// 为什么值得一个守卫：relaycore 的全部价值在于「差异局部化」——多数派零覆盖、
// 少数派的差异集中在一个文件。一旦有人在共享代码里写 `if provider == "codebuddy"`，
// 抽象就退化成「一份带特例的公共代码」，新增 Provider 时又要在共享逻辑里加分支，
// 正是 design-patterns.md 禁止的形态（「新增 provider 能力禁止写 if (provider === '…')」）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const RELAYCORE = path.join(ROOT, 'internal', 'transport', 'http', 'relaycore');

function readGoSources(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.go') && !name.endsWith('_test.go'))
    .map((name) => ({ name, content: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

test('relaycore 的实现文件里不出现任何 Provider 名', () => {
  // 用 manifest 的 Provider 全集做扫描面：新增 Provider 自动纳入守卫，不需要改这里。
  const manifest = require('../contracts/providers/manifest.json');
  const providerIds = (manifest.providers || []).map((provider) => provider.id);
  assert.ok(providerIds.length > 0, '必须能从 manifest 读到 Provider 全集');

  const violations = [];
  for (const source of readGoSources(RELAYCORE)) {
    for (const providerId of providerIds) {
      // 只查「像标识符那样出现」的用法，避免把注释里的举例误判。
      const pattern = new RegExp(`["'\`]${providerId}["'\`]`);
      if (pattern.test(source.content)) {
        violations.push(`${source.name}: 出现字面量 ${providerId}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'relaycore 必须与 Provider 无关：差异只能通过覆盖 Provider 方法表达，'
    + `不能在共享代码里判 Provider 名。违规项：\n${violations.join('\n')}`
  );
});

test('relaycore 的 BaseProvider 覆盖面与 Provider 接口一致', () => {
  const providerSource = fs.readFileSync(path.join(RELAYCORE, 'provider.go'), 'utf8');
  // 接口里的每个方法都必须在 BaseProvider 上有默认实现 —— 否则「多数派零覆盖」不成立，
  // 每个新 Provider 都得自己实现一遍（抽象就没起到作用）。
  const interfaceBody = providerSource.slice(
    providerSource.indexOf('type Provider interface {'),
    providerSource.indexOf('// RewriteResult')
  );
  const methods = [...interfaceBody.matchAll(/^\t([A-Z][A-Za-z]*)\(/gm)].map((match) => match[1]);
  assert.ok(methods.length > 0, '必须能从 Provider 接口解析出方法');
  for (const method of methods) {
    assert.match(
      providerSource,
      new RegExp(`func \\(base BaseProvider\\) ${method}\\(`),
      `BaseProvider 必须为 ${method} 提供默认实现 —— 否则多数派 Provider 无法零覆盖`
    );
  }
});
