#!/usr/bin/env node
'use strict';

/**
 * Split lib/cli/services/usage/snapshot.js (2074 lines) into:
 *   - usage-snapshot-codex.js -> createCodexUsageSnapshotDomain(deps, helpers)
 *   - snapshot.js (main)      -> composition root: options destructure + shared helpers + remaining domains + wiring
 *
 * The codex domain owns every function that probes/refreshes codex usage:
 * formatResetInFromUnixSeconds, parseResetAtMsFromUnixSeconds (pure helpers only
 * used by parseCodexRateLimits) plus the 25 codex functions from formatCodexWindow
 * (709) through refreshCodexUsageSnapshotFromAppServerAsync (1523).
 *
 * Cross-domain wiring (mirrors pty split):
 *   - main -> codex (helpers): readAccountEnv, setProbeError,
 *     clearRuntimeStateForVerifiedSnapshot, spawnProcess, fetchWithImpl,
 *     fetchWithTimeoutImpl
 *   - codex -> main (exports): refreshCodexUsageSnapshot, refreshCodexTokenForSandbox,
 *     refreshCodexUsageSnapshotFromDirectApiAsync,
 *     refreshCodexUsageSnapshotFromAppServerAsync, readCodexAuthJsonForSandbox,
 *     sanitizeAccessToken
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'lib', 'cli', 'services', 'usage', 'snapshot.js');
const DIR = path.dirname(SRC);
const OUT = (name) => path.join(DIR, name);

// Read the ORIGINAL 2074-line snapshot.js from git so the script is re-runnable
// after it has already rewritten the working-tree file.
let source;
const gitShow = spawnSync('git', ['show', 'HEAD:lib/cli/services/usage/snapshot.js'], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
});
if (gitShow.status === 0 && gitShow.stdout.split('\n').length > 1500) {
  source = gitShow.stdout;
  // eslint-disable-next-line no-console
  console.log(`[split] using original snapshot.js from git HEAD (${gitShow.stdout.split('\n').length} lines)`);
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
// 1. Parse head requires (lines 1-44)
// ---------------------------------------------------------------------------
const HEAD_END = 44;
const headText = slice1(1, HEAD_END);
const headRequires = []; // { spec, binds: [{ source, local }] }
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
    if (rm) binds.push({ source: rm[1], local: rm[2] || rm[1] });
  }
  headRequires.push({ spec, binds });
}

// ---------------------------------------------------------------------------
// 2. Parse options destructure (lines 47-72) -> option names
// ---------------------------------------------------------------------------
const OPTIONS_START = 47;
const OPTIONS_END = 72;
const optionText = slice1(OPTIONS_START, OPTIONS_END);
const optionNames = [];
for (const part of optionText.split('\n')) {
  const t = part.trim().replace(/,$/, '');
  if (!t || t === 'const {' || t === '} = options;') continue;
  const m2 = t.match(/^([A-Za-z_$][\w$]*)(?:\s*=.*)?$/);
  if (m2) optionNames.push(m2[1]);
}
console.log('options destructure:', optionNames.length, 'names');

// ---------------------------------------------------------------------------
// 3. Locate the 27 codex-domain functions (verified start lines, lexer ends)
// ---------------------------------------------------------------------------
const CODEX_FNS = [
  ['formatResetInFromUnixSeconds', 286],
  ['parseResetAtMsFromUnixSeconds', 300],
  ['formatCodexWindow', 709],
  ['normalizeCodexRateLimitWindow', 717],
  ['parseCodexRateLimits', 738],
  ['parseCodexAccountFallback', 771],
  ['mergeCodexSnapshotAccount', 782],
  ['readCodexAuthJsonForSandbox', 794],
  ['resolveUsageRuntime', 799],
  ['refreshCodexUsageSnapshotFromAppServer', 810],
  ['refreshCodexUsageSnapshot', 1030],
  ['sanitizeAccessToken', 1035],
  ['fetchWithOptionalCustomFetch', 1042],
  ['readCodexAuthForSandbox', 1060],
  ['refreshCodexTokenForSandbox', 1074],
  ['readCodexDirectMode', 1167],
  ['resolveCodexDirectBaseUrl', 1171],
  ['resolveCodexDirectRateLimitPath', 1180],
  ['fetchCodexDirectUsage', 1189],
  ['normalizeCodexWhamUsageWindow', 1193],
  ['extractRateLimitsFromWhamUsagePayload', 1216],
  ['extractRateLimitsFromDirectPayload', 1229],
  ['extractCodexAccountFromDirectPayload', 1240],
  ['refreshCodexUsageSnapshotFromDirectApiAsync', 1254],
  ['buildCodexSnapshotFromProbePayload', 1311],
  ['createCodexProbeTimeoutMs', 1329],
  ['refreshCodexUsageSnapshotFromAppServerAsync', 1338],
];

const codexFns = new Map(); // name -> { start, end, body }
for (const [name, start] of CODEX_FNS) {
  const line = lines[start - 1];
  const openPos = line.lastIndexOf('{'); // function body brace is the last '{' on the signature line
  if (openPos < 0) throw new Error(`no brace on line ${start} for ${name}`);
  const end = endOfBlockAt(start - 1, openPos);
  codexFns.set(name, { start, end, body: slice1(start, end) });
}

// Verified ends (must match lexer)
const VERIFIED_ENDS = {
  formatResetInFromUnixSeconds: 298,
  parseResetAtMsFromUnixSeconds: 304,
  formatCodexWindow: 715,
  parseCodexRateLimits: 769,
  refreshCodexUsageSnapshotFromAppServer: 1028,
  refreshCodexUsageSnapshot: 1033,
  sanitizeAccessToken: 1040,
  refreshCodexTokenForSandbox: 1165,
  refreshCodexUsageSnapshotFromDirectApiAsync: 1309,
  refreshCodexUsageSnapshotFromAppServerAsync: 1523,
};
for (const [name, end] of Object.entries(VERIFIED_ENDS)) {
  const got = codexFns.get(name).end;
  if (got !== end) {
    throw new Error(`end mismatch for ${name}: got ${got}, expected ${end}`);
  }
}
console.log('codex function ends verified against known values');

// ---------------------------------------------------------------------------
// 4. Discover ALL inner factory functions (lines 103-2069) to find main-remaining
// ---------------------------------------------------------------------------
const fnRe = /^  (?:async )?function ([A-Za-z0-9_$]+)\(/;
const allFnStarts = [];
for (let i = 102; i < 2069; i++) {
  const fm = fnRe.exec(lines[i]);
  if (fm) allFnStarts.push([fm[1], i + 1]);
}
const allFns = new Map(); // name -> { start, end }
for (const [name, start] of allFnStarts) {
  const line = lines[start - 1];
  const openPos = line.lastIndexOf('{');
  const end = endOfBlockAt(start - 1, openPos);
  allFns.set(name, { start, end });
}
console.log('all inner functions:', allFns.size);

// codex set must be a subset of allFns with identical boundaries
for (const name of codexFns.keys()) {
  const mine = codexFns.get(name);
  const all = allFns.get(name);
  if (!all) throw new Error(`codex fn ${name} not found among all fns`);
  if (mine.start !== all.start || mine.end !== all.end) {
    throw new Error(`boundary mismatch for ${name}: mine ${mine.start}-${mine.end}, all ${all.start}-${all.end}`);
  }
}

const mainFns = [...allFns.keys()].filter((n) => !codexFns.has(n));
console.log('codex fns:', codexFns.size, '| main-remaining fns:', mainFns.length);

// ---------------------------------------------------------------------------
// 5. Reference analysis (deterministic word scan — over-inclusive is SAFE)
// ---------------------------------------------------------------------------
function scanWords(text) {
  const refs = new Set();
  const re = /[A-Za-z_$][\w$]*/g;
  let wm;
  while ((wm = re.exec(text))) {
    const tok = wm[0];
    if (tok.length >= 2) refs.add(tok);
  }
  return refs;
}

const codexContent = [...codexFns.values()].map((f) => f.body).join('\n');
const codexRefs = scanWords(codexContent);

const CODEX_OWN = new Set(codexFns.keys());
const CODEX_HELPERS = [
  'readAccountEnv', 'setProbeError', 'clearRuntimeStateForVerifiedSnapshot',
  'spawnProcess', 'fetchWithImpl', 'fetchWithTimeoutImpl',
];
const CODEX_EXPORTS = [
  'refreshCodexUsageSnapshot', 'refreshCodexTokenForSandbox',
  'refreshCodexUsageSnapshotFromDirectApiAsync',
  'refreshCodexUsageSnapshotFromAppServerAsync',
  'readCodexAuthJsonForSandbox', 'sanitizeAccessToken',
];
const FACTORY_PARAMS = ['deps', 'helpers'];
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
const CODEX_MODULE_CONSTS = ['DEFAULT_OPENAI_OAUTH_TOKEN_URL'];

// Which requires does the codex domain need?
const codexNeededRequires = headRequires
  .map((r) => ({ ...r, binds: r.binds.filter((b) => codexRefs.has(b.local)) }))
  .filter((r) => r.binds.length > 0);

// Which options does the codex domain use?
const codexUsedOptions = optionNames.filter((n) => codexRefs.has(n) && !FACTORY_PARAMS.includes(n));

// Cross refs: codex fn calling non-codex fn (must be in helpers)
const codexCrossFns = mainFns.filter((n) => codexRefs.has(n));
const missingHelpers = codexCrossFns.filter((n) => !CODEX_HELPERS.includes(n));
if (missingHelpers.length) {
  throw new Error(`codex domain references main functions not in helpers: ${missingHelpers.join(', ')}`);
}

// Unresolved in codex domain
const codexProvided = new Set([
  ...CODEX_OWN, ...CODEX_HELPERS, ...codexUsedOptions, ...CODEX_EXPORTS,
  ...codexNeededRequires.flatMap((r) => r.binds.map((b) => b.local)),
  ...CODEX_MODULE_CONSTS, ...FACTORY_PARAMS, ...GLOBALS,
]);
const codexUnresolved = [...codexRefs].filter((n) => !codexProvided.has(n)).sort();

console.log('\n=== codex domain analysis ===');
console.log('  options:', codexUsedOptions.join(', '));
console.log('  helpers:', CODEX_HELPERS.join(', '));
console.log('  requires:', codexNeededRequires.map((r) => r.spec).join(', '));
console.log('  crossFns:', codexCrossFns.join(', '));
console.log('  exports:', CODEX_EXPORTS.join(', '));
console.log('  unresolved(warn):', codexUnresolved.length ? codexUnresolved.join(', ') : '(none)');

// ---------------------------------------------------------------------------
// 6. Main-remaining reference analysis: which requires stay in main?
// ---------------------------------------------------------------------------
// remaining main content: everything except head(1-44 handled), options(47-72),
// codex fn bodies. We approximate by scanning the full source minus codex bodies.
const codexBodyLineSet = new Set();
for (const f of codexFns.values()) {
  for (let i = f.start; i <= f.end; i++) codexBodyLineSet.add(i);
}
const mainContentLines = lines.filter((_, idx) => !codexBodyLineSet.has(idx + 1));
const mainContent = mainContentLines.join('\n');
const mainRefs = scanWords(mainContent);

// options + body statements still used by main (body stmts stay in main regardless)
const mainNeededRequires = headRequires
  .map((r) => ({ ...r, binds: r.binds.filter((b) => mainRefs.has(b.local)) }))
  .filter((r) => r.binds.length > 0);

const MAIN_BODY_BINDS = ['spawnChild', 'DEFAULT_OPENAI_OAUTH_TOKEN_URL'];
const mainProvided = new Set([
  ...mainFns, ...mainNeededRequires.flatMap((r) => r.binds.map((b) => b.local)),
  ...optionNames, ...CODEX_EXPORTS, ...MAIN_BODY_BINDS, ...GLOBALS,
]);
const mainUnresolved = [...mainRefs].filter((n) => !mainProvided.has(n)).sort();
// NOTE: spawnChild / DEFAULT_OPENAI_OAUTH_TOKEN_URL appear in mainContent (body
// statements) but DEFAULT_OPENAI_OAUTH_TOKEN_URL moves to the codex module, so
// it must not be referenced by main-remaining. Check below.
const DEFAULT_REF = /\bDEFAULT_OPENAI_OAUTH_TOKEN_URL\b/g;
let defaultMainUses = 0;
const mainRemainingText = mainContentLines
  .filter((_, idx) => {
    const ln = idx + 1;
    return ln >= 45 && !codexBodyLineSet.has(ln);
  })
  .join('\n');
for (const _mm of mainRemainingText.matchAll(DEFAULT_REF)) defaultMainUses++;
if (defaultMainUses > 0) {
  throw new Error(`DEFAULT_OPENAI_OAUTH_TOKEN_URL still referenced in main-remaining (${defaultMainUses} uses)`);
}

console.log('\n=== main-remaining analysis ===');
console.log('  requires kept:', mainNeededRequires.map((r) => r.spec).join(', '));
console.log('  unresolved(warn):', mainUnresolved.length ? mainUnresolved.join(', ') : '(none)');

// ---------------------------------------------------------------------------
// 7. Render helpers
// ---------------------------------------------------------------------------
function renderRequireBlock(reqs) {
  const seen = new Set();
  const blocks = [];
  for (const r of reqs) {
    if (seen.has(r.spec)) continue;
    seen.add(r.spec);
    const inner = r.binds.map((b) => (b.source === b.local ? `  ${b.local},` : `  ${b.source}: ${b.local},`)).join('\n');
    blocks.push(`const {\n${inner}\n} = require('${r.spec}');`);
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

function renderReturn(names) {
  return '  return {\n' + names.map((n) => `    ${n},`).join('\n') + '\n  };';
}

// ---- codex domain module ----
{
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderRequireBlock(codexNeededRequires);
  if (reqs) parts.push(reqs);
  parts.push("const DEFAULT_OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';");
  parts.push('module.exports = function createCodexUsageSnapshotDomain(deps, helpers) {');
  const d = renderDepsDestructure(codexUsedOptions);
  if (d) parts.push(d);
  parts.push(renderCrossDestructure('helpers', CODEX_HELPERS));
  parts.push([...codexFns.values()].map((f) => f.body).join('\n\n'));
  parts.push(renderReturn(CODEX_EXPORTS));
  parts.push('};');
  fs.writeFileSync(OUT('usage-snapshot-codex.js'), parts.join('\n\n') + '\n');
  console.log('\nwrote usage-snapshot-codex.js');
}

// ---------------------------------------------------------------------------
// 8. Rewrite main snapshot.js (line-level surgical removal of codex fn ranges,
//    preserving every body-level statement and the return block verbatim)
// ---------------------------------------------------------------------------
const FACTORY_OPEN = 46; // function createUsageSnapshotService(options = {}) {
const FACTORY_CLOSE = 2071; // closing '}' of the factory
const MODULE_EXPORTS_END = 2075; // last line of the original file
{
  const parts = [];
  parts.push("'use strict';");
  const reqs = renderRequireBlock(mainNeededRequires);
  if (reqs) parts.push(reqs);
  parts.push("const createCodexUsageSnapshotDomain = require('./usage-snapshot-codex');");
  parts.push(lines[FACTORY_OPEN - 1]); // function createUsageSnapshotService(options = {}) {
  parts.push(slice1(OPTIONS_START, OPTIONS_END));
  parts.push(slice1(73, 101)); // body-level statements (spawnProcess..probeStateByAccountKey)
  parts.push('  const codexDomain = createCodexUsageSnapshotDomain(');
  parts.push('    { ' + codexUsedOptions.join(', ') + ' },');
  parts.push('    { ' + CODEX_HELPERS.join(', ') + ' }');
  parts.push('  );');
  parts.push(renderCrossDestructure('codexDomain', CODEX_EXPORTS));
  parts.push('');
  // factory body remainder (102..2071) minus codex fn ranges, verbatim
  const kept = [];
  for (let i = 101; i < FACTORY_CLOSE; i++) { // 0-indexed: display 102..2071
    if (codexBodyLineSet.has(i + 1)) continue;
    kept.push(lines[i]);
  }
  parts.push(kept.join('\n'));
  parts.push('module.exports = {');
  parts.push('  createUsageSnapshotService');
  parts.push('};');
  fs.writeFileSync(SRC, parts.join('\n') + '\n');
  console.log('\nrewrote snapshot.js');
}

// ---------------------------------------------------------------------------
// 9. Verifications
// ---------------------------------------------------------------------------
console.log('\n=== verification ===');
for (const f of ['usage-snapshot-codex.js', 'snapshot.js']) {
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
if (!origExports || !newExports || origExports[1].trim() !== newExports[1].trim()) {
  console.error('EXPORT SURFACE MISMATCH');
  process.exitCode = 1;
}

// line accounting: every line 47..2071 must be either a codex fn line or a
// main-retained line (options / body stmts / factory body remainder)
const retainedMain = new Set();
for (let i = OPTIONS_START; i <= OPTIONS_END; i++) retainedMain.add(i);
for (let i = 73; i <= 101; i++) retainedMain.add(i);
for (let i = 102; i <= FACTORY_CLOSE; i++) {
  if (!codexBodyLineSet.has(i)) retainedMain.add(i);
}
let missing = 0;
for (let i = 47; i <= FACTORY_CLOSE; i++) {
  if (retainedMain.has(i) || codexBodyLineSet.has(i)) continue;
  const t = lines[i - 1].trim();
  if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) {
    if (missing < 20) console.log(`UNASSIGNED line ${i}: ${lines[i - 1]}`);
    missing++;
  }
}
console.log(`\nunassigned non-blank lines in 47..${FACTORY_CLOSE}: ${missing}`);
if (missing > 0) process.exitCode = 1;