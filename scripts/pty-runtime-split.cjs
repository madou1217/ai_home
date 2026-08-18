#!/usr/bin/env node
'use strict';

/**
 * Split lib/cli/services/pty/runtime.js (2176 lines) into:
 *   - pty-runtime-launch.js  -> createPtyRuntimeLaunchDomain(deps, helpers)
 *   - pty-runtime-spawn.js   -> createPtyRuntimeSpawnDomain(deps, launch, helpers)
 *   - pty-runtime-run.js     -> createPtyRuntimeRunDomain(deps, launch, spawn, helpers)
 *   - runtime.js (main)      -> composition root: options destructure + shared factories + deps + wiring
 *
 * Domain factories are created ONCE inside createPtyRuntime; cross-domain function refs are
 * passed as parameters (launch / spawn) and destructured at the top of each factory so that
 * every moved function body stays byte-identical except two documented lastRuntimeEnv lines.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'cli', 'services', 'pty', 'runtime.js');
const DIR = path.dirname(SRC);
const OUT = (name) => path.join(DIR, name);

// Read the ORIGINAL 2176-line runtime.js from git so the script is re-runnable
// after it has already rewritten the working-tree file.
let source;
const gitShow = spawnSync('git', ['show', 'HEAD:lib/cli/services/pty/runtime.js'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
});
if (gitShow.status === 0 && gitShow.stdout.split('\n').length > 1500) {
  source = gitShow.stdout;
  // eslint-disable-next-line no-console
  console.log(`[split] using original runtime.js from git HEAD (${gitShow.stdout.split('\n').length} lines)`);
} else {
  source = fs.readFileSync(SRC, 'utf8');
}
const lines = source.split('\n'); // 0-indexed; display lines are 1-indexed

function slice1(a, b) {
  // inclusive 1-indexed range -> string
  return lines.slice(a - 1, b).join('\n');
}

// ---------------------------------------------------------------------------
// Lexer-based brace matching (handles strings, comments, template literals)
// ---------------------------------------------------------------------------
function findMatchingBrace(startLineIdx, bracePos) {
  let depth = 0;
  let exprDepth = 0; // nested depth of template ${...} expressions (independent of code braces)
  let inStr = null; // '"' | "'"
  let inTpl = false;
  let inTplExpr = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i];
    inLineComment = false; // line comments never span lines
    for (let j = (i === startLineIdx ? bracePos : 0); j < line.length; j++) {
      const c = line[j];
      const n = line[j + 1];
      if (inLineComment) continue;
      if (inBlockComment) {
        if (c === '*' && n === '/') { inBlockComment = false; j++; }
        continue;
      }
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (inTplExpr) {
        if (c === '\\') { j++; continue; }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === '{') { exprDepth++; continue; }
        if (c === '}') {
          exprDepth--;
          if (exprDepth === 0) { inTplExpr = false; continue; }
        }
        continue;
      }
      if (inTpl) {
        if (c === '\\') { j++; continue; }
        if (c === '`') { inTpl = false; continue; }
        if (c === '$' && n === '{') { inTplExpr = true; exprDepth = 1; j++; continue; }
        continue;
      }
      if (c === '/' && n === '/') { inLineComment = true; j++; continue; }
      if (c === '/' && n === '*') { inBlockComment = true; j++; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '`') { inTpl = true; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  throw new Error(`unbalanced braces from line ${startLineIdx + 1}`);
}

function endOfBlockAt(startLineIdx, openPos) {
  return findMatchingBrace(startLineIdx, openPos) + 1; // 1-indexed inclusive end
}

// ---------------------------------------------------------------------------
// Identifier collector (strings / comments / templates / regex aware)
// ---------------------------------------------------------------------------
function collectRefs(text) {
  const refs = new Set();
  const n = text.length;
  let i = 0;
  let mode = 'code'; // code | str | line | block | tpl | expr
  let strQ = null;
  let returnMode = 'code'; // mode to return to after a string/template closes (code or expr)
  let exprDepth = 0;
  let prevSig = ''; // last significant char in code mode (regex heuristic)

  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c) => /[\w$]/.test(c);

  while (i < n) {
    const c = text[i];
    const nx = text[i + 1];
    if (mode === 'line') {
      if (c === '\n') mode = 'code';
      i++;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && nx === '/') { mode = 'code'; i += 2; } else { i++; }
      continue;
    }
    if (mode === 'str') {
      if (c === '\\') { i += 2; continue; }
      if (c === strQ) { mode = returnMode; }
      i++;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { mode = returnMode; i++; continue; }
      if (c === '$' && nx === '{') { mode = 'expr'; exprDepth = 1; i += 2; continue; }
      i++;
      continue;
    }
    if (mode === 'expr') {
      // expression inside ${...}: collect identifiers, handle strings/braces
      if (c === '\\') { i += 2; continue; }
      if (c === '"' || c === "'") { mode = 'str'; strQ = c; returnMode = 'expr'; i++; continue; }
      if (c === '`') { mode = 'tpl'; returnMode = 'expr'; i++; continue; }
      if (c === '{') { exprDepth++; i++; continue; }
      if (c === '}') {
        exprDepth--;
        if (exprDepth === 0) mode = 'tpl';
        i++;
        continue;
      }
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdentPart(text[j])) j++;
        const tok = text.slice(i, j);
        if (tok.length >= 2 && !/^\d+$/.test(tok)) refs.add(tok);
        i = j;
        continue;
      }
      i++;
      continue;
    }
    // code mode
    if (c === '/' && nx === '/') { mode = 'line'; i += 2; continue; }
    if (c === '/' && nx === '*') { mode = 'block'; i += 2; continue; }
    if (c === '"' || c === "'") { mode = 'str'; strQ = c; returnMode = 'code'; prevSig = c; i++; continue; }
    if (c === '`') { mode = 'tpl'; returnMode = 'code'; prevSig = '`'; i++; continue; }
    if (c === '/' && !/[A-Za-z0-9_$)\]}]$/.test(prevSig) && nx !== '/' && nx !== '*') {
      // regex literal: skip until unescaped '/' (with char class support)
      i++; // consume '/'
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') {
          i++;
          while (i < n && text[i] !== ']') { if (text[i] === '\\') i += 2; else i++; }
          if (i < n) i++; // consume ']'
          continue;
        }
        if (text[i] === '/') { i++; break; }
        i++;
      }
      prevSig = '/';
      continue;
    }
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(text[j])) j++;
      const tok = text.slice(i, j);
      if (tok.length >= 2 && !/^\d+$/.test(tok)) refs.add(tok);
      i = j;
      prevSig = tok[tok.length - 1] || '';
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 1. Parse head requires (lines 1-72)
// ---------------------------------------------------------------------------
const HEAD_END = 72;
const headText = slice1(1, HEAD_END);
const headRequires = []; // { text, spec, binds: [localName...] }
const reRequire = /const \{([\s\S]*?)\} = require\(['"]([^'"]+)['"]\);/g;
let m;
while ((m = reRequire.exec(headText)) !== null) {
  const bindText = m[1];
  const spec = m[2];
  const binds = [];
  for (const part of bindText.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const rm = t.match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/);
    if (rm) binds.push(rm[2] || rm[1]);
  }
  headRequires.push({ text: m[0], spec, binds });
}

// ---------------------------------------------------------------------------
// 2. Parse options destructure (lines 82-128) -> option names
// ---------------------------------------------------------------------------
const OPTIONS_START = 82;
const OPTIONS_END = 128;
const optionText = slice1(OPTIONS_START, OPTIONS_END);
const optionNames = [];
for (const part of optionText.split('\n')) {
  const t = part.trim().replace(/,$/, '');
  if (!t || t === 'const {' || t === '} = options;') continue;
  const m2 = t.match(/^([A-Za-z_$][\w$]*)(?:\s*=.*)?$/);
  if (m2) optionNames.push(m2[1]);
}

// ---------------------------------------------------------------------------
// 3. Locate the 25 inner factory functions (verified start lines, lexer ends)
// ---------------------------------------------------------------------------
const FUNCTION_STARTS = [
  ['isUsageManagedCli', 131],
  ['normalizeLoginForwardArgs', 135],
  ['waitForAihServerReady', 145],
  ['ensureLocalAihServerReady', 149],
  ['buildBuiltinServerProfileEnv', 223],
  ['resolveProviderHookReceiverUrl', 240],
  ['filterHostEnvVars', 250],
  ['normalizeRuntimeForwardArgs', 290],
  ['hasExplicitRemoteArg', 308],
  ['isCodexResumeCommandArgs', 315],
  ['sleepSync', 320],
  ['waitForServerStatusReady', 326],
  ['resolveCodexRemoteProxyConfig', 339],
  ['readSelectedDefaultAccountRef', 358],
  ['getShellDrawerLayout', 379],
  ['resolveProjectionDir', 409],
  ['resolveLaunchRuntimeScope', 424],
  ['resolveRuntimeDir', 447],
  ['spawnPty', 457],
  ['spawnShellDrawerPty', 838],
  ['resolveCliPathWithRuntimeTools', 864],
  ['injectConfigDirArgs', 902],
  ['resolveBundledNpmInstall', 917],
  ['runCliPty', 939],
  ['runCliPtyTracked', 2156],
];

const functions = new Map(); // name -> { start, end, body }
for (const [name, start] of FUNCTION_STARTS) {
  const line = lines[start - 1];
  const openPos = line.lastIndexOf('{'); // function body brace is the last '{' on the signature line
  if (openPos < 0) throw new Error(`no brace on line ${start} for ${name}`);
  const end = endOfBlockAt(start - 1, openPos);
  functions.set(name, { start, end, body: slice1(start, end) });
}

// Verified ends (must match lexer)
const VERIFIED_ENDS = {
  normalizeRuntimeForwardArgs: 301,
  readSelectedDefaultAccountRef: 361,
  getShellDrawerLayout: 399,
  spawnPty: 818,
  spawnShellDrawerPty: 857,
  runCliPty: 2154,
  runCliPtyTracked: 2166,
};
for (const [name, end] of Object.entries(VERIFIED_ENDS)) {
  const got = functions.get(name).end;
  if (got !== end) {
    throw new Error(`end mismatch for ${name}: got ${got}, expected ${end}`);
  }
}
console.log('function ends verified against known values');

// ---------------------------------------------------------------------------
// 4. resolvePtyTermName (73-79) -> module-level in spawn domain
// ---------------------------------------------------------------------------
const RESOLVE_PTY_TERM_NAME = slice1(73, 79);

// ---------------------------------------------------------------------------
// 5. Body-level statements inside createPtyRuntime (between functions)
// ---------------------------------------------------------------------------
const BODY_STMTS = [
  { name: 'createHeadlessSpawn', start: 304, end: 307, domain: 'spawn' },
  { name: 'createCodexLaunchSupport', start: 365, end: 377, domain: 'main' },
  { name: 'createSshClipboardShims', start: 402, end: 407, domain: 'spawn' },
  { name: 'createPersistentLaunchWrapper', start: 823, end: 836, domain: 'main' },
  { name: 'runtimeRootDir', start: 863, end: 863, domain: 'launch' },
];

// ---------------------------------------------------------------------------
// 6. Domain assignment
// ---------------------------------------------------------------------------
const DOMAIN_FNS = {
  launch: [
    'isUsageManagedCli', 'normalizeLoginForwardArgs', 'waitForAihServerReady',
    'ensureLocalAihServerReady', 'buildBuiltinServerProfileEnv',
    'resolveProviderHookReceiverUrl', 'filterHostEnvVars',
    'normalizeRuntimeForwardArgs', 'hasExplicitRemoteArg', 'isCodexResumeCommandArgs',
    'sleepSync', 'waitForServerStatusReady', 'resolveCodexRemoteProxyConfig',
    'readSelectedDefaultAccountRef', 'getShellDrawerLayout', 'resolveProjectionDir',
    'resolveLaunchRuntimeScope', 'resolveRuntimeDir', 'resolveCliPathWithRuntimeTools',
    'injectConfigDirArgs', 'resolveBundledNpmInstall',
  ],
  spawn: ['spawnPty', 'spawnShellDrawerPty'],
  run: ['runCliPty', 'runCliPtyTracked'],
};

const allFnNames = Object.values(DOMAIN_FNS).flat();
if (allFnNames.length !== FUNCTION_STARTS.length) {
  throw new Error(`function count mismatch: ${allFnNames.length} vs ${FUNCTION_STARTS.length}`);
}
for (const n of allFnNames) {
  if (!functions.has(n)) throw new Error(`missing function ${n}`);
}

const SHARED_MEMBERS = {
  codexLaunchSupport: ['resolveLatestCodexThreadIdForCwd', 'buildCodexAutoResumeArgs', 'syncCodexConfigFromHost'],
  persistentWrapper: ['maybeWrapPersistentLaunch', 'reconcileRegistryAfterExit'],
};

// lastRuntimeEnv rewrites: applied per-FUNCTION (not per-domain), 2 lines total
const REWRITES = {
  spawnPty: { from: '    lastRuntimeEnv = envOverrides;', to: '    shared.lastRuntimeEnv = envOverrides;' },
  runCliPty: { from: '      getRuntimeEnv: () => lastRuntimeEnv,', to: '      getRuntimeEnv: () => shared.lastRuntimeEnv,' },
};

const GLOBALS = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer',
  'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'queueMicrotask', 'setImmediate', 'clearImmediate', 'String', 'Number', 'Boolean',
  'Array', 'Object', 'Function', 'Symbol', 'BigInt', 'Math', 'Date', 'JSON', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError',
  'EvalError', 'AggregateError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI',
  'encodeURI', 'decodeURIComponent', 'encodeURIComponent', 'globalThis', 'undefined',
  'NaN', 'Infinity', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal', 'structuredClone', 'performance', 'Intl',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Uint8ClampedArray', 'crypto',
  'node', 'null', 'true', 'false',
]);

// ---------------------------------------------------------------------------
// 7. Per-domain analysis
// ---------------------------------------------------------------------------
// Deterministic word-boundary scan. Over-inclusive (matches comments/strings) but
// that is SAFE for destructuring: extra names from a source object are harmless.
// The lexer-based collectRefs under-collects (misses refs after it drifts into a
// string/template state), which produced fatal missing bindings — word scan cannot
// under-include real usage.
function scanWords(text) {
  const refs = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(text))) {
    const tok = m[0];
    if (tok.length >= 2) refs.add(tok);
  }
  return refs;
}

function domainContent(domain) {
  const parts = [];
  for (const name of DOMAIN_FNS[domain]) {
    parts.push(functions.get(name).body);
  }
  for (const st of BODY_STMTS) {
    if (st.domain === domain) parts.push(slice1(st.start, st.end));
  }
  return parts.join('\n');
}

// Factory parameter names per domain: these shadow deps/helpers and must never be
// pulled from deps (e.g. run's `spawn` param vs deps.spawn option).
const FACTORY_PARAMS = {
  launch: ['deps', 'helpers'],
  spawn: ['deps', 'launch', 'helpers'],
  // NOTE: run's 2nd domain param is `spawnDomain` (NOT `spawn`) so the moved bodies'
  // child_process `spawn` (from deps) keeps its original meaning inside runCliPty.
  run: ['deps', 'launch', 'spawnDomain', 'helpers'],
};

const analysis = {};
for (const domain of ['launch', 'spawn', 'run']) {
  const content = domainContent(domain);
  const refs = scanWords(content);
  const ownFns = new Set(DOMAIN_FNS[domain]);
  const ownBodyNames = new Set(BODY_STMTS.filter((s) => s.domain === domain).map((s) => s.name));

  const paramNames = new Set(FACTORY_PARAMS[domain]);
  const usedOptions = optionNames.filter((n) => refs.has(n) && !paramNames.has(n));
  const neededRequires = headRequires.filter((r) => r.binds.some((b) => refs.has(b)));
  const crossFns = allFnNames.filter((n) => !ownFns.has(n) && refs.has(n));
  const usedMembers = {};
  for (const [holder, members] of Object.entries(SHARED_MEMBERS)) {
    const used = members.filter((m) => refs.has(m));
    if (used.length) usedMembers[holder] = used;
  }

  const localNames = [...ownFns, ...ownBodyNames];
  const extraProvided = domain === 'spawn' ? ['resolvePtyTermName'] : [];
  const provided = new Set([
    ...localNames, ...usedOptions, ...crossFns,
    ...Object.values(usedMembers).flat(),
    ...neededRequires.flatMap((r) => r.binds),
    ...extraProvided,
    ...['deps', 'helpers', 'launch', 'spawn', 'shared', 'codexLaunchSupport', 'persistentWrapper'],
    ...GLOBALS,
  ]);
  const unresolved = [...refs].filter((n) => !provided.has(n)).sort();

  analysis[domain] = { content, usedOptions, neededRequires, crossFns, usedMembers, unresolved };
}

console.log('\n=== per-domain analysis ===');
for (const domain of ['launch', 'spawn', 'run']) {
  const a = analysis[domain];
  console.log(`\n[${domain}]`);
  console.log('  options:', a.usedOptions.join(', '));
  console.log('  requires:', a.neededRequires.map((r) => r.spec).join(', '));
  console.log('  crossFns:', a.crossFns.join(', '));
  console.log('  members:', JSON.stringify(a.usedMembers));
  console.log('  unresolved(warn):', a.unresolved.length ? a.unresolved.join(', ') : '(none)');
}

// ---------------------------------------------------------------------------
// 8. Render helpers
// ---------------------------------------------------------------------------
function renderHeadRequires(reqs) {
  const seen = new Set();
  const blocks = [];
  for (const r of reqs) {
    if (seen.has(r.spec)) continue;
    seen.add(r.spec);
    blocks.push(r.text.trim());
  }
  return blocks.join('\n\n');
}

function renderDepsDestructure(names) {
  if (!names.length) return '';
  return '  const {\n' + names.map((n) => `    ${n},`).join('\n') + '\n  } = deps;';
}

function renderCrossDestructure(param, names) {
  if (!names.length) return '';
  return '  const {\n' + names.map((n) => `    ${n},`).join('\n') + '\n  } = ' + param + ';';
}

function renderMembersDestructure(usedMembers) {
  const blocks = [];
  for (const [holder, members] of Object.entries(usedMembers)) {
    blocks.push('  const {\n' + members.map((m) => `    ${m},`).join('\n') + '\n  } = ' + holder + ';');
  }
  return blocks.join('\n');
}

function renderBodyStatements(domain) {
  return BODY_STMTS
    .filter((s) => s.domain === domain)
    .map((s) => slice1(s.start, s.end))
    .join('\n');
}

function renderFunctions(domain, rewrites) {
  return DOMAIN_FNS[domain]
    .map((name) => {
      let body = functions.get(name).body;
      const rw = rewrites && rewrites[name];
      if (rw) {
        if (!body.includes(rw.from)) {
          throw new Error(`rewrite target not found in ${name}: ${rw.from}`);
        }
        body = body.replace(rw.from, rw.to);
      }
      return body;
    })
    .join('\n\n');
}

function renderReturn(names) {
  return '  return {\n' + names.map((n) => `    ${n},`).join('\n') + '\n  };';
}

// ---- launch domain ----
{
  const a = analysis.launch;
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderHeadRequires(a.neededRequires);
  if (reqs) parts.push(reqs);
  parts.push('module.exports = function createPtyRuntimeLaunchDomain(deps, helpers) {');
  const d = renderDepsDestructure(a.usedOptions);
  if (d) parts.push(d);
  if (a.usedMembers.codexLaunchSupport) parts.push('  const { codexLaunchSupport } = helpers;');
  parts.push(renderMembersDestructure(a.usedMembers));
  parts.push(renderBodyStatements('launch'));
  parts.push(renderFunctions('launch', null));
  parts.push(renderReturn(DOMAIN_FNS.launch));
  parts.push('};');
  fs.writeFileSync(OUT('pty-runtime-launch.js'), parts.join('\n\n') + '\n');
  console.log('\nwrote pty-runtime-launch.js');
}

// ---- spawn domain ----
{
  const a = analysis.spawn;
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderHeadRequires(a.neededRequires);
  if (reqs) parts.push(reqs);
  parts.push(RESOLVE_PTY_TERM_NAME);
  parts.push('module.exports = function createPtyRuntimeSpawnDomain(deps, launch, helpers) {');
  const d = renderDepsDestructure(a.usedOptions);
  if (d) parts.push(d);
  const launchFns = a.crossFns.filter((n) => DOMAIN_FNS.launch.includes(n));
  parts.push(renderCrossDestructure('launch', launchFns));
  const holderNames = ['shared', ...Object.keys(a.usedMembers)];
  parts.push('  const {\n' + holderNames.map((h) => `    ${h},`).join('\n') + '\n  } = helpers;');
  parts.push(renderMembersDestructure(a.usedMembers));
  parts.push(renderBodyStatements('spawn'));
  parts.push(renderFunctions('spawn', REWRITES));
  parts.push(renderReturn(DOMAIN_FNS.spawn));
  parts.push('};');
  fs.writeFileSync(OUT('pty-runtime-spawn.js'), parts.join('\n\n') + '\n');
  console.log('wrote pty-runtime-spawn.js');
}

// ---- run domain ----
{
  const a = analysis.run;
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderHeadRequires(a.neededRequires);
  if (reqs) parts.push(reqs);
  parts.push('module.exports = function createPtyRuntimeRunDomain(deps, launch, spawnDomain, helpers) {');
  const d = renderDepsDestructure(a.usedOptions);
  if (d) parts.push(d);
  const launchFns = a.crossFns.filter((n) => DOMAIN_FNS.launch.includes(n));
  const spawnFns = a.crossFns.filter((n) => DOMAIN_FNS.spawn.includes(n));
  parts.push(renderCrossDestructure('launch', launchFns));
  parts.push(renderCrossDestructure('spawnDomain', spawnFns));
  const holderNames = ['shared', ...Object.keys(a.usedMembers)];
  parts.push('  const {\n' + holderNames.map((h) => `    ${h},`).join('\n') + '\n  } = helpers;');
  parts.push(renderMembersDestructure(a.usedMembers));
  parts.push(renderBodyStatements('run'));
  parts.push(renderFunctions('run', REWRITES));
  parts.push(renderReturn(DOMAIN_FNS.run));
  parts.push('};');
  fs.writeFileSync(OUT('pty-runtime-run.js'), parts.join('\n\n') + '\n');
  console.log('wrote pty-runtime-run.js');
}

// ---------------------------------------------------------------------------
// 9. Rewrite main runtime.js
// ---------------------------------------------------------------------------
// Original body blocks destructure members directly from the shared factories
// (`} = createCodexLaunchSupport({…})`). After the split, the domain factories
// receive the HOLDER objects as helpers (`{ shared, codexLaunchSupport,
// persistentWrapper }`) and destructure members inside themselves. So the main
// blocks must become holder assignments: `const codexLaunchSupport = createCodexLaunchSupport({…})`.
function renderMainSharedFactory(holderName, factoryName, start, end) {
  const text = slice1(start, end);
  // original header:
  //   const {
  //     memberA,
  //     memberB
  //   } = createCodexLaunchSupport({
  // new header:
  //   const codexLaunchSupport = createCodexLaunchSupport({
  const newHeader = text.replace(
    /^  const \{\n(?:    [A-Za-z0-9_$]+,?\n)+  \} = (\w+)\(\{/,
    `  const ${holderName} = $1({`
  );
  if (!newHeader.startsWith(`  const ${holderName} = ${factoryName}({`)) {
    throw new Error(`failed to transform shared factory block for ${holderName} (${start}-${end})`);
  }
  return newHeader;
}

{
  const mainReqBinds = ['defaultFetchSshClipAgentImage', 'createCodexLaunchSupport', 'createPersistentLaunchWrapper', 'runSshMcpServerLoop'];
  const mainReqs = headRequires.filter((r) => r.binds.some((b) => mainReqBinds.includes(b)));
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderHeadRequires(mainReqs);
  if (reqs) parts.push(reqs);
  parts.push("const createPtyRuntimeLaunchDomain = require('./pty-runtime-launch');");
  parts.push("const createPtyRuntimeSpawnDomain = require('./pty-runtime-spawn');");
  parts.push("const createPtyRuntimeRunDomain = require('./pty-runtime-run');");
  parts.push('function createPtyRuntime(options = {}) {');
  parts.push(slice1(OPTIONS_START, OPTIONS_END));
  parts.push('  const shared = { lastRuntimeEnv: {} };');
  parts.push(renderMainSharedFactory('codexLaunchSupport', 'createCodexLaunchSupport', 365, 377));
  parts.push(renderMainSharedFactory('persistentWrapper', 'createPersistentLaunchWrapper', 823, 836));
  parts.push('  const deps = {\n' + optionNames.map((n) => `    ${n},`).join('\n') + '\n  };');
  parts.push('  const launch = createPtyRuntimeLaunchDomain(deps, { codexLaunchSupport });');
  parts.push('  const spawnDomain = createPtyRuntimeSpawnDomain(deps, launch, { shared, codexLaunchSupport, persistentWrapper });');
  parts.push('  const run = createPtyRuntimeRunDomain(deps, launch, spawnDomain, { shared, codexLaunchSupport, persistentWrapper });');
  parts.push('');
  parts.push('  return { runCliPtyTracked: run.runCliPtyTracked };');
  parts.push('}');
  parts.push('');
  parts.push('module.exports = {');
  parts.push('  createPtyRuntime,');
  parts.push('  runSshMcpServerLoop');
  parts.push('};');
  fs.writeFileSync(SRC, parts.join('\n') + '\n');
  console.log('\nrewrote runtime.js');
}

// ---------------------------------------------------------------------------
// 10. Verifications
// ---------------------------------------------------------------------------
console.log('\n=== verification ===');
for (const f of ['pty-runtime-launch.js', 'pty-runtime-spawn.js', 'pty-runtime-run.js', 'runtime.js']) {
  const p = OUT(f);
  const content = fs.readFileSync(p, 'utf8');
  const check = spawnSync('node', ['--check', p], { encoding: 'utf8' });
  if (check.status !== 0) {
    console.error(`node --check FAILED for ${f}:\n${check.stderr}`);
    process.exitCode = 1;
  } else {
    console.log(`node --check OK: ${f} (${content.split('\n').length} lines)`);
  }
}

const origExports = /module\.exports = \{([\s\S]*?)\};/.exec(source);
const newExports = fs.readFileSync(SRC, 'utf8').match(/module\.exports = \{([\s\S]*?)\};/);
console.log('\nexport surface original:', origExports ? origExports[1].trim().replace(/\s+/g, ' ') : '?');
console.log('export surface new     :', newExports ? newExports[1].trim().replace(/\s+/g, ' ') : '?');

// line accounting: every line 82..2166 assigned exactly once
const assigned = new Map();
for (const name of allFnNames) {
  const { start, end } = functions.get(name);
  for (let i = start; i <= end; i++) assigned.set(i, `fn:${name}`);
}
for (const st of BODY_STMTS) {
  for (let i = st.start; i <= st.end; i++) assigned.set(i, `stmt:${st.name}`);
}
for (let i = OPTIONS_START; i <= OPTIONS_END; i++) assigned.set(i, 'main:options');
assigned.set(129, 'main:lastRuntimeEnv');
let missing = 0;
for (let i = 82; i <= 2166; i++) {
  if (!assigned.has(i)) {
    const t = lines[i - 1].trim();
    if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
      if (missing < 20) console.log(`UNASSIGNED line ${i}: ${lines[i - 1]}`);
      missing++;
    }
  }
}
console.log(`\nunassigned non-blank lines in 82..2166: ${missing}`);
if (missing > 0) process.exitCode = 1;
