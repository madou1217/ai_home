'use strict';

// 阿里云验证码求解器的风控回归守卫。
//
// 2026-11-04 事故：8 个 zcode 账号全部 zcode_captcha_rejected。真因不是账号、
// 不是出口 IP、不是 profile，而是阿里云按「是否真实窗口 + 是否有鼠标轨迹」判风险：
//
//   headless + 瞬时点击        → F001 verifyResult:false
//   headless + 拟人轨迹        → F001
//   headed   + 瞬时点击        → F001
//   headed   + 拟人轨迹        → success
//   headed   + 拟人轨迹 + 伪造 UA/时区/navigator.webdriver → F001
//
// 所以这三件事任何一件被改回去都会静默退化成"全部账号验证失败"，
// 而单测里没有浏览器，只能在启动参数、页面注入表达式、点击轨迹三处设防。

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../lib/account/activity-claim/aliyun-captcha');
const { buildCaptchaLaunchArgs, buildCaptchaExpression, dispatchHumanClick } = __private;

test('Chrome 必须有头且离屏', () => {
  const args = buildCaptchaLaunchArgs('/tmp/profile-x');
  assert.equal(args.includes('--headless=new'), false, '不能回到 headless：实测必 F001');
  assert.equal(args.some((a) => a.startsWith('--headless')), false, '不能出现任何 headless 开关');
  assert.ok(args.includes('--window-position=-3000,-3000'), '窗口要移到屏幕外，避免打扰用户');
  assert.ok(args.includes('--user-data-dir=/tmp/profile-x'), '必须用独立 profile');
});

test('控件用 embed 模式渲染，并强制交互式', () => {
  const expr = buildCaptchaExpression({ sceneId: 'scene1', prefix: 'pfx', region: 'cn' });
  assert.ok(expr.includes("mode: 'embed'"), 'popup + 0×0 宿主时控件不渲染，只能退回无痕验证');
  assert.equal(expr.includes('button:'), false, 'embed 模式不需要按钮元素');
  assert.ok(
    expr.includes("if (property === 'startTracelessVerification') return undefined;"),
    '必须藏掉无痕验证，否则 SDK 会走无痕分支并返回 F001'
  );
});

test('不伪造任何可被检测的指纹', () => {
  const expr = buildCaptchaExpression({ sceneId: 'scene1', prefix: 'pfx', region: 'cn' });
  assert.equal(expr.includes('navigator,"webdriver"'), false, '覆盖 navigator.webdriver 反而被判机器');
  assert.equal(expr.includes('setUserAgentOverride'), false);
  assert.equal(expr.includes('setTimezoneOverride'), false);
});

test('点击必须是带轨迹的拟人操作，不是瞬时点击', async () => {
  const events = [];
  const cdp = {
    send: async (method, params) => { events.push({ method, params }); }
  };
  const target = { x: 300, y: 400 };
  await dispatchHumanClick(cdp, 's1', target);

  const moves = events.filter((e) => e.params && e.params.type === 'mouseMoved');
  const pressIndex = events.findIndex((e) => e.params && e.params.type === 'mousePressed');
  const releaseIndex = events.findIndex((e) => e.params && e.params.type === 'mouseReleased');

  assert.ok(moves.length >= 30, `轨迹点太少（${moves.length}），会被判成机器点击`);
  assert.ok(pressIndex > 0 && releaseIndex > pressIndex, '必须先按下再释放');
  assert.ok(pressIndex === events.length - 2, '按下前不应再有别的输入事件');
  const last = moves[moves.length - 1].params;
  assert.ok(Math.abs(last.x - target.x) < 8 && Math.abs(last.y - target.y) < 8, '轨迹终点要落在目标上');
  const first = moves[0].params;
  assert.ok(Math.hypot(first.x - target.x, first.y - target.y) > 100, '起点必须离目标足够远，否则没有位移');
});
