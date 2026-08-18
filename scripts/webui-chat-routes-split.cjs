#!/usr/bin/env node
/**
 * webui-chat-routes.js 按功能域拆分辅助脚本（一次性工具，用完即弃）
 *
 * 输入: lib/server/webui-chat-routes.js (2486 行, 52 函数)
 * 输出:
 *   - lib/server/webui-chat-routes-utils.js            共享工具
 *   - lib/server/webui-chat-routes-project.js          项目上下文构建域
 *   - lib/server/webui-chat-routes-native-session.js   原生会话/凭据域
 *   - lib/server/webui-chat-routes-opencode-proxy.js   OpenCode API 代理域
 *   - lib/server/webui-chat-routes-claude-compat.js    Anthropic 兼容 Claude 域
 *   - lib/server/webui-chat-routes-cli-confirm.js      CLI 安装确认域
 *   - 主文件保留: 10 个 handle* 编排函数 + module.exports
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

const SRC = path.join(__dirname, '..', 'lib', 'server', 'webui-chat-routes.js');
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
const nameSet = new Set(allNames);
const refsOf = {};
segments.forEach((seg) => {
  const body = stripCode(lines.slice(seg.line - 1, seg.end).join('\n'));
  refsOf[seg.name] = allNames.filter((n) => n !== seg.name && new RegExp('\\b' + n + '\\b').test(body));
});

// ---------- 3. 域归类 ----------
const orchestrationNames = new Set([
  'handleGetSlashCommandsRequest',
  'handleGetChatAttachmentRequest',
  'handleNativeChatRunInputRequest',
  'handleNativeChatRunResizeRequest',
  'handleNativeChatRunListRequest',
  'handleNativeChatRunAbortRequest',
  'handleNativeApprovalInboundRequest',
  'handleNativeApprovalDecisionRequest',
  'handleCliInstallConfirmationDecisionRequest',
  'handleChatRequest'
]);

const forcedDomainNames = {
  // --- project 域: 项目上下文构建 ---
  sanitizeClaudeProjectDirName: 'project',
  resolveNativeProjectDirName: 'project',
  truncateText: 'project',
  listProjectRootEntries: 'project',
  readProjectTextFile: 'project',
  buildPackageJsonSummary: 'project',
  buildProjectContextMessage: 'project',
  injectProjectContextMessage: 'project',
  // --- native-session 域: 原生会话/凭据/事件 ---
  resolveNativeFallbackAccountRefs: 'native-session',
  resolveRuntimeApiKeyMode: 'native-session',
  nativeAccountHasCredentials: 'native-session',
  recordNativeSessionModelUsage: 'native-session',
  normalizeNativeSessionModel: 'native-session',
  resolveNativeAliasModel: 'native-session',
  publishNativeSessionEvent: 'native-session',
  waitForNativeSessionTranscriptReadable: 'native-session',
  refreshProjectsSnapshotAfterNativeSession: 'native-session',
  detectApiKeyMode: 'native-session',
  // --- opencode-proxy 域: OpenCode API 代理 ---
  getOpenCodeSessionHostHome: 'opencode-proxy',
  toOpenAiHistoryMessages: 'opencode-proxy',
  appendCurrentUserMessage: 'opencode-proxy',
  buildOpenCodeApiProxyMessages: 'opencode-proxy',
  beginOpenCodeApiProxyTurn: 'opencode-proxy',
  completeOpenCodeApiProxyTurn: 'opencode-proxy',
  requireOpenCodeTurnSessionId: 'opencode-proxy',
  resolveApiProxyJsonSessionId: 'opencode-proxy',
  buildApiProxyMessages: 'opencode-proxy',
  createOpenAiChunkAdapter: 'opencode-proxy',
  // --- claude-compat 域: Anthropic 兼容 Claude ---
  readClaudeApiSettings: 'claude-compat',
  isAnthropicCompatibleClaudeBaseUrl: 'claude-compat',
  buildAnthropicMessagesPayload: 'claude-compat',
  extractAnthropicTextFromResponse: 'claude-compat',
  handleClaudeAnthropicCompatibleChat: 'claude-compat',
  // --- cli-confirm 域: CLI 安装确认 ---
  resolveCliInstallConfirmationRegistry: 'cli-confirm',
  resolveCliInstallConfirmationTimeoutMs: 'cli-confirm',
  requestCliInstallConfirmation: 'cli-confirm',
};

const forcedUtilsNames = new Set([
  'parseJsonFileSafe',
  'normalizeString',
  'canonicalizeChatPayload',
  'finishStartedChatStream',
  'humanizeUpstreamError',
  'attachAbortableRequestClose'
]);

const domainMap = {};
segments.forEach((seg) => {
  if (seg.kind === 'let' || seg.kind === 'const') { domainMap[seg.name] = 'utils'; return; }
  if (orchestrationNames.has(seg.name)) { domainMap[seg.name] = 'orchestration'; return; }
  if (forcedDomainNames[seg.name]) { domainMap[seg.name] = forcedDomainNames[seg.name]; return; }
  if (forcedUtilsNames.has(seg.name)) { domainMap[seg.name] = 'utils'; return; }
  throw new Error(`未归类函数: ${seg.name}@${seg.line}`);
});

const DOMAINS = new Set(['project', 'native-session', 'opencode-proxy', 'claude-compat', 'cli-confirm']);

// 迭代闭包:
//   - 被 ≥2 个域引用的函数强制回 utils
//   - 域函数引用的 utils 函数若仅被本域引用, 拉入本域
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
    if (doms.size >= 2 && domainMap[ref] !== 'utils') { domainMap[ref] = 'utils'; changed = true; }
  }
  for (const [ref, doms] of domainRefCount) {
    if (doms.size === 1 && domainMap[ref] === 'utils' && !forcedUtilsNames.has(ref)) {
      const seg = segments.find((s) => s.name === ref);
      if (seg && seg.kind !== 'const' && seg.kind !== 'let') {
        domainMap[ref] = [...doms][0];
        changed = true;
      }
    }
  }
}

// ---------- 4. 引用完整性校验 ----------
const problems = [];
for (const seg of segments) {
  const dom = domainMap[seg.name];
  if (!DOMAINS.has(dom)) continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainMap[ref];
    if (refDom === undefined || refDom === dom || refDom === 'utils') continue;
    problems.push(`${seg.name}@${seg.line} -> ${ref} (${refDom})`);
  }
}
for (const seg of segments) {
  if (domainMap[seg.name] !== 'utils') continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainMap[ref];
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
const domainOrder = ['utils', 'project', 'native-session', 'opencode-proxy', 'claude-compat', 'cli-confirm'];
const outDir = path.join(__dirname, '..', 'lib', 'server');
const header = `'use strict';\n// GENERATED BY webui-chat-routes-split script — do not edit manually.\n// Behavior-preserving extraction from webui-chat-routes.js.\n\n`;

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
    ? `const { ${utilsRefs.join(', ')} } = require('./webui-chat-routes-utils');`
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
  .map((d) => `const { ${files[d].members.join(', ')} } = require('./webui-chat-routes-${d}');`)
  .join('\n');
const utilsMembers = files.utils ? files.utils.members : [];
if (utilsMembers.length) {
  newMain += `const { ${utilsMembers.join(', ')} } = require('./webui-chat-routes-utils');\n`;
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
  const outPath = path.join(outDir, `webui-chat-routes-${dom}.js`);
  fs.writeFileSync(outPath, file.source);
  console.log(`wrote ${outPath} (${file.members.length} symbols)`);
}
fs.writeFileSync(SRC, newMain);
console.log(`rewrote ${SRC} (kept ${keepSegments.length} symbols, removed ${movedNames.size})`);
console.log('OK');