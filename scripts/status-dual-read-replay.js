'use strict';

// §7-d 双读比对的「线上真实事件」回放入口（Node 侧）。
//
// 为什么需要它：status-dual-read-capture.js 只回放一组固定矩阵，能证明两端在**已知**路径上
// 一致；线上真实事件才会走到矩阵没覆盖的组合（证据顺序、重复 failure、runtime_state 快照
// 覆盖等）。这里把线上事件日志按账号重放一遍，再把同一批步骤喂给 Go oracle，逐字段比对。
//
// 纪律：
//   * 只读：不写日志、不改 Go 状态、不碰服务进程；唯一的外部动作是 spawn 一个 oracle 子进程；
//   * Node 侧语义必须与 capture 脚本完全一致，所以直接复用它的 replay()，而不是再抄一份
//     状态机——两份实现一旦漂移，「双读」就变成了「双写错误」；
//   * 事件顺序按 atMs 稳定排序：日志是追加写的，理论上已有序，但跨进程并发追加、时钟回拨
//     都可能破坏顺序，重放必须用确定性的顺序，否则同一份日志两次跑出不同结果。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { replay } = require('./status-dual-read-capture');

// 单账号最多重放多少步：线上日志是长期追加的，一个老账号可能有几万条事件。双读的目的是
// 抽查语义一致性，不是全量回归；超过这个量级既慢又会把 oracle 的 stdin 撑爆。
const MAX_STEPS_PER_ACCOUNT = 200;
// go run 需要先编译，冷启动可能十几秒；给它一个宽松上限，避免 CI 里永久挂起。
const ORACLE_TIMEOUT_MS = 120_000;
const DEFAULT_ORACLE = 'go run ./cmd/status-oracle';
const REPO_ROOT = path.join(__dirname, '..');
const KNOWN_OPS = new Set(['failure', 'clear', 'runtime_state']);

function usage() {
  return [
    '用法: node scripts/status-dual-read-replay.js [选项]',
    '',
    '  --journal <path>        事件日志（默认 $AIH_HOME_DIR/observability/status-events.jsonl，',
    '                          未设置 AIH_HOME_DIR 时为 ~/.ai_home/observability/status-events.jsonl）',
    '  --limit N               只读取日志的前 N 条事件（文件顺序），用于快速抽样',
    '  --json                  输出机器可读报告',
    '  --fail-on-divergence    存在分歧时退出码 1',
    '  --oracle <cmd>          Go oracle 命令（默认 "go run ./cmd/status-oracle"）',
    '  --help                  显示本帮助'
  ].join('\n');
}

function defaultJournalPath() {
  const home = process.env.AIH_HOME_DIR || path.join(os.homedir(), '.ai_home');
  return path.join(home, 'observability', 'status-events.jsonl');
}

// 按空格切分命令，支持单/双引号包裹的参数。
// 不直接 spawn(cmd, { shell: true })：shell 会把日志路径里的空格/分号当成语法，
// 而这里的分隔符只应该是 argv 的边界。
function splitCommand(command) {
  const parts = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of String(command || '')) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (started) { parts.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) parts.push(current);
  return parts;
}

function parseArgs(argv) {
  const options = {
    journal: defaultJournalPath(),
    limit: 0,
    json: false,
    failOnDivergence: false,
    oracle: DEFAULT_ORACLE,
    help: false
  };
  const rest = Array.from(argv || []);
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--fail-on-divergence') { options.failOnDivergence = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--journal') {
      const value = rest.shift();
      if (!value) throw new Error('--journal 需要一个路径');
      options.journal = value;
      continue;
    }
    if (arg === '--oracle') {
      const value = rest.shift();
      if (!value) throw new Error('--oracle 需要一条命令');
      options.oracle = value;
      continue;
    }
    if (arg === '--limit') {
      const value = rest.shift();
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('--limit 需要正整数');
      options.limit = parsed;
      continue;
    }
    throw new Error('未知参数: ' + arg);
  }
  return options;
}

// 读日志并校验。单行坏掉不该让整份日志作废（线上文件是多个进程追加的，半行写入很常见），
// 所以记录到 errors 后跳过；但版本号不认识时必须报错——静默忽略一个未来版本的事件，
// 双读结论会变成「没发现问题」的假阴性。
function readJournal(filePath, limit) {
  const result = { events: [], errors: [], missing: false, empty: false };
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') { result.missing = true; return result; }
    throw error;
  }
  if (!raw.trim()) { result.empty = true; return result; }

  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (limit && result.events.length >= limit) break;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      result.errors.push({ source: 'journal', line: index + 1, message: '不是合法 JSON: ' + error.message });
      continue;
    }
    const invalid = validateEvent(parsed, index + 1);
    if (invalid) { result.errors.push(invalid); continue; }
    result.events.push({
      atMs: parsed.atMs,
      accountRef: parsed.accountRef,
      provider: parsed.provider,
      op: parsed.op,
      failure: parsed.failure,
      evidence: parsed.evidence,
      state: parsed.state
    });
  }
  return result;
}

function validateEvent(event, line) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { source: 'journal', line, message: '事件不是对象' };
  }
  if (event.v !== 1) {
    return { source: 'journal', line, message: '未登记的事件版本: ' + JSON.stringify(event.v) };
  }
  if (!Number.isFinite(event.atMs) || event.atMs < 0) {
    return { source: 'journal', line, message: 'atMs 不是非负数字: ' + JSON.stringify(event.atMs) };
  }
  if (typeof event.accountRef !== 'string' || !event.accountRef.trim()) {
    return { source: 'journal', line, message: '缺少 accountRef' };
  }
  if (typeof event.provider !== 'string' || !event.provider.trim()) {
    return { source: 'journal', line, message: '缺少 provider' };
  }
  if (!KNOWN_OPS.has(event.op)) {
    return { source: 'journal', line, message: '未知 op: ' + JSON.stringify(event.op) };
  }
  if (event.op === 'failure' && (!event.failure || typeof event.failure !== 'object')) {
    return { source: 'journal', line, message: 'failure 事件缺少 failure 负载' };
  }
  if (event.op === 'clear' && typeof event.evidence !== 'string') {
    return { source: 'journal', line, message: 'clear 事件缺少 evidence' };
  }
  return null;
}

// 按 accountRef 分组。Map 的插入顺序就是「该账号在日志里第一次出现」的顺序：
// 报告稳定可复现，diff 时不会因为遍历顺序变化而产生噪音。
function groupByAccount(events, errors) {
  const accounts = new Map();
  for (const event of events) {
    let account = accounts.get(event.accountRef);
    if (!account) {
      account = { accountRef: event.accountRef, provider: event.provider, steps: [] };
      accounts.set(event.accountRef, account);
    } else if (account.provider !== event.provider) {
      // provider 是状态机的输入之一（codex/agy 的清理规则不同），一个 accountRef 对应两个
      // provider 说明日志本身有问题，继续比对只会得到无法归因的分歧。
      errors.push({
        source: 'journal',
        accountRef: event.accountRef,
        message: '同一账号出现多个 provider: ' + account.provider + ' / ' + event.provider
      });
      continue;
    }
    account.steps.push(event);
  }
  return Array.from(accounts.values());
}

// 请求载荷按契约逐字段重建（而不是把日志行原样转发）：日志文件是外部输入，可能被手工
// 编辑过；Go 侧按 int64/string 解码，一个 null 的 cooldownMs 会让整个请求解码失败。
// 这里把缺省值收敛到与 lib/server/status-event-journal.js 写入时相同的形状。
function buildStepPayload(step) {
  if (step.op === 'failure') {
    const failure = step.failure || {};
    return {
      op: 'failure',
      atMs: step.atMs,
      failure: {
        kind: typeof failure.kind === 'string' ? failure.kind : '',
        reason: typeof failure.reason === 'string' ? failure.reason : '',
        cooldownMs: Number.isFinite(Number(failure.cooldownMs)) ? Number(failure.cooldownMs) : 0,
        routingBlockRecheck: failure.routingBlockRecheck === 'manual' ? 'manual' : null
      }
    };
  }
  if (step.op === 'clear') {
    return { op: 'clear', atMs: step.atMs, evidence: step.evidence };
  }
  return { op: 'runtime_state', atMs: step.atMs, state: step.state === undefined ? null : step.state };
}

function buildRequest(account, steps) {
  return {
    id: account.accountRef + '#0',
    provider: account.provider,
    initial: null,
    steps: steps.map(buildStepPayload)
  };
}

// Node 侧回放：直接调用 capture 的 replay()，保证与夹具生成器是同一份语义。
// 任何一步抛错（例如日志里出现未登记的证据）都会中断该账号——状态机已经走到一半，
// 继续拿后面的快照比对只会得到一串假分歧。
function replaySteps(provider, steps) {
  return replay({ provider, initial: null, steps: steps.map(buildStepPayload) });
}

function splitAccounts(accounts) {
  const truncations = [];
  const prepared = accounts.map((account) => {
    const ordered = account.steps.slice().sort((left, right) => left.atMs - right.atMs);
    if (ordered.length <= MAX_STEPS_PER_ACCOUNT) return { account, steps: ordered };
    truncations.push({
      accountRef: account.accountRef,
      kept: MAX_STEPS_PER_ACCOUNT,
      dropped: ordered.length - MAX_STEPS_PER_ACCOUNT,
      // 截断保留最早的一段：状态机的后续行为依赖前面的累积量（consecutiveFailures 等），
      // 从中间截断会得到一个线上从未出现过的起点。
      fromAtMs: ordered[0].atMs,
      toAtMs: ordered[MAX_STEPS_PER_ACCOUNT - 1].atMs
    });
    return { account, steps: ordered.slice(0, MAX_STEPS_PER_ACCOUNT) };
  });
  return { prepared, truncations };
}

function runOracle(command, requests) {
  return new Promise((resolve) => {
    const parts = splitCommand(command);
    const errors = [];
    const responses = new Map();
    if (!parts.length) {
      resolve({ responses, errors: [{ source: 'oracle', message: 'oracle 命令为空' }] });
      return;
    }
    let child;
    try {
      child = spawn(parts[0], parts.slice(1), {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ responses, errors: [{ source: 'oracle', message: '无法启动 oracle: ' + error.message }] });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (extraErrors) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const allErrors = errors.concat(extraErrors || []);
      for (const line of stdout.split('\n')) {
        const text = line.trim();
        if (!text) continue;
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (error) {
          allErrors.push({ source: 'oracle', message: 'stdout 不是合法 JSON: ' + text.slice(0, 200) });
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string') {
          allErrors.push({ source: 'oracle', message: '响应缺少 id: ' + text.slice(0, 200) });
          continue;
        }
        responses.set(parsed.id, parsed);
      }
      resolve({ responses, errors: allErrors });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // 只杀我们自己 spawn 的子进程：oracle 卡死时不能让调用方永久挂住。
      try { child.kill('SIGKILL'); } catch (_error) { /* 进程可能已退出 */ }
    }, ORACLE_TIMEOUT_MS);

    child.on('error', (error) => {
      errors.push({ source: 'oracle', message: 'oracle 进程错误: ' + error.message });
      // error 之后 close 不一定还会来，这里直接收尾。
      finish([]);
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code, signal) => {
      if (timedOut) {
        errors.push({ source: 'oracle', message: 'oracle 超时（' + ORACLE_TIMEOUT_MS + 'ms）后被终止' });
      } else if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-5).join('\n');
        errors.push({
          source: 'oracle',
          message: 'oracle 退出码 ' + code + (signal ? '（signal ' + signal + '）' : '') + (tail ? ': ' + tail : '')
        });
      }
      finish([]);
    });

    child.stdin.on('error', (error) => {
      // oracle 提前退出时会 EPIPE，真正的错误已经由 close 分支记录。
      if (error && error.code !== 'EPIPE') {
        errors.push({ source: 'oracle', message: '写入 oracle 失败: ' + error.message });
      }
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
    child.stdin.end();
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 规范化：对象的键排序、undefined 视同不存在。
// 双读比较的是「文档内容」而不是「序列化字节」——Go 的 map 遍历顺序、字段声明顺序都会变。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      output[key] = canonicalize(value[key]);
    }
    return output;
  }
  return value;
}

// 逐字段收集差异而不是提前 return：一个步骤的所有漂移要一次报全，否则每修一处就得重跑一遍。
function collectDiff(nodeValue, goValue, field, out) {
  const left = canonicalize(nodeValue);
  const right = canonicalize(goValue);
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
    for (const key of keys) {
      collectDiff(left[key], right[key], field ? field + '.' + key : key, out);
    }
    return;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    out.push({ field, node: left === undefined ? null : left, go: right === undefined ? null : right });
  }
}

function compareAccount(account, nodeResults, goResponse) {
  const divergences = [];
  const goResults = goResponse && Array.isArray(goResponse.results) ? goResponse.results : [];
  if (goResults.length !== nodeResults.length) {
    divergences.push({
      accountRef: account.accountRef,
      step: 0,
      atMs: null,
      op: null,
      field: 'results.length',
      node: nodeResults.length,
      go: goResults.length
    });
  }
  const count = Math.min(nodeResults.length, goResults.length);
  for (let index = 0; index < count; index += 1) {
    const node = nodeResults[index];
    const go = goResults[index] || {};
    const source = account.steps[index] || {};
    const found = [];
    collectDiff(node.atMs, go.atMs, 'atMs', found);
    collectDiff(node.runtimeState, go.runtimeState, 'runtimeState', found);
    collectDiff(node.status, go.status, 'status', found);
    for (const item of found) {
      divergences.push({
        accountRef: account.accountRef,
        step: index + 1,
        atMs: node.atMs,
        op: source.op,
        field: item.field,
        node: item.node,
        go: item.go
      });
    }
  }
  return divergences;
}

function quote(value) {
  const text = JSON.stringify(value);
  return text === undefined ? 'null' : text;
}

function renderDivergence(item) {
  const scope = item.step > 0 ? 'step ' + item.step : 'account';
  return item.accountRef + ' ' + scope + ' ' + item.field + ': node=' + quote(item.node) + ' go=' + quote(item.go);
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write('[status-replay] ' + error.message + '\n' + usage() + '\n');
    return 2;
  }
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return 0;
  }

  const report = {
    journal: options.journal,
    oracle: options.oracle,
    accounts: 0,
    steps: 0,
    divergences: [],
    errors: [],
    truncations: []
  };

  const journal = readJournal(options.journal, options.limit);
  report.errors.push(...journal.errors);

  if (journal.missing || journal.empty) {
    const reason = journal.missing ? '日志不存在' : '日志为空';
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write('[status-replay] ' + reason + '，无事件可比对: ' + options.journal + '\n');
    }
    return report.errors.length ? 2 : 0;
  }

  const accounts = groupByAccount(journal.events, report.errors);
  const { prepared, truncations } = splitAccounts(accounts);
  report.truncations = truncations;
  report.accounts = prepared.length;

  const pending = [];
  for (const entry of prepared) {
    let nodeResults;
    try {
      nodeResults = replaySteps(entry.account.provider, entry.steps);
    } catch (error) {
      report.errors.push({
        source: 'node',
        accountRef: entry.account.accountRef,
        message: 'Node 回放失败: ' + (error && error.message ? error.message : String(error))
      });
      continue;
    }
    pending.push({ account: entry.account, steps: entry.steps, nodeResults });
  }

  if (!pending.length) {
    if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write('[status-replay] 没有可重放的事件\n');
    return report.errors.length ? 2 : 0;
  }

  const requests = pending.map((entry) => buildRequest(entry.account, entry.steps));
  const oracle = await runOracle(options.oracle, requests);
  report.errors.push(...oracle.errors);

  for (const entry of pending) {
    const request = buildRequest(entry.account, entry.steps);
    const response = oracle.responses.get(request.id);
    if (!response) {
      // oracle 整体失败时已经记过一条；这里记「缺这一条响应」便于定位是哪个账号没被处理。
      if (!oracle.errors.length) {
        report.errors.push({ source: 'oracle', accountRef: entry.account.accountRef, message: 'oracle 未返回该账号的响应' });
      }
      continue;
    }
    report.steps += entry.nodeResults.length;
    report.divergences.push(...compareAccount(entry.account, entry.nodeResults, response));
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const truncation of report.truncations) {
      process.stdout.write(
        '[status-replay] ' + truncation.accountRef + ' 事件超过 ' + MAX_STEPS_PER_ACCOUNT +
        ' 步，已截断 ' + truncation.dropped + ' 步（保留 ' + truncation.fromAtMs + '..' + truncation.toAtMs + '）\n'
      );
    }
    for (const divergence of report.divergences) {
      process.stdout.write(renderDivergence(divergence) + '\n');
    }
    for (const error of report.errors) {
      const where = error.accountRef ? ' ' + error.accountRef : (error.line ? ' line ' + error.line : '');
      process.stderr.write('[status-replay] error' + where + ': ' + error.message + '\n');
    }
    process.stdout.write(
      '[status-replay] accounts=' + report.accounts + ' steps=' + report.steps +
      ' divergences=' + report.divergences.length + ' errors=' + report.errors.length + '\n'
    );
  }

  // 退出码约定：2 表示「这次比对本身不可信」（日志坏了 / oracle 没跑成），优先于分歧；
  // 1 只在显式要求 --fail-on-divergence 时出现，方便本地巡检时不打断脚本。
  if (report.errors.length) return 2;
  if (report.divergences.length && options.failOnDivergence) return 1;
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write('[status-replay] ' + (error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  parseArgs,
  readJournal,
  groupByAccount,
  buildRequest,
  replaySteps,
  splitAccounts,
  runOracle,
  canonicalize,
  collectDiff,
  renderDivergence,
  splitCommand,
  MAX_STEPS_PER_ACCOUNT,
  DEFAULT_ORACLE
};
