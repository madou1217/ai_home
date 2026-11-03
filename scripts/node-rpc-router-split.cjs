#!/usr/bin/env node
/**
 * node-rpc-router.js 按功能域拆分辅助脚本（一次性工具，用完即弃）
 *
 * 输入: lib/server/node-rpc-router.js
 * 输出:
 *   - lib/server/node-rpc-router-utils.js          共享工具/常量
 *   - lib/server/node-rpc-router-device-node.js    远程节点会话代理
 *   - lib/server/node-rpc-router-session.js        设备/节点直连会话
 *   - lib/server/node-rpc-router-join.js           节点加入
 *   - lib/server/node-rpc-router-provider-account.js 账号 reauth/auth-job
 *   - lib/server/node-rpc-router-profile-status.js 设备描述/状态/诊断
 *   - 主文件保留: 编排层 handleNodeRpcRequest + 公共导出
 *
 * 安全约束:
 *   - 只按行号区间原样搬移函数体，不重写任何逻辑
 *   - 搬移前做静态引用校验: 每个被搬函数引用的顶层函数名必须属于
 *     同模块 ∪ utils ∪ 主文件保留集(会 re-export) ∪ 外部模块
 *   - 失败即退出, 不产生任何写操作
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'lib', 'server', 'node-rpc-router.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

// ---------- 1. 解析顶层声明（function / generator / const / let 变量） ----------
const decls = [];
lines.forEach((l, i) => {
  const fn = l.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/);
  if (fn) {
    decls.push({ kind: 'function', name: fn[1], line: i + 1 });
    return;
  }
  const cs = l.match(/^const\s+([A-Za-z0-9_$]+)\s*=\s*(?!\s*require\()/);
  if (cs) {
    decls.push({ kind: 'const', name: cs[1], line: i + 1 });
    return;
  }
  // 注意: let 声明可能无初始化 (`let ProxyAgentClass;`)
  const ls = l.match(/^let\s+([A-Za-z0-9_$]+)\b/);
  if (ls) {
    decls.push({ kind: 'let', name: ls[1], line: i + 1 });
  }
});

// 段区间: 声明行到下一个声明行之前
const segments = decls.map((d, idx) => {
  const end = idx + 1 < decls.length ? decls[idx + 1].line - 1 : lines.length;
  return { ...d, end };
});

// 尾部 module.exports 块起始行: 所有段的引用分析与搬移 body 都截断到它之前,
// 避免最后一个段把导出块内容(或引用)一并算入
const tailIdx = src.lastIndexOf('module.exports = {');
const tailLine = tailIdx >= 0 ? src.slice(0, tailIdx).split('\n').length : -1; // 1-based 行号
if (tailIdx < 0) {
  console.error('module.exports tail not found');
  process.exit(1);
}
segments.forEach((s) => { s.end = Math.min(s.end, tailLine - 1); });

// ---------- 2. 引用分析（剥离注释/字符串后的词法引用） ----------
function stripCode(body) {
  // 字符级状态机: 跳过注释/字符串/正则字面量, 保留模板插值 ${...} 内的代码
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    const d = body[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && body[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === c) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === '`') { i++; break; }
        if (body[i] === '$' && body[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
            else if (body[j] === '`') {
              j++;
              while (j < n && body[j] !== '`') {
                if (body[j] === '\\') j += 2;
                else j++;
              }
            }
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
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n) {
          if (body[j] === '\\') { j += 2; continue; }
          if (body[j] === '\n') break;
          if (body[j] === '[') inClass = true;
          else if (body[j] === ']') inClass = false;
          else if (body[j] === '/' && !inClass) { j++; ok = true; break; }
          j++;
        }
        if (ok) {
          while (j < n && /[a-z]/i.test(body[j])) j++;
          i = j;
          out += ' ';
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}
const allNames = decls.map((d) => d.name);
const nameSet = new Set(allNames);
const refsOf = {};
segments.forEach((seg) => {
  const body = stripCode(lines.slice(seg.line - 1, seg.end).join('\n'));
  refsOf[seg.name] = allNames.filter((n) => n !== seg.name && new RegExp('\\b' + n + '\\b').test(body));
});

// ---------- 3. 域归类 ----------
// 编排层白名单: 跨域编排的公共 API（留在主文件, 主文件 require 各域模块后可直接调用域函数）
const orchestrationNames = new Set([
  'handleNodeRpcRequest'
]);

// 功能域强制归属: 按实现归属明确指定每个函数
const forcedDomainNames = {
  // --- device-node 域: 远程节点会话代理(handler + path/payload 构建 + 响应归一化) ---
  handleDeviceNodesRequest: 'device-node',
  nodeIdFromUrl: 'device-node',
  nodeIdFromPayload: 'device-node',
  buildDeviceNodeSessionMessagesPath: 'device-node',
  buildDeviceNodeSessionsPath: 'device-node',
  buildDeviceNodeSessionCatalogPath: 'device-node',
  buildDeviceNodeSessionStreamPath: 'device-node',
  buildDeviceNodeSessionInputPayload: 'device-node',
  buildDeviceNodeSessionResumePath: 'device-node',
  cursorFromRemoteSessionFrame: 'device-node',
  deviceNodeStreamReconnects: 'device-node',
  deviceNodeStreamReconnectDelayMs: 'device-node',
  isRetryableRemoteStreamError: 'device-node',
  waitForDeviceNodeStreamReconnect: 'device-node',
  isWritableResponse: 'device-node',
  normalizeRemoteSessionStreamChunk: 'device-node',
  normalizeRemoteTransportEvidence: 'device-node',
  normalizeRemoteSessionEnvelope: 'device-node',
  normalizeRemoteSessionMessagesResult: 'device-node',
  normalizeRemoteSessionsResult: 'device-node',
  normalizeRemoteSessionCatalogResult: 'device-node',
  normalizeRemoteSessionAttachResult: 'device-node',
  normalizeRemoteSessionCommandResult: 'device-node',
  normalizeRemoteSessionAckResult: 'device-node',
  normalizeRemoteSessionArtifactResult: 'device-node',
  normalizeRemoteSessionInputResult: 'device-node',
  normalizeRemoteSessionStartResult: 'device-node',
  normalizeRemoteSessionRunEventsResult: 'device-node',
  normalizeRemoteSessionRunInputResult: 'device-node',
  normalizeRemoteSessionRunAbortResult: 'device-node',
  handleDeviceNodeSessionsRequest: 'device-node',
  handleDeviceNodeSessionCatalogRequest: 'device-node',
  handleDeviceNodeSessionMessagesRequest: 'device-node',
  handleDeviceNodeSessionInputRequest: 'device-node',
  buildDeviceNodeSessionStartPayload: 'device-node',
  buildDeviceNodeSessionRunEventsPath: 'device-node',
  buildDeviceNodeSessionArtifactPath: 'device-node',
  buildDeviceNodeSessionRunInputPayload: 'device-node',
  buildDeviceNodeSessionRunAbortPayload: 'device-node',
  buildDeviceNodeSessionAttachPayload: 'device-node',
  buildDeviceNodeSessionAckPayload: 'device-node',
  runIdFromUrl: 'device-node',
  runIdFromPayload: 'device-node',
  handleDeviceNodeSessionStartRequest: 'device-node',
  handleDeviceNodeSessionAttachRequest: 'device-node',
  handleDeviceNodeSessionCommandRequest: 'device-node',
  handleDeviceNodeSessionAckRequest: 'device-node',
  handleDeviceNodeSessionRunEventsRequest: 'device-node',
  handleDeviceNodeSessionArtifactRequest: 'device-node',
  handleDeviceNodeSessionRunInputRequest: 'device-node',
  handleDeviceNodeSessionRunAbortRequest: 'device-node',
  streamDeviceNodeSessionWithResume: 'device-node',
  handleDeviceNodeSessionStreamRequest: 'device-node',
  // --- session 域: 设备/节点直连会话 + authorized 共享会话 ---
  loadDeviceProjectsSnapshot: 'session',
  handleDeviceSessionsRequest: 'session',
  handleNodeSessionsRequest: 'session',
  handleNodeSessionCatalogRequest: 'session',
  getSessionReaderDeps: 'session',
  handleAuthorizedSessionMessagesRequest: 'session',
  getSessionCatalogDeps: 'session',
  handleDeviceSessionMessagesRequest: 'session',
  handleNodeSessionMessagesRequest: 'session',
  handleDeviceSessionEventsRequest: 'session',
  buildSessionStreamPayload: 'session',
  writeSessionStreamFrame: 'session',
  handleAuthorizedSessionStreamRequest: 'session',
  handleDeviceSessionStreamRequest: 'session',
  handleNodeSessionStreamRequest: 'session',
  handleNodeSessionInputRequest: 'session',
  handleNodeSessionStartRequest: 'session',
  handleNodeSessionAttachRequest: 'session',
  handleNodeSessionCommandRequest: 'session',
  handleNodeSessionAckRequest: 'session',
  handleNodeSessionRunEventsRequest: 'session',
  handleNodeSessionArtifactRequest: 'session',
  handleNodeSessionRunInputRequest: 'session',
  handleNodeSessionRunAbortRequest: 'session',
  buildDeviceSessionsOptions: 'session',
  streamIntervalFromUrl: 'session',
  // --- join 域: 节点加入 ---
  handleNodeJoinRequest: 'join',
  codeFromUrl: 'join',
  joinErrorStatus: 'join',
  // --- provider-account 域: 账号 reauth/auth-job ---
  normalizeProviderSegment: 'provider-account',
  normalizeAccountRefSegment: 'provider-account',
  normalizeAuthJobId: 'provider-account',
  createJsonRelayResponse: 'provider-account',
  parseJsonRelayBody: 'provider-account',
  normalizeProviderAuthJobWaitMs: 'provider-account',
  delay: 'provider-account',
  hasActionableAuthJobState: 'provider-account',
  waitForProviderAuthJob: 'provider-account',
  enrichProviderAccountReauthResult: 'provider-account',
  handleDeviceAccountsRequest: 'provider-account',
  handleDeviceProviderAccountReauthRequest: 'provider-account',
  getProviderAuthJobManager: 'provider-account',
  writeProviderAuthJobUnavailable: 'provider-account',
  writeSerializedProviderAuthJob: 'provider-account',
  handleDeviceProviderAccountAuthJobGetRequest: 'provider-account',
  handleDeviceProviderAccountAuthJobCancelRequest: 'provider-account',
  handleDeviceProviderAccountAuthJobCallbackRequest: 'provider-account',
  // --- profile-status 域: 设备描述/状态/诊断 ---
  buildDescriptorForRequest: 'profile-status',
  inferRequestEndpoint: 'profile-status',
  firstHeaderValue: 'profile-status',
  handleDeviceProfileRequest: 'profile-status',
  handleDeviceStatusRequest: 'profile-status',
  shouldIncludeNodeDiagnostics: 'profile-status',
  buildNodeDiagnosticsForRequest: 'profile-status',
  attachNodeDiagnostics: 'profile-status',
};

// 共享工具强制白名单: 跨域共享的公共件(必须留在 utils)
const forcedUtilsNames = new Set([
  'authorizeNodeRpc',
  'writeNodeRpcNotFound',
  'writeNodeRpcForbidden',
  'writePublicNodeRpcHeaders',
  'readJsonPayload',
  'authorizeRemoteClientRequest',
  'isValidSessionRef',
  'writeInvalidSessionRef',
  'sessionRefFromUrl',
  'artifactIdFromUrl',
]);
const domainMap = {}; // name -> domain | 'orchestration' | 'utils'
segments.forEach((seg) => {
  if (seg.kind === 'let' || seg.kind === 'const') {
    // 共享状态/常量统一移入 utils 单例(缓存 Map 必须单例共享), 主文件也从中导入
    domainMap[seg.name] = 'utils';
    return;
  }
  if (orchestrationNames.has(seg.name)) {
    domainMap[seg.name] = 'orchestration';
    return;
  }
  if (forcedDomainNames[seg.name]) {
    domainMap[seg.name] = forcedDomainNames[seg.name];
    return;
  }
  if (forcedUtilsNames.has(seg.name)) {
    domainMap[seg.name] = 'utils';
    return;
  }
  throw new Error(`未归类函数: ${seg.name}@${seg.line}`);
});

// 功能域列表(不含 utils/orchestration)
const DOMAINS = new Set(['device-node', 'session', 'join', 'provider-account', 'profile-status']);

// 迭代闭包:
//   - 被 ≥2 个域引用的函数强制回 utils(共享工具层)
//   - 域函数引用的 utils 函数若仅被本域引用, 拉入本域(专属工具)
//   - 域间不得交叉引用
let changed = true;
let iterations = 0;
while (changed && iterations < 50) {
  changed = false;
  iterations += 1;
  const domainRefCount = new Map();
  for (const seg of segments) {
    const dom = domainMap[seg.name];
    if (!DOMAINS.has(dom)) continue;
    for (const ref of refsOf[seg.name] || []) {
      const refDom = domainMap[ref];
      if (refDom !== 'utils') continue;
      if (!domainRefCount.has(ref)) domainRefCount.set(ref, new Set());
      domainRefCount.get(ref).add(dom);
    }
  }
  for (const [ref, doms] of domainRefCount) {
    if (doms.size >= 2 && domainMap[ref] !== 'utils') {
      domainMap[ref] = 'utils';
      changed = true;
    }
  }
  for (const [ref, doms] of domainRefCount) {
    if (doms.size === 1 && domainMap[ref] === 'utils' && !forcedUtilsNames.has(ref)) {
      const seg = segments.find((s) => s.name === ref);
      if (seg && seg.kind !== 'const' && seg.kind !== 'let') {
        const only = [...doms][0];
        domainMap[ref] = only;
        changed = true;
      }
    }
  }
}

// ---------- 4. 引用完整性校验 ----------
// 规则:
//   - utils 函数不得引用任何域函数(utils 不 require 域模块, 只依赖外部模块)
//   - 域函数不得引用其他域函数或编排函数(域模块独立; 域→utils 合法)
const problems = [];
const domainOf = (name) => domainMap[name];
for (const seg of segments) {
  const dom = domainOf(seg.name);
  if (!DOMAINS.has(dom)) continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainOf(ref);
    if (refDom === undefined || refDom === dom || refDom === 'utils') continue;
    problems.push(`${seg.name}@${seg.line} -> ${ref} (${refDom})`);
  }
}
for (const seg of segments) {
  if (domainOf(seg.name) !== 'utils') continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainOf(ref);
    if (DOMAINS.has(refDom) || refDom === 'orchestration') {
      problems.push(`utils ${seg.name} -> domain ${ref} (${refDom})`);
    }
  }
}

if (problems.length) {
  console.error('REFERENCE VIOLATIONS:');
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

// ---------- 5. 生成各域文件 ----------
const domainOrder = ['utils', 'device-node', 'session', 'join', 'provider-account', 'profile-status'];
const outDir = path.join(__dirname, '..', 'lib', 'server');
const header = `'use strict';\n// GENERATED BY node-rpc-router-split script — do not edit manually.\n// Behavior-preserving extraction from node-rpc-router.js.\n\n`;

// 解析主文件头部 require 语句 → 本地绑定名列表
const headLines = lines.slice(0, segments[0].line - 1);
const headRequires = []; // { text, binds: [names], module }
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

// 计算一个段集合用到的所有标识符(剥离注释/字符串)
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
    ? `const { ${utilsRefs.join(', ')} } = require('./node-rpc-router-utils');`
    : '';
  files[dom] = {
    members: members.map((m) => m.name),
    source: header +
      [headerReqs, utilsRequire].filter(Boolean).join('\n') + '\n\n' +
      body + '\n\n' +
      `module.exports = { ${members.map((m) => m.name).join(', ')} };\n`
  };
}

// 尾部内联 setUndiciHooksForTest → utils 导出函数(它操作 undici 状态, 状态已随 utils 迁移)
{
  const tailText = src.slice(src.lastIndexOf('module.exports = {'));
  const setUndiciMatch = tailText.match(/setUndiciHooksForTest:\s*\(hooks\s*=\s*\{\}\)\s*=>\s*\{([\s\S]*?)\n\s*\}/);
  if (files.utils && setUndiciMatch) {
    const body = setUndiciMatch[1].replace(/^ {6}/gm, '  ');
    files.utils.source = files.utils.source.replace(
      'module.exports = { ',
      `function setUndiciHooksForTest(hooks = {}) {${body}\n}\n\nmodule.exports = { setUndiciHooksForTest, `
    );
    files.utils.members.push('setUndiciHooksForTest');
  }
}

// ---------- 6. 主文件重写: 删除搬走段落, 添加 require ----------
const movedNames = new Set(domainOrder.flatMap((d) => (files[d] ? files[d].members : [])));
const keepSegments = segments.filter((s) => !movedNames.has(s.name));

// 主文件保留段(不含尾部 module.exports) + 原文件头部(require 区)
const headEnd = segments[0].line - 1; // 第一个声明前的内容(imports/常量头)
let newMain = lines.slice(0, headEnd).join('\n') + '\n';

// require 新模块
const requireLines = domainOrder
  .filter((d) => files[d] && d !== 'utils')
  .map((d) => `const { ${files[d].members.join(', ')} } = require('./node-rpc-router-${d}');`)
  .join('\n');
const utilsMembers = files.utils ? files.utils.members : [];
if (utilsMembers.length) {
  newMain += `const { ${utilsMembers.join(', ')} } = require('./node-rpc-router-utils');\n`;
}
if (requireLines) newMain += requireLines + '\n';

// 尾部 module.exports(最后一段之后); 内联 setUndiciHooksForTest 由 utils 导入替代
// (tailIdx/tailLine 已在第 1 节声明)
let newTail = src.slice(tailIdx).replace(
  /setUndiciHooksForTest:\s*\(hooks\s*=\s*\{\}\)\s*=>\s*\{[\s\S]*?\n\s*\}/,
  'setUndiciHooksForTest'
);

// 保留段落(原样; 最后一段的 end 可能延伸到文件末尾包含 module.exports, 截断到尾部块之前, 避免重复)
keepSegments.forEach((seg) => {
  const end = tailLine > 0 ? Math.min(seg.end, tailLine - 1) : seg.end;
  newMain += lines.slice(seg.line - 1, end).join('\n') + '\n';
});

newMain += newTail;

// ---------- 7. 写出 ----------
for (const [dom, file] of Object.entries(files)) {
  const outPath = path.join(outDir, `node-rpc-router-${dom}.js`);
  fs.writeFileSync(outPath, file.source);
  console.log(`wrote ${outPath} (${file.members.length} symbols)`);
}
const mainPath = SRC;
fs.writeFileSync(mainPath, newMain);
console.log(`rewrote ${mainPath} (kept ${keepSegments.length} symbols, removed ${movedNames.size})`);
console.log('OK');
