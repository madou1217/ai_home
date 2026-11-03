#!/usr/bin/env node
/**
 * http-utils.js 按功能域拆分辅助脚本（一次性工具，用完即弃）
 *
 * 输入: lib/server/http-utils.js
 * 输出:
 *   - lib/server/http-utils-utils.js        共享传输层/工具/状态
 *   - lib/server/http-utils-code-assist.js  Code Assist 客户端栈(base-url/headers/project/models)
 *   - lib/server/http-utils-normalize.js    OpenAI→Gemini 消息归一化域
 *   - lib/server/http-utils-session.js      Gemini 会话 key/map 管理域
 *   - lib/server/http-utils-credits.js      credit 决策/诊断域
 *   - lib/server/http-utils-native.js       原生 Gemini 请求构建域
 *   - lib/server/http-utils-sse.js          SSE 流解析域
 *   - lib/server/http-utils-zcode.js        zcode 模型探测域
 *   - lib/server/http-utils-kimi.js         kimi 模型探测域
 *   - 主文件保留: 编排层(4 fetch 端点 + fetchModelsForAccount +
 *     buildGeminiCodeAssistGenerateContext/NativeGenerateContext)、公共导出
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

const SRC = path.join(__dirname, '..', 'lib', 'server', 'http-utils.js');
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
  'fetchGeminiCodeAssistChatCompletion',
  'fetchGeminiCodeAssistGenerateContent',
  'fetchGeminiCodeAssistChatCompletionStream',
  'fetchGeminiCodeAssistGenerateContentStream',
  'fetchModelsForAccount',
  'buildGeminiCodeAssistGenerateContext',
  'buildGeminiCodeAssistNativeGenerateContext',
]);

// 功能域强制归属: 按实现归属明确指定每个函数
const forcedDomainNames = {
  // --- code-assist 域: base-url 解析 + headers 构建 + project 管理 + models 探测 ---
  isLoopbackUrl: 'code-assist',
  isGeminiCodeAssistBaseUrl: 'code-assist',
  isCodeAssistProvider: 'code-assist',
  getCodeAssistBaseUrlOption: 'code-assist',
  getDefaultCodeAssistBaseUrl: 'code-assist',
  shouldUseGeminiCodeAssist: 'code-assist',
  normalizeGeminiBaseUrl: 'code-assist',
  normalizeCodeAssistProviderBaseUrl: 'code-assist',
  resolveProviderBaseUrl: 'code-assist',
  buildGeminiCodeAssistMethodUrl: 'code-assist',
  buildGeminiCodeAssistUserAgent: 'code-assist',
  buildAgyCodeAssistClientVersion: 'code-assist',
  buildAgyCodeAssistPlatformInfo: 'code-assist',
  buildAgyCodeAssistUserAgent: 'code-assist',
  isSafeHeaderValue: 'code-assist',
  setHeaderIfSafe: 'code-assist',
  resolveCodeAssistProviderKey: 'code-assist',
  isAntigravityProviderKey: 'code-assist',
  shouldNormalizeAntigravityGenerateContentEnvelope: 'code-assist',
  buildCodeAssistHeaderOptions: 'code-assist',
  buildCodeAssistInferenceHeaderOptions: 'code-assist',
  buildCodeAssistProjectMetadata: 'code-assist',
  shouldUseAgyCodeAssistClientProfile: 'code-assist',
  createGeminiCodeAssistHeaders: 'code-assist',
  applyGeminiCodeAssistProjectResponse: 'code-assist',
  clearGeminiCodeAssistProjectCache: 'code-assist',
  shouldRetryGeminiCodeAssistProjectWithoutCache: 'code-assist',
  loadGeminiCodeAssistProject: 'code-assist',
  fetchGeminiCodeAssistProject: 'code-assist',
  getCachedCodeAssistModelDescriptors: 'code-assist',
  listCodeAssistDescriptorIds: 'code-assist',
  createCodeAssistModelRequiredError: 'code-assist',
  isCodeAssistPermissionError: 'code-assist',
  shouldUseQuotaCatalogFallback: 'code-assist',
  cacheCodeAssistModelDescriptors: 'code-assist',
  createCodeAssistModelRequestId: 'code-assist',
  fetchGeminiCodeAssistAvailableModelDescriptors: 'code-assist',
  fetchGeminiCodeAssistQuotaModelDescriptors: 'code-assist',
  fetchGeminiCodeAssistModelDescriptors: 'code-assist',
  fetchGeminiCodeAssistModels: 'code-assist',
  resolveCodeAssistDefaultModel: 'code-assist',
  resolveCodeAssistRequestModel: 'code-assist',
  // --- normalize 域: OpenAI→Gemini 消息归一化 ---
  parseJsonObject: 'normalize',
  parseOpenAIToolArguments: 'normalize',
  resolveCodeAssistToolStrategy: 'normalize',
  normalizeOpenAIToolCallsForGeminiParts: 'normalize',
  normalizeCodeAssistFunctionResponseContent: 'normalize',
  normalizeOpenAIToolResultForGeminiPart: 'normalize',
  summarizeToolDeclarations: 'normalize',
  summarizeGeminiOpenAIMessageNormalization: 'normalize',
  summarizeGeminiToolCalls: 'normalize',
  summarizeGeminiToolCallsByCandidate: 'normalize',
  normalizeOpenAIMessagesForGemini: 'normalize',
  mapGeminiFinishReason: 'normalize',
  extractGeminiCandidateText: 'normalize',
  extractGeminiCandidateThoughtText: 'normalize',
  stringifyGeminiFunctionArgs: 'normalize',
  extractGeminiCandidateToolCalls: 'normalize',
  normalizeOpenAIToolsForGemini: 'normalize',
  normalizeOpenAIToolChoiceForGemini: 'normalize',
  extractGeminiCandidates: 'normalize',
  extractGeminiUsageMetadata: 'normalize',
  extractGeminiModelVersion: 'normalize',
  normalizeGeminiGenerateContentEnvelope: 'normalize',
  // --- session 域: Gemini 会话 key/map 管理 ---
  normalizeGeminiExternalSessionKey: 'session',
  isGeminiCodeAssistSessionId: 'session',
  createGeminiCodeAssistSessionId: 'session',
  buildGeminiCodeAssistMessageSessionKey: 'session',
  buildGeminiCodeAssistExternalSessionKey: 'session',
  normalizeGeminiSessionMapEntry: 'session',
  pruneGeminiSessionIdMap: 'session',
  buildGeminiGlobalSessionMapKey: 'session',
  readGeminiSessionMapEntry: 'session',
  writeGeminiSessionMapEntry: 'session',
  findGeminiSessionMapEntry: 'session',
  hashGeminiDiagnosticValue: 'session',
  createGeminiCodeAssistSessionState: 'session',
  buildGeminiCodeAssistSessionState: 'session',
  // --- credits 域: credit 决策/诊断/payload 构建 ---
  getGeminiCodeAssistG1CreditBalance: 'credits',
  normalizeGeminiCodeAssistOverageStrategy: 'credits',
  parseConfiguredModelList: 'credits',
  readCodeAssistCreditEligibleModels: 'credits',
  readBooleanField: 'credits',
  isCodeAssistCreditEligibleModel: 'credits',
  shouldEnableGeminiCodeAssistCredits: 'credits',
  appendGeminiCodeAssistDiagnostic: 'credits',
  resolveCodeAssistCreditFields: 'credits',
  buildCodeAssistGeneratePayload: 'credits',
  createCodeAssistAgentRequestId: 'credits',
  // --- native 域: 原生 Gemini 请求构建 ---
  createNativeGeminiRequestSummary: 'native',
  readNativeGeminiFunctionCall: 'native',
  readNativeGeminiFunctionResponse: 'native',
  readNativeFunctionCallRef: 'native',
  readNativeFunctionResponseId: 'native',
  cloneNativeGeminiFunctionPart: 'native',
  addNativeGeminiFunctionResponseName: 'native',
  isPlainObject: 'native',
  shouldWrapAgyFunctionResponse: 'native',
  wrapAgyFunctionResponsePart: 'native',
  addNativeGeminiToolCallThoughtSignature: 'native',
  resolveNativeFunctionResponseName: 'native',
  repairNativeGeminiCodeAssistContents: 'native',
  buildNativeGeminiCodeAssistRequest: 'native',
  buildDefaultGeminiCodeAssistGenerationConfig: 'native',
  resolveCodeAssistRequestSessionIdField: 'native',
  // --- sse 域 ---
  iterateStreamChunks: 'sse',
  parseSseJsonStream: 'sse',
  // --- zcode 域 ---
  fetchZcodePlanBalanceModels: 'zcode',
  fetchZcodePaasModels: 'zcode',
  // --- kimi 域 ---
  toKimiProbedModelDescriptor: 'kimi',
  attachKimiProbedModelDescriptors: 'kimi',
};

// 共享工具强制白名单: 传输层/公共工具（被多域引用, 必须留在 utils）
const forcedUtilsNames = new Set([
  'pickFirstNonEmpty',
  'parseNoProxyList',
  'isLoopbackHost',
  'matchesNoProxyRule',
  'shouldBypassProxy',
  'resolveProxyConfig',
  'tryRequireProxyAgent',
  'defaultInstallUndiciPackage',
  'tryInstallUndiciPackage',
  'getProxyDispatcher',
  'getErrorCode',
  'shouldRetryWithoutProxy',
  'parseAuthorizationBearer',
  'readRequestBody',
  'writeJson',
  'withTimeout',
  'fetchWithTimeout',
  'toGeminiTextPart',
  'buildChatCompletionPayload',
  'writeSseChatCompletion',
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
const DOMAINS = new Set(['code-assist', 'normalize', 'session', 'credits', 'native', 'sse', 'zcode', 'kimi']);

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
const domainOrder = ['utils', 'code-assist', 'normalize', 'session', 'credits', 'native', 'sse', 'zcode', 'kimi'];
const outDir = path.join(__dirname, '..', 'lib', 'server');
const header = `'use strict';\n// GENERATED BY http-utils-split script — do not edit manually.\n// Behavior-preserving extraction from http-utils.js.\n\n`;

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
    ? `const { ${utilsRefs.join(', ')} } = require('./http-utils-utils');`
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
  .map((d) => `const { ${files[d].members.join(', ')} } = require('./http-utils-${d}');`)
  .join('\n');
const utilsMembers = files.utils ? files.utils.members : [];
if (utilsMembers.length) {
  newMain += `const { ${utilsMembers.join(', ')} } = require('./http-utils-utils');\n`;
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
  const outPath = path.join(outDir, `http-utils-${dom}.js`);
  fs.writeFileSync(outPath, file.source);
  console.log(`wrote ${outPath} (${file.members.length} symbols)`);
}
const mainPath = SRC;
fs.writeFileSync(mainPath, newMain);
console.log(`rewrote ${mainPath} (kept ${keepSegments.length} symbols, removed ${movedNames.size})`);
console.log('OK');
