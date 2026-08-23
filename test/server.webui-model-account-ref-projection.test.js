const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildModelAccountRefProjection
} = require('../lib/server/webui-model-account-ref-projection');

const POOL_REF = 'acct_11111111111111111111';
const LISTED_REF = 'acct_22222222222222222222';
const FAILED_REF = 'acct_33333333333333333333';
const NEVER_PROBED_REF = 'acct_44444444444444444444';

function buildState() {
  return {
    accounts: {
      codex: [{ accountRef: POOL_REF, provider: 'codex', accessToken: 'token' }],
      claude: [],
      gemini: [],
      agy: []
    }
  };
}

function buildCatalog() {
  return {
    byAccount: {
      [POOL_REF]: ['model-pool'],
      // 账号页会列出、但已不在运行池里的账号：目录早就探到并落了盘。
      [LISTED_REF]: ['model-a', 'model-b']
    },
    errorsByAccount: {
      [FAILED_REF]: 'HTTP 404 Not Found'
    }
  };
}

test('accounts in the runtime pool keep projecting their catalog', () => {
  const projection = buildModelAccountRefProjection({}, buildState(), buildCatalog());
  assert.deepEqual(projection.byAccountRef[POOL_REF], ['model-pool']);
});

// 只在手动模型设置里出现的账号不在 state.accounts 里，投影原本永远跳过它们，
// 页面就把「有上次探测结果」显示成「待探测」，刷新也回不来。
test('a listed account outside the runtime pool still shows its persisted catalog', () => {
  const projection = buildModelAccountRefProjection(
    {},
    buildState(),
    buildCatalog(),
    null,
    [POOL_REF, LISTED_REF]
  );

  assert.deepEqual(projection.byAccountRef[LISTED_REF], ['model-a', 'model-b']);
  assert.deepEqual(projection.byAccountRef[POOL_REF], ['model-pool']);
});

test('a listed account whose last probe failed reports the error instead of looking unprobed', () => {
  const projection = buildModelAccountRefProjection(
    {},
    buildState(),
    buildCatalog(),
    null,
    [FAILED_REF]
  );

  assert.equal(projection.errorsByAccountRef[FAILED_REF], 'HTTP 404 Not Found');
});

test('a scoped projection only merges persisted results for the selected account', () => {
  const projection = buildModelAccountRefProjection(
    {},
    buildState(),
    buildCatalog(),
    { accountRef: LISTED_REF },
    [LISTED_REF, FAILED_REF]
  );

  assert.deepEqual(projection.byAccountRef, {
    [LISTED_REF]: ['model-a', 'model-b']
  });
  assert.deepEqual(projection.errorsByAccountRef, {});
});

test('a scoped projection keeps the selected account error without leaking other cached models', () => {
  const projection = buildModelAccountRefProjection(
    {},
    buildState(),
    buildCatalog(),
    { accountRef: FAILED_REF },
    [LISTED_REF, FAILED_REF]
  );

  assert.deepEqual(projection.byAccountRef, {});
  assert.deepEqual(projection.errorsByAccountRef, {
    [FAILED_REF]: 'HTTP 404 Not Found'
  });
});

// 「从未探测」和「已知为空」是两回事：前者绝不能写成空数组，
// 否则页面会把「未知」显示成「没有模型」，下游也会当成这个账号确实不支持任何模型。
test('a never-probed account is left absent rather than written as an empty catalog', () => {
  const projection = buildModelAccountRefProjection(
    {},
    buildState(),
    buildCatalog(),
    null,
    [NEVER_PROBED_REF]
  );

  assert.equal(
    Object.prototype.hasOwnProperty.call(projection.byAccountRef, NEVER_PROBED_REF),
    false
  );
});

test('a known-empty catalog is still projected as empty', () => {
  const catalog = buildCatalog();
  catalog.byAccount[LISTED_REF] = [];

  const projection = buildModelAccountRefProjection({}, buildState(), catalog, null, [LISTED_REF]);

  assert.deepEqual(projection.byAccountRef[LISTED_REF], []);
});

// 运行池里的账号已经投影过就不该被兜底覆盖掉。
test('the fallback never overwrites an entry the runtime pool already produced', () => {
  const catalog = buildCatalog();
  const projection = buildModelAccountRefProjection({}, buildState(), catalog, null, [POOL_REF]);

  assert.deepEqual(projection.byAccountRef[POOL_REF], ['model-pool']);
});

test('omitting the extra refs keeps the previous runtime-pool-only behaviour', () => {
  const projection = buildModelAccountRefProjection({}, buildState(), buildCatalog());

  assert.equal(Object.prototype.hasOwnProperty.call(projection.byAccountRef, LISTED_REF), false);
  assert.equal(Object.prototype.hasOwnProperty.call(projection.errorsByAccountRef, FAILED_REF), false);
});
