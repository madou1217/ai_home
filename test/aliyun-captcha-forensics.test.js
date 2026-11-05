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
//
// 2026-11-05 第二起事故：解算窗口一启动就弹「A keychain cannot be found to
// store "Chrome."」，SecurityAgent 常驻，解算 90s 超时。真机 `security
// list-keychains` 只有 System.keychain、`security default-keychain -d user`
// 直接报 "A default keychain could not be found"，Chrome 建新 profile 时无处
// 存放 "Chrome Safe Storage"，于是卡在弹窗上。加 `--use-mock-keychain` 后
// A/B/A 对照：不带 → 每次新起 SecurityAgent；带 → 0 次，端到端 15s 出参。

const test = require('node:test');
const assert = require('node:assert/strict');

const { __private } = require('../lib/account/activity-claim/aliyun-captcha');
const {
  buildCaptchaLaunchArgs,
  buildCaptchaExpression,
  dispatchHumanClick,
  launchCaptchaBrowser,
  moveCaptchaWindowOffscreen,
  resolveMacAppBundle,
  waitForCaptchaButton,
  waitForDevtoolsPort,
  waitForDocument
} = __private;

test('Chrome 必须有头，不能回到 headless', () => {
  const args = buildCaptchaLaunchArgs('/tmp/profile-x');
  assert.equal(args.includes('--headless=new'), false, '不能回到 headless：实测必 F001');
  assert.equal(args.some((a) => a.startsWith('--headless')), false, '不能出现任何 headless 开关');
  // Windows/Linux 上 --window-position 有效；macOS 会忽略它，改由 CDP 在加载后移窗。
  assert.ok(args.includes('--window-position=-3000,-3000'), '支持的平台先把窗口放到屏幕外');
  assert.ok(args.includes('--user-data-dir=/tmp/profile-x'), '必须用独立 profile');
});

test('必须用 mock keychain，不能碰系统钥匙串', () => {
  const args = buildCaptchaLaunchArgs('/tmp/profile-x');
  // 2026-11-05：本机没有登录钥匙串，Chrome 建 profile 时弹
  // 「A keychain cannot be found to store "Chrome."」并把解算卡死 90s。
  // --use-mock-keychain 是 Chromium 官方测试开关，只在进程内生成临时密钥。
  assert.ok(
    args.includes('--use-mock-keychain'),
    '缺了它就会弹钥匙串对话框，解算直接超时'
  );
  assert.equal(
    args.some((a) => a.startsWith('--password-store=')),
    false,
    'mock keychain 已足够；不要再叠 password-store，避免影响 profile 行为'
  );
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

// 2026-11-05 事故回归：init 返回时控件还没渲染，旧代码退化成点宿主中心（空白），
// 结果是「自动解算永远超时、用户只能手动点验证码」。
test('控件没渲染时必须返回 null，绝不能退回点宿主中心', async () => {
  const calls = [];
  const cdp = {
    send: async (method, params) => {
      calls.push({ method, params });
      return { result: { value: null } };
    }
  };
  const point = await waitForCaptchaButton(cdp, 's1', 1_000);
  assert.equal(point, null, '没有「点击开始验证」节点时不能给出坐标');
  assert.ok(calls.length >= 2, '应当轮询等待控件渲染，而不是只查一次');
  assert.ok(
    calls.every((call) => /getElementById\('aih-captcha-host'\)/.test(call.params.expression)),
    '轮询的必须是控件查询表达式'
  );
});

test('控件稍后渲染出来时要继续等到它', async () => {
  const values = [null, null, { x: 184, y: 114 }];
  let index = 0;
  const cdp = {
    send: async () => ({ result: { value: values[Math.min(index++, values.length - 1)] } })
  };
  const point = await waitForCaptchaButton(cdp, 's1', 3_000);
  assert.deepEqual(point, { x: 184, y: 114 });
  assert.equal(index, 3, '第三次才拿到坐标');
});

test('移窗只移动、不最小化（最小化会冻结渲染进程）', async () => {
  const calls = [];
  const cdp = {
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Browser.getWindowForTarget') return { windowId: 42, bounds: { left: 0, top: 31 } };
      return {};
    }
  };
  const moved = await moveCaptchaWindowOffscreen(cdp, 'target-1');
  assert.equal(moved, true);
  assert.equal(calls[0].method, 'Browser.getWindowForTarget');
  assert.equal(calls[1].method, 'Browser.setWindowBounds');
  assert.deepEqual(calls[1].params, { windowId: 42, bounds: { left: -3000, top: -3000 } });
  assert.equal(
    calls.some((call) => call.params && call.params.bounds && call.params.bounds.windowState),
    false,
    '不能下发 windowState（最小化会让页面进入 hidden 并冻结）'
  );
});

test('文档必须落在 zcode 的 origin 上才算可注入', async () => {
  const okCdp = {
    send: async () => ({
      result: { value: { href: 'https://zcode.z.ai/', origin: 'https://zcode.z.ai', ready: 'complete', hasBody: true } }
    })
  };
  assert.deepEqual(await waitForDocument(okCdp, 's1', 1_000), { ready: true, complete: true });

  const wrongOriginCdp = {
    send: async () => ({
      result: { value: { href: 'about:blank', origin: 'null', ready: 'complete', hasBody: true } }
    })
  };
  assert.deepEqual(await waitForDocument(wrongOriginCdp, 's1', 1_000), { ready: false, complete: false });
});

// 2026-11-05 事故回归：macOS 上直接 spawn Chrome 二进制，网络扩展会掐掉出站连接，
// 页面导航 12–130s 才 commit（甚至永不 commit）。必须走 LaunchServices（open -na）。
test('macOS 上必须用 open -na 启动 App Bundle', () => {
  assert.equal(
    resolveMacAppBundle('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Google Chrome.app'
  );
  assert.equal(resolveMacAppBundle('/usr/bin/google-chrome'), '');

  const calls = [];
  const fakeChild = { kill: () => {} };
  const launched = launchCaptchaBrowser({
    executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    userDataDir: '/tmp/profile-x',
    args: ['--remote-debugging-port=0', 'about:blank'],
    platform: 'darwin',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return fakeChild;
    }
  });
  assert.equal(launched.viaOpen, true);
  assert.equal(calls[0].command, 'open');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '-g', '-na', '/Applications/Google Chrome.app', '--args', '--remote-debugging-port=0'
  ]);
});

test('非 macOS 保持直接 spawn（可拿到 stderr）', () => {
  const calls = [];
  const launched = launchCaptchaBrowser({
    executable: '/usr/bin/google-chrome',
    userDataDir: '/tmp/profile-x',
    args: ['about:blank'],
    platform: 'linux',
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { kill: () => {} };
    }
  });
  assert.equal(launched.viaOpen, false);
  assert.equal(calls[0].command, '/usr/bin/google-chrome');
  assert.equal(calls[0].options.stdio[2], 'pipe');
});

test('DevTools 端口从 user-data-dir 的 DevToolsActivePort 读取', async () => {
  const fakeFs = {
    readFileSync: () => '52341\n/devtools/browser/abc-123\n'
  };
  const devtools = await waitForDevtoolsPort(fakeFs, '/tmp/profile-x', 1_000);
  assert.deepEqual(devtools, { port: 52341, path: '/devtools/browser/abc-123' });
});
