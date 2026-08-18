'use strict';

// 诊断模块（AIH_ZCODE_CAPTCHA_EXPERIMENT=1 启用）：zcode 验证码重试的变体矩阵实验。
// 背景：网关收到 3007 后经 WebUI 桥拿到一次性 verify param 重发，上游回
// 405 {"code":3012,"msg":"method not allowed"}。实验结论（2026-08-18）：四个身份
// 变体全部 405、复用已消费 param 回 3007 → param 校验本身是通的，3012 是账号级
// WAF/业务限制（同期三个账号连 billing/balance 都 3012）。保留本模块用于后续
// 复核限制解除后的真实推理链路；注意它会为每个变体各发起一次验证，勿常态开启。

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
  },
  {
    name: 'param-only',
    apply(headers, verification) {
      applyVerification(headers, verification);
      delete headers['user-agent'];
    }
  },
  {
    name: 'browser-id+desktop-mix',
    apply(headers, verification) {
      applyVerification(headers, verification);
      applyBrowserIdentity(headers, verification);
      Object.assign(headers, desktopIdentityHeaders());
      if (verification.userAgent) headers['user-agent'] = verification.userAgent;
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
      const res = await fetchWithTimeout(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody
      }, timeoutMs, proxyOptions);
      const info = await readStatus(res);
      results.push({ variant: variant.name, ...info });
      console.log(`[aih:zcode-captcha-x] ${variant.name} -> ${info.status} ${info.body}`);
      if (res.status < 400) return { res, results };
      lastRes = res;
    } catch (error) {
      results.push({ variant: variant.name, error: String(error && error.message || error).slice(0, 120) });
      console.log(`[aih:zcode-captcha-x] ${variant.name} -> EX ${String(error && error.message || error).slice(0, 120)}`);
    }
  }
  // 判别实验：复用第一个 param 再发一次。若二次使用回 3007（=已被消费），
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
  return { res: lastRes, results };
}

module.exports = { runCaptchaRetryExperiment };
