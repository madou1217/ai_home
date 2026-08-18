'use strict';

// 诊断模块（AIH_ZCODE_CAPTCHA_EXPERIMENT=1 启用）：zcode 验证码重试的变体矩阵实验。
// 背景：网关收到 3007 后经 WebUI 桥拿到一次性 verify param 重发，上游回
// 405 {"code":3012,"msg":"method not allowed"}。
// 已排除（2026-08-18 实测矩阵）：浏览器身份头、桌面端 X-ZCode-* 身份头、stream
// 开关、WAF Cookie 重发（param 响应带 Set-Cookie 但带 Cookie 重发仍 3007）。
// 已确认：param 有效且一次性（复用回 3007）；同 JWT 的 billing 端点正常 200，
// 即 3012 只发生在推理端点的验证码门之后；param 形态为 base64 JSON（certifyId...）。
// 已闭环（2026-08-18 mitm 取证）：桌面端黄金请求（200 SSE）恒带 ZCode 桌面身份头
// + metadata.user_id，且 verify param 不绑定求解浏览器 UA；伪造 param 仍 3007，
// 真 param 在闸门关闭期才 3012——3012 是验证码门后的间歇性服务端闸。正式路径的
// 身份对齐已落地于 zcode-official-client.js。注意：每变体各烧一次验证，
// 高频触发有风控风险，勿常态开启。

const os = require('node:os');
const https = require('node:https');

// 剥离传输层/下游继承的杂头，只留黄金请求同款键（mitm 取证：桌面端 agent 的
// 请求没有 accept/accept-language/sec-fetch-mode/accept-encoding 这些 undici
// 或浏览器默认头）。
const GOLDEN_HEADER_DENYLIST = new Set([
  'accept', 'accept-encoding', 'accept-language', 'connection', 'content-length',
  'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user', 'priority',
  'x-aih-account-ref', 'x-aih-account-email'
]);

// 用 node:https 裸发（不经过 fetch/undici），返回 { status, headers, text() } 的
// 最小 Response 形态。不读流式体，拿到状态即毁约，避免挂住。支持经 HTTP 代理
// （CONNECT 隧道），与 fetch 变体走同一 mitm 通道，保证抓包可比。
function rawHttpsPost(url, headers, body, timeoutMs, proxyOptions) {
  const target = new URL(url);
  const proxyUrl = proxyOptions && proxyOptions.proxyUrl ? String(proxyOptions.proxyUrl) : '';
  return new Promise((resolve, reject) => {
    const onResponse = (res, req) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 65536) req.destroy();
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: async () => Buffer.concat(chunks).toString('utf8')
      }));
      res.on('error', reject);
    };
    const requestOptions = {
      method: 'POST',
      headers: { ...headers, 'content-length': body ? Buffer.byteLength(body) : 0 }
    };
    const send = (socketOrUndef) => {
      const req = https.request(target, {
        ...requestOptions,
        ...(socketOrUndef ? {
          // 经 CONNECT 隧道复用已建立的 socket。
          createConnection: () => socketOrUndef,
          agent: false
        } : {})
      }, (res) => onResponse(res, req));
      req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('raw https timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    if (!proxyUrl) {
      send();
      return;
    }
    // CONNECT 隧道：先向代里要一条到目标的 TCP 通道，再在其上起 TLS。
    const tls = require('node:tls');
    const http = require('node:http');
    const proxy = new URL(proxyUrl);
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port || 443}`
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT failed: ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        // 与 server 进程一致地信任 NODE_EXTRA_CA_CERTS（mitm CA）。
        rejectUnauthorized: true
      });
      tlsSocket.on('secureConnect', () => send(tlsSocket));
      tlsSocket.on('error', reject);
    });
    connectReq.setTimeout(timeoutMs || 30000, () => connectReq.destroy(new Error('raw https connect timeout')));
    connectReq.on('error', reject);
    connectReq.end();
  });
}


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
    name: 'golden-body-replay',
    // 终局判别（2026-08-18）：原样回放 mitm 抓到的桌面端黄金 body（82KB，带
    // system/thinking/output_config/tools），只换全新 verify param，头用当前账号
    // 黄金身份 + 裸传输。若它 200/429 而精简 body 变体 3012 → 3012 由 body 形状
    // 触发；若它也 3012 → 闸门当前对该账号关闭（时间/行为闸），与请求形状无关。
    rawTransport: true,
    stripHeaders: true,
    bodyFile: require('node:path').resolve(__dirname, '../../.tmp-mitm/desk-body.json'),
    apply(headers, verification) {
      applyVerification(headers, verification);
    }
  },
  {
    name: 'rawhttps-golden-headers',
    // 决定性变体（2026-08-18 闸门开启期）：用 node:https 裸发，只带黄金请求同款
    // 头，剥离 undici/fetch 自动注入的 accept-language:* / sec-fetch-mode 等。
    // 若它 200/429 而 fetch 变体 3012，则 3012 由传输层杂头触发。
    rawTransport: true,
    stripHeaders: true,
    bodyOverride: { stream: true },
    apply(headers, verification) {
      applyVerification(headers, verification);
    }
  },
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
  } else if (typeof res.text === 'function') {
    body = await res.text().catch(() => '');
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
    if (variant.stripHeaders) {
      for (const key of Object.keys(headers)) {
        if (GOLDEN_HEADER_DENYLIST.has(String(key).toLowerCase())) delete headers[key];
      }
    }
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
      if (variant.bodyFile) {
        try {
          body = require('node:fs').readFileSync(variant.bodyFile);
        } catch (e) {
          results.push({ variant: variant.name, error: `bodyFile unreadable: ${e.message}` });
          continue;
        }
      } else if (variant.bodyOverride && body) {
        try {
          const parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
          Object.assign(parsed, variant.bodyOverride);
          body = JSON.stringify(parsed);
        } catch (_e) { /* 非 JSON 则原样 */ }
      }
      const res = variant.rawTransport
        ? await rawHttpsPost(upstreamUrl, headers, body, timeoutMs, proxyOptions)
        : await fetchWithTimeout(upstreamUrl, {
          method,
          headers,
          body
        }, timeoutMs, proxyOptions);
      // 流式响应不读体，避免挂住；成功即返回。
      const isStream = String(res.headers && res.headers.get && res.headers.get('content-type') || '').includes('text/event-stream');
      const info = isStream ? { status: res.status, body: '<sse stream>' } : await readStatus(res);
      results.push({ variant: variant.name, ...info });
      console.log(`[aih:zcode-captcha-x] ${variant.name} -> ${info.status} ${info.body}`);
      if (res.status < 400) {
        if (variant.rawTransport) {
          // raw 响应是缓冲的最小形态，无法作为流式 Response 转发给下游；
          // 这里只作诊断——返回 res:null 让调用方走失败分支，但 results 里
          // 已记录该变体的真实状态码（200/429 = 传输层对齐有效）。
          console.log(`[aih:zcode-captcha-x] ${variant.name} succeeded via raw transport (diagnostic only, not forwarded)`);
          return { res: null, results };
        }
        return { res, results };
      }
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
