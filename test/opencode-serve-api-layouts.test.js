const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LAYOUTS,
  parseServePassword,
  serveApiLayout,
  serveApiRoute,
  supportedServeApiLayouts
} = require('../lib/server/opencode-serve-api-layouts');

// opencode serve API 布局表：新增一代 = 加一行 + 一个事件映射器（eventShape 对应 adapter），
// 派发代码不动。契约测试守住「行必须自洽」：漏字段的表现是静默降级（探测不匹配/路由 404），
// 而不是报错，所以必须在这里 fail fast。

test('布局表契约:每行字段自洽(路由/鉴权/信封/作用域/请求体形状/探测谓词)', () => {
  assert.ok(LAYOUTS.length >= 2);
  for (const layout of LAYOUTS) {
    const label = `layout ${layout.id}`;
    assert.match(layout.id, /^v\d+$/u, label);
    assert.equal(typeof layout.supported, 'boolean', `${label} supported`);
    assert.ok(['none', 'basic'].includes(layout.auth), `${label} auth`);
    if (layout.auth === 'basic') assert.equal(typeof layout.authUser, 'string', `${label} authUser`);
    assert.ok(['bare', 'data'].includes(layout.envelope), `${label} envelope`);
    assert.ok(['properties', 'data'].includes(layout.eventShape), `${label} eventShape`);
    if (layout.supported === false) {
      assert.equal(typeof layout.unsupportedReason, 'string', `${label} 未实现必须写明确原因`);
    }

    for (const route of ['health', 'session', 'createSession', 'prompt', 'permissionReply', 'permissionList', 'eventStream', 'abort']) {
      assert.match(layout.routes[route], /^\//u, `${label} routes.${route}`);
    }
    assert.ok(['query', 'create-location'].includes(layout.scope.kind), `${label} scope.kind`);
    if (layout.scope.kind === 'query') assert.equal(typeof layout.scope.param, 'string', `${label} scope.param`);

    const requests = layout.requests;
    assert.ok(['parts', 'text'].includes(requests.prompt.textShape), `${label} requests.prompt.textShape`);
    assert.equal(typeof requests.modelOnPrompt, 'boolean', `${label} requests.modelOnPrompt`);
    assert.equal(typeof requests.modelOnCreate, 'boolean', `${label} requests.modelOnCreate`);
    assert.equal(typeof requests.modelRef.id, 'string', `${label} requests.modelRef.id`);
    assert.equal(typeof requests.modelRef.provider, 'string', `${label} requests.modelRef.provider`);
    if (!requests.modelOnPrompt) assert.equal(typeof layout.routes[requests.modelRoute], 'string', `${label} 模型不在 prompt 体时必须声明 modelRoute`);
    assert.equal(typeof requests.permissionRules.bodyKey, 'string', `${label} permissionRules.bodyKey`);
    for (const canonical of ['action', 'resource', 'effect']) {
      assert.equal(typeof requests.permissionRules.keyMap[canonical], 'string', `${label} keyMap.${canonical}`);
    }
    assert.equal(typeof requests.permissionReply.bodyKey, 'string', `${label} permissionReply.bodyKey`);
    assert.equal(typeof requests.abortBody, 'boolean', `${label} requests.abortBody`);
    assert.equal(typeof layout.probe.healthOk, 'function', `${label} probe.healthOk`);
    assert.equal(typeof layout.probe.versionField, 'string', `${label} probe.versionField`);
  }
});

test('布局探测谓词:同一响应不得同时命中两代(v2 的 /global/health 是 200 HTML)', () => {
  const v1 = serveApiLayout('v1');
  const v2 = serveApiLayout('v2');

  const v1Body = { healthy: true, version: '1.17.13' };
  const v2Body = { version: '2.0.29', pid: 1 };
  assert.equal(v1.probe.healthOk(v1Body), true);
  assert.equal(v2.probe.healthOk(v1Body), false);
  assert.equal(v2.probe.healthOk(v2Body), true);
  assert.equal(v1.probe.healthOk(v2Body), false);
  // HTML 解析失败(客户端 json=null)与空响应都不命中
  for (const body of [null, '<!doctype html>', '', 200, []]) {
    assert.equal(v1.probe.healthOk(body), false, `v1 不得命中 ${JSON.stringify(body)}`);
    assert.equal(v2.probe.healthOk(body), false, `v2 不得命中 ${JSON.stringify(body)}`);
  }
});

test('serveApiRoute:模板填充与 encode;未知路由/未知布局返回空', () => {
  const v2 = serveApiLayout('v2');
  assert.equal(
    serveApiRoute(v2, 'permissionReply', { sessionId: 'ses 1', requestId: 'per/2' }),
    '/api/session/ses%201/permission/per%2F2/reply'
  );
  assert.equal(serveApiRoute(serveApiLayout('v1'), 'prompt', { sessionId: 'ses_1' }), '/session/ses_1/prompt_async');
  assert.equal(serveApiRoute(v2, 'nope', {}), '');
  assert.equal(serveApiLayout('v9'), null);
  assert.equal(serveApiLayout(''), null);
  assert.deepEqual(supportedServeApiLayouts(), ['v1', 'v2']);
});

test('parseServePassword:日志追加写,只认最后一条 server password', () => {
  assert.equal(parseServePassword('server password abc123\n'), 'abc123');
  assert.equal(parseServePassword('server password old\nx\nserver password new\n'), 'new');
  assert.equal(parseServePassword('no password here'), '');
  assert.equal(parseServePassword(''), '');
  assert.equal(parseServePassword(null), '');
});
