#!/usr/bin/env node
/**
 * web-account-auth.js 按功能域拆分辅助脚本（一次性工具，用完即弃）
 *
 * 输入: lib/server/web-account-auth.js (2383 行, 63 函数 + 23 顶层 const, 18 导出)
 * 输出:
 *   - lib/server/web-account-auth-utils.js          共享工具（含 normalizeAuthMode、device-code 解析）
 *   - lib/server/web-account-auth-auth-mode.js      认证方式矩阵域
 *   - lib/server/web-account-auth-job.js            认证任务进度/日志域
 *   - lib/server/web-account-auth-oauth-tokens.js   OAuth 凭据检测域
 *   - lib/server/web-account-auth-oauth-browser.js  OAuth 浏览器回调域
 *   - lib/server/web-account-auth-oauth-urls.js     OAuth URL 构建/令牌交换域
 *   - lib/server/web-account-auth-account-config.js 账号配置/登录域
 *   - 主文件保留: createAuthJobManager 编排 + 仅主文件使用的 const + module.exports
 *
 * 安全约束:
 *   - 只按行号区间原样搬移函数体与 const，不重写任何逻辑
 *   - const 按 constDomainMap 随域迁移（含被导出 const 的 re-export 链路）
 *   - 搬移前做静态引用校验: 域内成员引用的顶层符号必须属于同域 ∪ utils
 *   - 失败即退出, 不产生任何写操作
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'server', 'web-account-auth.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

// ---------- 1. 解析顶层声明 ----------
const decls = [];
lines.forEach((l, i) => {
  const fn = l.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/);
  if (fn) { decls.push({ kind: 'function', name: fn[1], line: i + 1 }); return; }
  const cs = l.match(/^const\s+([A-Za-z0-9_$]+)\s*=\s*(?!\s*require\()/);
  if (cs) { decls.push({ kind: 'const', name: cs[1], line: i + 1 }); return; }
  const ls = l.match(/^let\s+([A-Za-z0-9_$]+)\b/);
  if (ls) { decls.push({ kind: 'let', name: ls[1], line: i + 1 }); }
});
const segments = decls.map((d, idx) => ({ ...d, end: idx + 1 < decls.length ? decls[idx + 1].line - 1 : lines.length }));
const tailIdx = src.lastIndexOf('module.exports = {');
const tailLine = tailIdx >= 0 ? src.slice(0, tailIdx).split('\n').length : -1;
if (tailIdx < 0) { console.error('module.exports tail not found'); process.exit(1); }
segments.forEach((s) => { s.end = Math.min(s.end, tailLine - 1); });

// ---------- 2. 引用分析 ----------
function stripCode(body) {
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    const d = body[i + 1];
    if (c === '/' && d === '/') { while (i < n && body[i] !== '\n') i++; out += ' '; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(body[i] === '*' && body[i + 1] === '/')) i++; i += 2; out += ' '; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < n) { if (body[i] === '\\') { i += 2; continue; } if (body[i] === c) { i++; break; } i++; }
      out += ' ';
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === '`') { i++; break; }
        if (body[i] === '$' && body[i + 1] === '{') {
          let depth = 1; let j = i + 2;
          while (j < n && depth > 0) {
            if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
            else if (body[j] === '`') { j++; while (j < n && body[j] !== '`') { if (body[j] === '\\') j += 2; else j++; } }
            j++;
          }
          out += stripCode(body.slice(i + 2, j - 1));
          i = j;
          continue;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === '/' && d !== '/' && d !== '*') {
      const prev = out.trimEnd().slice(-1);
      if (prev === '' || /[=(,:!&|?{}\[;+\-*%^~<>]/.test(prev)) {
        let j = i + 1; let inClass = false; let ok = false;
        while (j < n) {
          if (body[j] === '\\') { j += 2; continue; }
          if (body[j] === '\n') break;
          if (body[j] === '[') inClass = true;
          else if (body[j] === ']') inClass = false;
          else if (body[j] === '/' && !inClass) { j++; ok = true; break; }
          j++;
        }
        if (ok) { while (j < n && /[a-z]/i.test(body[j])) j++; i = j; out += ' '; continue; }
      }
    }
    out += c;
    i++;
  }
  return out;
}
const allNames = decls.map((d) => d.name);
const refsOf = {};
segments.forEach((seg) => {
  const body = stripCode(lines.slice(seg.line - 1, seg.end).join('\n'));
  refsOf[seg.name] = allNames.filter((n) => n !== seg.name && new RegExp('\\b' + n + '\\b').test(body));
});

// ---------- 3. 域归类 ----------
const orchestrationNames = new Set(['createAuthJobManager']);

const forcedDomainNames = {
  // --- auth-mode 域: 认证方式矩阵 ---
  deriveProviderAuthModes: 'auth-mode',
  normalizeExistingAccountRef: 'auth-mode',
  isSupportedAuthMode: 'auth-mode',
  getDefaultAuthMode: 'auth-mode',
  // --- job 域: 认证任务进度/日志 ---
  appendLogText: 'job',
  appendLog: 'job',
  notifyAuthJobChanged: 'job',
  appendJobLog: 'job',
  setAuthProgressState: 'job',
  serializeAuthJob: 'job',
  resolveInitialAuthProgressState: 'job',
  resolveFinishedAuthProgressState: 'job',
  isAgyGoogleOAuthPrompt: 'job',
  maybeSelectAgyGoogleOAuth: 'job',
  // --- oauth-tokens 域: OAuth 凭据检测 ---
  hasCodexOauthTokens: 'oauth-tokens',
  hasClaudeOauthTokens: 'oauth-tokens',
  hasGeminiOauthTokens: 'oauth-tokens',
  hasAgyOauthTokens: 'oauth-tokens',
  hasOpenCodeAuthTokens: 'oauth-tokens',
  hasGrokOauthTokens: 'oauth-tokens',
  hasKimiOauthTokens: 'oauth-tokens',
  getOauthArtifactPath: 'oauth-tokens',
  readOauthArtifactSignature: 'oauth-tokens',
  hasGenericOauthArtifact: 'oauth-tokens',
  hasOauthCompletionArtifacts: 'oauth-tokens',
  // --- oauth-browser 域: OAuth 浏览器回调 ---
  extractOAuthChallenge: 'oauth-browser',
  getUrlPrefix: 'oauth-browser',
  isUrlContinuationLine: 'oauth-browser',
  collectWrappedHttpUrls: 'oauth-browser',
  collectHttpUrls: 'oauth-browser',
  extractBrowserOAuthHints: 'oauth-browser',
  isLoopbackCallbackUrl: 'oauth-browser',
  buildBrowserCaptureCommand: 'oauth-browser',
  parseBrowserCallbackInput: 'oauth-browser',
  isSameCallbackEndpoint: 'oauth-browser',
  parseAuthorizationCodeInput: 'oauth-browser',
  // --- oauth-urls 域: OAuth URL 构建/令牌交换 ---
  buildCodexAuthorizationUrl: 'oauth-urls',
  buildClaudeAuthorizationUrl: 'oauth-urls',
  buildZcodeAuthorizationUrl: 'oauth-urls',
  buildClaudeCredentialsFromTokenResponse: 'oauth-urls',
  decodeJwtPayloadUnsafe: 'oauth-urls',
  resolveCodexUpstreamAccountId: 'oauth-urls',
  buildCodexAuthJsonFromTokenResponse: 'oauth-urls',
  // --- account-config 域: 账号配置/登录 ---
  buildLoginArgs: 'account-config',
  resolveProviderConfigDir: 'account-config',
  ensureLoginRuntime: 'account-config',
  configureApiKeyAccount: 'account-config',
  configureVertexAiAccount: 'account-config',
  hashSecret: 'account-config',
};

const forcedUtilsNames = new Set([
  'loadNodePty',
  'createLazyPtyAdapter',
  'createAnsiStripper',
  'stripAnsi',
  'normalizeString',
  'base64Url',
  'createPkcePair',
  'createOauthState',
  'normalizeAuthMode',
  'compactLogText',
  'parseDeviceCodeExpiryMs',
  'parseDeviceCodePollIntervalMs',
  'isProcessAlive'
]);

// const 随域迁移表；'main' = 保留在主文件
const constDomainMap = {
  JOB_LOG_LIMIT: 'job',
  FINISHED_JOB_TTL_MS: 'main',
  DERIVED_PROVIDER_AUTH: 'auth-mode',
  PROVIDER_AUTH_MODE_MATRIX: 'auth-mode',
  PROVIDER_DEFAULT_AUTH_MODE: 'auth-mode',
  DEVICE_CODE_DURATION_UNITS_MS: 'utils',
  RFC8628_DEFAULT_POLL_INTERVAL_MS: 'main',
  BROWSER_CAPTURE_UNIX: 'oauth-browser',
  BROWSER_CAPTURE_WIN: 'oauth-browser',
  CODEX_OAUTH_AUTHORIZE_URL: 'oauth-urls',
  CODEX_OAUTH_TOKEN_URL: 'main',
  CODEX_OAUTH_CLIENT_ID: 'oauth-urls',
  CODEX_OAUTH_SCOPE: 'oauth-urls',
  CLAUDE_OAUTH_AUTHORIZE_URL: 'oauth-urls',
  CLAUDE_OAUTH_TOKEN_URL: 'main',
  CLAUDE_OAUTH_CLIENT_ID: 'oauth-urls',
  CLAUDE_OAUTH_SCOPE: 'oauth-urls',
  ZCODE_OAUTH_AUTHORIZE_URL: 'oauth-urls',
  ZCODE_OAUTH_TOKEN_URL: 'main',
  ZCODE_OAUTH_CLIENT_ID: 'oauth-urls',
  MANUAL_CALLBACK_OAUTH_TTL_MS: 'main',
  AUTH_PROGRESS_STATES: 'job',
  OAUTH_ARTIFACT_PATH_OVERRIDES: 'oauth-tokens',
};

const domainMap = {};
segments.forEach((seg) => {
  if (seg.kind === 'let') { domainMap[seg.name] = 'utils'; return; }
  if (seg.kind === 'const') {
    if (!constDomainMap[seg.name]) throw new Error(`未归类 const: ${seg.name}@${seg.line}`);
    domainMap[seg.name] = constDomainMap[seg.name] === 'main' ? 'orchestration' : constDomainMap[seg.name];
    return;
  }
  if (orchestrationNames.has(seg.name)) { domainMap[seg.name] = 'orchestration'; return; }
  if (forcedDomainNames[seg.name]) { domainMap[seg.name] = forcedDomainNames[seg.name]; return; }
  if (forcedUtilsNames.has(seg.name)) { domainMap[seg.name] = 'utils'; return; }
  throw new Error(`未归类函数: ${seg.name}@${seg.line}`);
});

const DOMAINS = new Set(['auth-mode', 'job', 'oauth-tokens', 'oauth-browser', 'oauth-urls', 'account-config']);

// ---------- 4. 引用完整性校验 ----------
const problems = [];
for (const seg of segments) {
  const dom = domainMap[seg.name];
  if (!DOMAINS.has(dom)) continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainMap[ref];
    if (refDom === undefined || refDom === dom || refDom === 'utils') continue;
    problems.push(`${seg.kind} ${seg.name}@${seg.line} -> ${ref} (${refDom})`);
  }
}
for (const seg of segments) {
  if (domainMap[seg.name] !== 'utils') continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainMap[ref];
    if (DOMAINS.has(refDom) || refDom === 'orchestration') {
      problems.push(`utils ${seg.kind} ${seg.name} -> domain ${ref} (${refDom})`);
    }
  }
}
if (problems.length) {
  console.error('REFERENCE VIOLATIONS:');
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

// ---------- 5. 生成各域文件 ----------
const domainOrder = ['utils', 'auth-mode', 'job', 'oauth-tokens', 'oauth-browser', 'oauth-urls', 'account-config'];
const outDir = path.join(__dirname, '..', 'lib', 'server');
const header = `'use strict';\n// GENERATED BY web-account-auth-split script — do not edit manually.\n// Behavior-preserving extraction from web-account-auth.js.\n\n`;

const headLines = lines.slice(0, segments[0].line - 1);
const headRequires = [];
{
  const headText = headLines.join('\n');
  const re = /const\s+(\{[^}]*\}|[A-Za-z0-9_$]+)\s*=\s*require\((['"])([^'"]+)\2\)\s*;?/g;
  let m;
  while ((m = re.exec(headText)) !== null) {
    const binds = [];
    const lhs = m[1];
    if (lhs.startsWith('{')) {
      for (const part of lhs.slice(1, -1).split(',')) {
        const p = part.trim();
        if (!p) continue;
        const am = p.match(/^([A-Za-z0-9_$]+)(?:\s*:\s*([A-Za-z0-9_$]+))?$/);
        if (am) binds.push(am[2] || am[1]);
      }
    } else {
      binds.push(lhs.trim());
    }
    if (binds.length) headRequires.push({ text: m[0], binds, module: m[3] });
  }
}

function usedIdentifiers(segmentsInDomain) {
  const used = new Set();
  const headBinds = headRequires.flatMap((r) => r.binds);
  for (const seg of segmentsInDomain) {
    const body = stripCode(lines.slice(seg.line - 1, seg.end).join('\n'));
    for (const name of allNames) {
      if (name !== seg.name && new RegExp('\\b' + name + '\\b').test(body)) used.add(name);
    }
    for (const name of headBinds) {
      if (new RegExp('\\b' + name + '\\b').test(body)) used.add(name);
    }
    const extNames = ['path', 'fs', 'os', 'StringDecoder', 'crypto', 'zlib', 'spawnSync'];
    for (const n of extNames) {
      if (new RegExp('\\b' + n + '\\b').test(body)) used.add(n);
    }
  }
  return used;
}

const files = {};
for (const dom of domainOrder) {
  const members = segments.filter((s) => domainMap[s.name] === dom);
  if (!members.length) continue;
  const used = usedIdentifiers(members);
  const neededReqs = headRequires.filter((r) => r.binds.some((b) => used.has(b)));
  const utilsRefs = dom !== 'utils' && files.utils
    ? files.utils.members.filter((m) => used.has(m))
    : [];
  const body = members.map((seg) => lines.slice(seg.line - 1, seg.end).join('\n')).join('\n\n');
  const headerReqs = neededReqs.map((r) => r.text).join('\n');
  const utilsRequire = utilsRefs.length
    ? `const { ${utilsRefs.join(', ')} } = require('./web-account-auth-utils');`
    : '';
  files[dom] = {
    members: members.map((m) => m.name),
    source: header +
      [headerReqs, utilsRequire].filter(Boolean).join('\n') + '\n\n' +
      body + '\n\n' +
      `module.exports = { ${members.map((m) => m.name).join(', ')} };\n`
  };
}

// ---------- 6. 主文件重写 ----------
const movedNames = new Set(domainOrder.flatMap((d) => (files[d] ? files[d].members : [])));
const keepSegments = segments.filter((s) => !movedNames.has(s.name));

const headEnd = segments[0].line - 1;
let newMain = lines.slice(0, headEnd).join('\n') + '\n';

const requireLines = domainOrder
  .filter((d) => files[d] && d !== 'utils')
  .map((d) => `const { ${files[d].members.join(', ')} } = require('./web-account-auth-${d}');`)
  .join('\n');
const utilsMembers = files.utils ? files.utils.members : [];
if (utilsMembers.length) {
  newMain += `const { ${utilsMembers.join(', ')} } = require('./web-account-auth-utils');\n`;
}
if (requireLines) newMain += requireLines + '\n';

let newTail = src.slice(tailIdx);

keepSegments.forEach((seg) => {
  const end = tailLine > 0 ? Math.min(seg.end, tailLine - 1) : seg.end;
  newMain += lines.slice(seg.line - 1, end).join('\n') + '\n';
});
newMain += newTail;

// ---------- 7. 写出 ----------
for (const [dom, file] of Object.entries(files)) {
  const outPath = path.join(outDir, `web-account-auth-${dom}.js`);
  fs.writeFileSync(outPath, file.source);
  console.log(`wrote ${outPath} (${file.members.length} symbols)`);
}
fs.writeFileSync(SRC, newMain);
console.log(`rewrote ${SRC} (kept ${keepSegments.length} symbols, removed ${movedNames.size})`);
console.log('OK');