#!/usr/bin/env node
/**
 * native-session-chat.js 按功能域拆分辅助脚本（一次性工具，用完即弃）
 *
 * 输入: lib/server/native-session-chat.js
 * 输出:
 *   - lib/server/native-session-chat-utils.js        共享纯工具/常量
 *   - lib/server/native-session-chat-pty.js          PTY 输入域
 *   - lib/server/native-session-chat-failure.js      失败/运行时阻断域
 *   - lib/server/native-session-chat-sessions.js     会话文件发现/推断域
 *   - lib/server/native-session-chat-env.js          账号环境/运行时解析域
 *   - lib/server/native-session-chat-command.js      CLI 命令构建域
 *   - lib/server/native-session-chat-launch.js       CLI 启动就绪域
 *   - lib/server/native-session-chat-stream.js       流事件解析域
 *   - lib/server/native-session-chat-transcript.js   转录等待/回复收集域
 *   - lib/server/native-session-chat-agy.js          agy 专属域
 *   - lib/server/native-session-chat-codex-index.js  codex 会话索引域
 *   - 主文件保留: 编排层(spawnNativeSessionStream/runNativeSessionPrompt/
 *     ensureAgySessionProjectIndex/waitForOfficialTranscriptTurn)、公共导出
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

const SRC = path.join(__dirname, '..', 'lib', 'server', 'native-session-chat.js');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

// ---------- 1. 解析顶层声明（function / generator / const 变量） ----------
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
  const ls = l.match(/^let\s+([A-Za-z0-9_$]+)\s*=/);
  if (ls) {
    decls.push({ kind: 'let', name: ls[1], line: i + 1 });
  }
});

// 段区间: 声明行到下一个声明行之前
const segments = decls.map((d, idx) => {
  const end = idx + 1 < decls.length ? decls[idx + 1].line - 1 : lines.length;
  return { ...d, end };
});

// ---------- 2. 引用分析（剥离注释/字符串后的词法引用） ----------
function stripCode(body) {
  // 字符级状态机: 跳过注释/字符串/正则字面量, 保留模板插值 ${...} 内的代码
  let out = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const c = body[i];
    const d = body[i + 1];
    // 行注释
    if (c === '/' && d === '/') {
      while (i < n && body[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    // 块注释
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // 单/双引号字符串
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
    // 模板字符串: 递归处理插值
    if (c === '`') {
      i++;
      while (i < n) {
        if (body[i] === '\\') { i += 2; continue; }
        if (body[i] === '`') { i++; break; }
        if (body[i] === '$' && body[i + 1] === '{') {
          // 找到匹配的 } 并递归处理插值表达式
          let depth = 1;
          let j = i + 2;
          while (j < n && depth > 0) {
            if (body[j] === '{') depth++;
            else if (body[j] === '}') depth--;
            else if (body[j] === '`') {
              // 嵌套模板: 跳过
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
    // 正则字面量: 前面是运算符/括号/逗号/冒号/return 等
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
          // 跳过 flags
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
// 编排层白名单: 真正跨域编排的公共 API（留在主文件, 主文件 require 各域模块后可直接调用域函数）
const orchestrationNames = new Set([
  'spawnNativeSessionStream',
  'runNativeSessionPrompt',
  'ensureAgySessionProjectIndex',
  'waitForOfficialTranscriptTurn',
]);

// 功能域: 名称含域关键字即归域
const domainKeywords = [
  { domain: 'pty', kw: /PtyInput|WritePty/ },
  { domain: 'failure', kw: /Failure|Blocker|RuntimeBlock|StripAnsi|TerminalText/ },
  { domain: 'sessions', kw: /Session|SearchText|FilePreview|WalkFiles|StateDb|ProjectSession|GeminiSession|AgySession|ProviderSession|CreatedSessionId/ },
  { domain: 'env', kw: /AccountEnv|ProviderRuntime|ProviderEnv/ },
  { domain: 'command', kw: /Command|ResumeCommand|StartCommand|HeadlessStream|StreamJson|Tmux|RunsAiHome|ShellSingle|NativeRun|ConfigDirArgs|ImageMedia|ClaudeStreamJson/ },
  { domain: 'launch', kw: /CliLaunch|ReadyForChat/ },
  { domain: 'stream', kw: /StreamEvent|Delta|AssistantText|ItemToTool/ },
  { domain: 'transcript', kw: /SessionUpdate|AssistantReply|AssistantAddition|ReaderOptions/ },
  { domain: 'agy', kw: /Agy|ProjectId/ },
  { domain: 'codex-index', kw: /CodexThreadName|CodexSessionIndex/ },
];
// 域强制归属: 名称无关键字但实现属于特定功能域
const forcedDomainNames = {
  buildPtyInputChunks: 'pty',
  writePtyInput: 'pty',
  stripAnsi: 'failure',
  sanitizeTerminalText: 'failure',
  classifyNativeSessionFailure: 'failure',
  classifyNativeAccountRuntimeBlocker: 'failure',
  recordNativeAccountRuntimeBlocker: 'failure',
  buildNativeAccountRuntimeBaseState: 'failure',
  hasActiveNativeAccountRuntimeBlock: 'failure',
  recordNativeAccountRuntimeSuccess: 'failure',
  shouldScanNativeRuntimeBlockerOutput: 'failure',
  getSessionFileMtime: 'sessions',
  normalizeSearchText: 'sessions',
  readFilePreview: 'sessions',
  listClaudeProjectSessionFiles: 'sessions',
  walkFiles: 'sessions',
  listCodexSessionFiles: 'sessions',
  listCodexStateDbFiles: 'sessions',
  inferCodexSessionIdFromStateDb: 'sessions',
  inferClaudeCreatedSessionId: 'sessions',
  readGeminiSessionIdFromFile: 'sessions',
  listGeminiSessionFiles: 'sessions',
  listAgySessionFiles: 'sessions',
  listProviderSessionFiles: 'sessions',
  inferCreatedSessionId: 'sessions',
  loadAccountEnv: 'env',
  loadProviderAccountEnv: 'env',
  resolveNativeProviderRuntime: 'env',
  buildProviderEnv: 'env',
  isOfficialNativeSessionProvider: 'command',
  pushClaudeHeadlessStreamArgs: 'command',
  claudeUsesStreamJsonInput: 'command',
  detectImageMediaType: 'command',
  buildClaudeStreamJsonUserMessage: 'command',
  shellSingleQuote: 'command',
  shouldUseTmuxNativeRun: 'command',
  resolveRunsAiHomeDir: 'command',
  buildResumeCommand: 'command',
  buildStartCommand: 'command',
  applyProviderConfigDirArgs: 'command',
  resolveNativeCliLaunch: 'launch',
  ensureNativeCliReadyForChat: 'launch',
  computeDelta: 'stream',
  extractClaudeAssistantText: 'stream',
  codexItemToTool: 'stream',
  parseNativeStreamEvent: 'stream',
  waitForSessionUpdate: 'transcript',
  collectAssistantReply: 'transcript',
  hasAssistantAddition: 'transcript',
  buildSessionReaderOptions: 'transcript',
  startAgyWarmResume: 'agy',
  startAgyColdAfterQuiesce: 'agy',
  agySessionProjectIndexPath: 'agy',
  readAgySessionProjectIndex: 'agy',
  resolveAgyProjectId: 'agy',
  deriveCodexThreadName: 'codex-index',
  ensureCodexSessionIndexEntry: 'codex-index',
};

// 共享工具强制白名单: 无论被谁引用都留在 utils(通用基础能力)
const forcedUtilsNames = new Set(['normalizeString']);
const domainMap = {}; // name -> domain | 'consts' | 'orchestration' | 'utils'
segments.forEach((seg) => {
  if (seg.kind === 'let') {
    // let 状态(懒加载 ctor)跟随其 getter 所在模块(utils)
    domainMap[seg.name] = 'utils';
    return;
  }
  if (seg.kind === 'const') {
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
  const hit = domainKeywords.find((r) => r.kw.test(seg.name));
  domainMap[seg.name] = hit ? hit.domain : 'utils';
});

// 功能域列表(不含 utils/orchestration)
const DOMAINS = new Set(['pty', 'failure', 'sessions', 'env', 'command', 'launch', 'stream', 'transcript', 'agy', 'codex-index']);

// 迭代闭包:
//   - 被 ≥2 个域引用的函数强制回 utils(共享工具层)
//   - 域函数引用的 utils 函数若仅被本域引用, 拉入本域(专属工具)
//   - 域间不得交叉引用
let changed = true;
let iterations = 0;
while (changed && iterations < 50) {
  changed = false;
  iterations += 1;
  // 统计当前每个函数被哪些域引用
  const domainRefCount = new Map();
  for (const seg of segments) {
    const dom = domainMap[seg.name];
    if (!DOMAINS.has(dom)) continue;
    for (const ref of refsOf[seg.name] || []) {
      const refDom = domainMap[ref];
      if (refDom !== 'utils' && refDom !== 'consts') continue;
      if (!domainRefCount.has(ref)) domainRefCount.set(ref, new Set());
      domainRefCount.get(ref).add(dom);
    }
  }
  // 多域共享 → 强制 utils
  for (const [ref, doms] of domainRefCount) {
    if (doms.size >= 2 && domainMap[ref] !== 'utils') {
      domainMap[ref] = 'utils';
      changed = true;
    }
  }
  // 单域专属 utils → 拉入该域(仅函数; const/let 共享状态永远留在 utils 单例)
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
  if (seg.kind === 'const') continue;
  if (!DOMAINS.has(dom)) continue;
  for (const ref of refsOf[seg.name] || []) {
    const refDom = domainOf(ref);
    if (refDom === undefined || refDom === dom || refDom === 'utils') continue;
    problems.push(`${seg.name}@${seg.line} -> ${ref} (${refDom})`);
  }
}
// utils 函数引用域函数 → 不允许
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
const domainOrder = ['utils', 'pty', 'failure', 'sessions', 'env', 'command', 'launch', 'stream', 'transcript', 'agy', 'codex-index'];
const outDir = path.join(__dirname, '..', 'lib', 'server');
const header = `'use strict';\n// GENERATED BY native-session-chat-split script — do not edit manually.\n// Behavior-preserving extraction from native-session-chat.js.\n\n`;

// 解析主文件头部 require 语句 → 本地绑定名列表
const headLines = lines.slice(0, segments[0].line - 1);
const headRequires = []; // { text, binds: [names], module }
{
  const headText = headLines.join('\n');
  // 匹配 const { a, b: c } = require('mod'); 或 const name = require('mod');
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
    const extNames = ['path', 'fs', 'os', 'StringDecoder'];
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
  // 域文件引用 utils 工具 → 生成 utils require(仅列出用到的成员)
  const utilsRefs = dom !== 'utils' && files.utils
    ? files.utils.members.filter((m) => used.has(m))
    : [];
  const body = members.map((seg) => lines.slice(seg.line - 1, seg.end).join('\n')).join('\n\n');
  const headerReqs = neededReqs.map((r) => r.text).join('\n');
  const utilsRequire = utilsRefs.length
    ? `const { ${utilsRefs.join(', ')} } = require('./native-session-chat-utils');`
    : '';
  files[dom] = {
    members: members.map((m) => m.name),
    source: header +
      [headerReqs, utilsRequire].filter(Boolean).join('\n') + '\n\n' +
      body + '\n\n' +
      `module.exports = { ${members.map((m) => m.name).join(', ')} };\n`
  };
}

// ---------- 6. 主文件重写: 删除搬走段落, 添加 require ----------
const movedNames = new Set(domainOrder.flatMap((d) => (files[d] ? files[d].members : [])));
const keepSegments = segments.filter((s) => !movedNames.has(s.name));

// 主文件保留段(不含尾部 module.exports) + 原文件头部(require 区 1-40 行)
const headEnd = segments[0].line - 1; // 第一个声明前的内容(imports/常量头)
let newMain = lines.slice(0, headEnd).join('\n') + '\n';

// require 新模块
const requireLines = domainOrder
  .filter((d) => files[d] && d !== 'utils')
  .map((d) => `const { ${files[d].members.join(', ')} } = require('./native-session-chat-${d}');`)
  .join('\n');
const utilsMembers = files.utils ? files.utils.members : [];
if (utilsMembers.length) {
  newMain += `const { ${utilsMembers.join(', ')} } = require('./native-session-chat-utils');\n`;
}
if (requireLines) newMain += requireLines + '\n';

// 尾部 module.exports(最后一段之后)
const tailIdx = src.lastIndexOf('module.exports = {');
const tailLine = tailIdx >= 0 ? src.slice(0, tailIdx).split('\n').length : -1; // 1-based 行号
if (tailIdx < 0) {
  console.error('module.exports tail not found');
  process.exit(1);
}

// 保留段落(原样; 最后一段的 end 可能延伸到文件末尾包含 module.exports, 截断到尾部块之前, 避免重复)
keepSegments.forEach((seg) => {
  const end = tailLine > 0 ? Math.min(seg.end, tailLine - 1) : seg.end;
  newMain += lines.slice(seg.line - 1, end).join('\n') + '\n';
});

newMain += src.slice(tailIdx);

// ---------- 7. 写出 ----------
for (const [dom, file] of Object.entries(files)) {
  const outPath = path.join(outDir, `native-session-chat-${dom}.js`);
  fs.writeFileSync(outPath, file.source);
  console.log(`wrote ${outPath} (${file.members.length} symbols)`);
}
const mainPath = SRC;
fs.writeFileSync(mainPath, newMain);
console.log(`rewrote ${mainPath} (kept ${keepSegments.length} symbols, removed ${movedNames.size})`);
console.log('OK');