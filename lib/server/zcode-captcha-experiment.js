'use strict';

// 诊断模块（AIH_ZCODE_CAPTCHA_EXPERIMENT=1 启用）：zcode 验证码重试的变体矩阵实验。
// 背景：网关收到 3007 后经 WebUI 桥拿到一次性 verify param 重发，上游回
// 405 {"code":3012,"msg":"method not allowed"}。
// 已排除（2026-08-18 实测矩阵）：浏览器身份头、桌面端 X-ZCode-* 身份头、stream
// 开关、WAF Cookie 重发（param 响应带 Set-Cookie 但带 Cookie 重发仍 3007）。
// 已确认：param 有效且一次性（复用回 3007）；同 JWT 的 billing 端点正常 200，
// 即 3012 只发生在推理端点的验证码门之后；param 形态为 base64 JSON（certifyId...）。
// 剩余待证：桌面端真实推理请求来自 agent runtime 二进制（glm app-server），
// 需经桌面端代理设置挂 mitm 抓取其真实请求对比。注意：每变体各烧一次验证，
// 高频触发有风控风险，勿常态开启。

const os = require('node:os');

function desktopIdentityHeaders() {
  return {
    'user-agent': 'ZCode/3.7.7',
    'http-referer': 'https://zcode.z.ai',
    'x-title': 'Z Code@electron',
    'x-zcode-app-version': '3.7.7',
    'x-platform': `${process.platform}-${process.arch}`,
    'x-client-language': 'zh-CN',
    'x-client-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    'x-os-category': process.platform === 'win32' ? 'windows' : (process.platform === 'darwin' ? 'macos' : 'linux'),
    'x-os-version': os.version()
  };
}

function applyVerification(headers, verification) {
  headers['x-aliyun-captcha-verify-param'] = verification.verifyParam;
  if (verification.region) headers['x-aliyun-captcha-verify-region'] = verification.region;
}

function applyBrowserIdentity(headers, verification) {
  if (verification.userAgent) headers['user-agent'] = verification.userAgent;
  if (verification.secChUa) headers['sec-ch-ua'] = verification.secChUa;
  if (verification.secChUaPlatform) headers['sec-ch-ua-platform'] = verification.secChUaPlatform;
  if (verification.secChUaMobile) headers['sec-ch-ua-mobile'] = verification.secChUaMobile;
  if (verification.acceptLanguage) headers['accept-language'] = verification.acceptLanguage;
}

const VARIANTS = [
  {
    name: 'stream-true+browser-id',
    // zcode-plan 推理端点可能只接受 SSE 流式请求（桌面 agent 恒为 stream），
    // 非流式 POST 或过验证码门后被业务层以 3012 "method not allowed" 拒绝。
    bodyOverride: { stream: true },
    apply(headers, verification) {
      applyVerification(headers, verification);
      applyBrowserIdentity(headers, verification);
    }
  },
  {
    name: 'stream-true+desktop-id',
    bodyOverride: { stream: true },
    apply(headers, verification) {
      applyVerification(headers, verification);
      Object.assign(headers, desktopIdentityHeaders());
    }
  },
  {
    name: 'browser-id',
    apply(headers, verification) {
      applyVerification(headers, verification);
      applyBrowserIdentity(headers, verification);
    }
  },
  {
    name: 'desktop-id',
    apply(headers, verification) {
      applyVerification(headers, verification);
      Object.assign(headers, desktopIdentityHeaders());
    }
  }
];

async function readStatus(res) {
  let body = '';
  if (typeof res.clone === 'function') {
    body = await res.clone().text().catch(() => '');
  }
  return { status: res.status, body: body.slice(0, 160) };
}

// 返回 { res, results }；所有变体都失败时 res 为最后一次响应。
async function runCaptchaRetryExperiment(ctx) {
  const {
    bridge, account, upstreamUrl, method, baseHeaders, forwardBody,
    fetchWithTimeout, timeoutMs, proxyOptions, verifyTimeoutMs
  } = ctx;
  const results = [];
  let lastRes = null;
  let firstParam = '';
  let firstHeaders = null;
  for (const variant of VARIANTS) {
    // 每个变体用全新 verify param（一次性消费，桌面端同样一求一用）。
    const verification = await bridge.requestVerification(account.accountRef, { timeoutMs: verifyTimeoutMs });
    if (!verification || !verification.ok || !verification.verifyParam) {
      results.push({ variant: variant.name, error: String(verification && verification.reason || 'no_param') });
      continue;
    }
    const headers = { ...baseHeaders };
    variant.apply(headers, verification);
    if (!firstParam) {
      firstParam = verification.verifyParam;
      firstHeaders = { ...headers };
      // 参数形态采样（不落盘全文）：长度 + 是否 JSON + 顶层键。
      let shape = 'raw';
      try {
        const parsed = JSON.parse(verification.verifyParam);
        shape = parsed && typeof parsed === 'object' ? `json keys=${Object.keys(parsed).join(',')}` : 'json-scalar';
      } catch (_e) { /* not json */ }
      console.log(`[aih:zcode-captcha-x] param shape: len=${verification.verifyParam.length} ${shape} head=${verification.verifyParam.slice(0, 40)}`);
    }
    try {
      let body = ['GET', 'HEAD'].includes(method) ? undefined : forwardBody;
      if (variant.bodyOverride && body) {
        try {
          const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
          Object.assign(parsed, variant.bodyOverride);
          body = JSON.stringify(parsed);
        } catch (_e) { /* 非 JSON 则原样 */ }
      }
      const res = await fetchWithTimeout(upstreamUrl, {
        method,
        headers,
        body
      }, timeoutMs, proxyOptions);
      // 流式响应不读体，避免挂住；成功即返回。
      const isStream = String(res.headers && res.headers.get && res.headers.get('content-type') || '').includes('text/event-stream');
      const info = isStream ? { status: res.status, body: '<sse stream>' } : await readStatus(res);
      results.push({ variant: variant.name, ...info });
      console.log(`[aih:zcode-captcha-x] ${variant.name} -> ${info.status} ${info.body}`);
      if (res.status < 400) return { res, results };
      lastRes = res;
    } catch (error) {
      results.push({ variant: variant.name, error: String(error && error.message || error).slice(0, 120) });
      console.log(`[aih:zcode-captcha-x] ${variant.name} -> EX ${String(error && error.message || error).slice(0, 120)}`);
    }
  }
  // 判别实验 1：复用第一个 param 再发一次。若二次使用回 3007（=已被消费），
  // 说明首次 405 是「param 有效但请求被拒」；若仍 405，则 405 = param 校验不通过。
  if (firstParam && firstHeaders) {
    try {
      const res = await fetchWithTimeout(upstreamUrl, {
        method,
        headers: firstHeaders,
        body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody
      }, timeoutMs, proxyOptions);
      const info = await readStatus(res);
      results.push({ variant: 'reuse-first-param', ...info });
      console.log(`[aih:zcode-captcha-x] reuse-first-param -> ${info.status} ${info.body}`);
    } catch (error) {
      results.push({ variant: 'reuse-first-param', error: String(error && error.message || error).slice(0, 120) });
    }
  }
  // 判别实验 2：redirect:manual 探测。假设：WAF 校验 param 后回 3xx + Set-Cookie
  // （验证 Cookie），客户端需带 Cookie 重发；node fetch 无 CookieJar 且自动跟随
  // 重定向把 POST 降级成 GET，恰好解释 3012 "method not allowed"。
  {
    const verification = await bridge.requestVerification(account.accountRef, { timeoutMs: verifyTimeoutMs }).catch(() => null);
    if (verification && verification.ok && verification.verifyParam) {
      const headers = { ...baseHeaders };
      applyVerification(headers, verification);
      applyBrowserIdentity(headers, verification);
      try {
        const res = await fetch(upstreamUrl, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody,
          redirect: 'manual'
        });
        const setCookie = res.headers.get('set-cookie') || '';
        const location = res.headers.get('location') || '';
        const bodyText = await res.text().catch(() => '');
        results.push({ variant: 'manual-redirect-probe', status: res.status, location: location.slice(0, 120), setCookie: setCookie ? `<len${setCookie.length}>` : '', body: bodyText.slice(0, 160) });
        console.log(`[aih:zcode-captcha-x] manual-redirect-probe -> ${res.status} location=${location.slice(0, 120)} set-cookie=${setCookie ? `len${setCookie.length}` : 'none'} body=${bodyText.slice(0, 120)}`);
        // 判别实验 3：param 请求 405 但带了 Set-Cookie —— 若该 Cookie 是 WAF 的
        // 验证通过凭证，则带 Cookie（不带 param）重发应当直接通过。
        if (setCookie) {
          const cookieHeader = setCookie.split(/,(?=\s*[^;,]+=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
          const res2 = await fetch(upstreamUrl, {
            method,
            headers: { ...baseHeaders, cookie: cookieHeader },
            body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody,
            redirect: 'manual'
          });
          const isStream2 = String(res2.headers.get('content-type') || '').includes('text/event-stream');
          const body2 = isStream2 ? '<sse stream>' : (await res2.text().catch(() => '')).slice(0, 160);
          results.push({ variant: 'cookie-only-retry', status: res2.status, body: body2 });
          console.log(`[aih:zcode-captcha-x] cookie-only-retry -> ${res2.status} ${body2}`);
          if (res2.status < 400) return { res: res2, results };
        }
      } catch (error) {
        results.push({ variant: 'manual-redirect-probe', error: String(error && error.message || error).slice(0, 120) });
      }
    }
  }
  return { res: lastRes, results };
}

module.exports = { runCaptchaRetryExperiment };
