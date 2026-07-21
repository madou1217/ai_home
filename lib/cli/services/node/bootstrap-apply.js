'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildNodeBootstrapProbeOptionArgs,
  buildProbeExecutionPlan,
  formatNodeBootstrapProbeReport,
  parseNodeBootstrapProbeArgs,
  runNodeBootstrapProbe
} = require('./bootstrap-probe');
const {
  DEFAULT_ASSET_MODE,
  LOCAL_ASSET_MODE,
  normalizeAssetMode,
  runSshLocalAssetBootstrap
} = require('./bootstrap-assets');

const DEFAULT_EXECUTE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_EXECUTE_CONCURRENCY = 2;
const NO_EXECUTABLE_ACTIONS_ERROR = 'bootstrap_apply_no_executable_actions';
const NO_EXECUTABLE_ACTIONS_MESSAGE = 'No SSH-ready bootstrap actions were found; configure key-based SSH, add --ssh targets that pass probe, or run local-manual steps separately.';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parseBooleanOption(value, flag) {
  const normalized = nonEmptyString(value).toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  const error = new Error(`invalid_boolean:${flag}`);
  error.code = 'invalid_boolean_option';
  error.flag = flag;
  throw error;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function quoteCliArg(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : shellQuote(text);
}

function formatCliCommand(args) {
  return args.map(quoteCliArg).join(' ');
}

function buildNodeBootstrapApplyArgs(options = {}, applyOptions = {}) {
  const args = ['aih', 'node', 'bootstrap', 'apply'];
  if (applyOptions.execute) args.push('--execute');
  if (applyOptions.assumeYes || applyOptions.yes) args.push('--yes');
  if (applyOptions.assetMode) args.push('--asset-mode', normalizeAssetMode(applyOptions.assetMode));
  if (applyOptions.nodeDistDir) args.push('--node-dist-dir', nonEmptyString(applyOptions.nodeDistDir));
  if (applyOptions.nodeVersion) args.push('--node-version', nonEmptyString(applyOptions.nodeVersion));
  if (applyOptions.sourceRef) args.push('--source-ref', nonEmptyString(applyOptions.sourceRef));
  if (applyOptions.executeConcurrency !== undefined) {
    args.push(
      '--execute-concurrency',
      String(normalizePositiveInteger(applyOptions.executeConcurrency, DEFAULT_EXECUTE_CONCURRENCY, 1, 16))
    );
  }
  if (applyOptions.executeTimeoutMs !== undefined) {
    args.push(
      '--execute-timeout-ms',
      String(normalizePositiveInteger(applyOptions.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS, 1000, 24 * 60 * 60 * 1000))
    );
  }
  return [...args, ...buildNodeBootstrapProbeOptionArgs(options)];
}

function buildNodeBootstrapApplyCommand(options = {}, applyOptions = {}) {
  return formatCliCommand(buildNodeBootstrapApplyArgs(options, applyOptions));
}

function parseNodeBootstrapApplyArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    execute: false,
    assumeYes: false,
    json: false,
    executeTimeoutMs: DEFAULT_EXECUTE_TIMEOUT_MS,
    executeConcurrency: DEFAULT_EXECUTE_CONCURRENCY,
    assetMode: DEFAULT_ASSET_MODE,
    nodeDistDir: '',
    nodeVersion: '',
    sourceRef: 'HEAD',
    probeArgs: []
  };

  for (let index = 0; index < args.length;) {
    const token = nonEmptyString(args[index]);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--execute') {
      options.execute = true;
      index += 1;
      continue;
    }
    if (token.startsWith('--execute=')) {
      options.execute = parseBooleanOption(token.slice('--execute='.length), '--execute');
      index += 1;
      continue;
    }
    if (token === '--dry-run') {
      options.execute = false;
      index += 1;
      continue;
    }
    if (token.startsWith('--dry-run=')) {
      options.execute = !parseBooleanOption(token.slice('--dry-run='.length), '--dry-run');
      index += 1;
      continue;
    }
    if (token === '--yes' || token === '-y') {
      options.assumeYes = true;
      index += 1;
      continue;
    }
    if (token === '--local-assets') {
      options.assetMode = LOCAL_ASSET_MODE;
      index += 1;
      continue;
    }
    if (token === '--asset-mode' || token.startsWith('--asset-mode=')) {
      const next = readOptionValue(args, index, '--asset-mode');
      options.assetMode = normalizeAssetMode(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-dist-dir' || token.startsWith('--node-dist-dir=')) {
      const next = readOptionValue(args, index, '--node-dist-dir');
      options.nodeDistDir = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--node-version' || token.startsWith('--node-version=')) {
      const next = readOptionValue(args, index, '--node-version');
      options.nodeVersion = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--source-ref' || token.startsWith('--source-ref=')) {
      const next = readOptionValue(args, index, '--source-ref');
      options.sourceRef = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--execute-timeout-ms' || token.startsWith('--execute-timeout-ms=')) {
      const next = readOptionValue(args, index, '--execute-timeout-ms');
      options.executeTimeoutMs = normalizePositiveInteger(next.value, DEFAULT_EXECUTE_TIMEOUT_MS, 1000, 24 * 60 * 60 * 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--execute-concurrency' || token.startsWith('--execute-concurrency=')) {
      const next = readOptionValue(args, index, '--execute-concurrency');
      options.executeConcurrency = normalizePositiveInteger(next.value, DEFAULT_EXECUTE_CONCURRENCY, 1, 16);
      index += next.consumed;
      continue;
    }
    if (token === '--json') {
      options.json = true;
    }
    options.probeArgs.push(token);
    index += 1;
  }

  options.assetMode = normalizeAssetMode(options.assetMode);
  return options;
}

function resolveRequiredExecuteInputs(probeArgs = [], applyOptions = {}) {
  const options = parseNodeBootstrapProbeArgs(probeArgs);
  const requiredInputs = [];
  if (!nonEmptyString(options.controlUrl)) requiredInputs.push('control-url');
  if (!nonEmptyString(options.inviteUrl)) requiredInputs.push('invite-url');
  if (normalizeAssetMode(applyOptions.assetMode || DEFAULT_ASSET_MODE) !== LOCAL_ASSET_MODE
    && !nonEmptyString(options.repoUrl)) {
    requiredInputs.push('repo-url');
  }
  if (options.transportKind !== 'relay' && !nonEmptyString(options.endpoint)) requiredInputs.push('endpoint');
  return Array.from(new Set(requiredInputs));
}

function assertExecuteInputsComplete(probeArgs = [], applyOptions = {}) {
  const requiredInputs = resolveRequiredExecuteInputs(probeArgs, applyOptions);
  if (requiredInputs.length === 0) return;
  const error = new Error(`bootstrap_apply_required_inputs_missing:${requiredInputs.join(',')}`);
  error.code = 'bootstrap_apply_required_inputs_missing';
  error.requiredInputs = requiredInputs;
  throw error;
}

function isExecutableStep(step) {
  return Boolean(step && step.status === 'ready' && step.channel === 'ssh' && step.command);
}

function resolveActionExecution(step, options = {}) {
  const execution = step && step.execution && typeof step.execution === 'object' ? step.execution : null;
  if (!execution) return null;
  if (options.assetMode === LOCAL_ASSET_MODE && execution.kind === 'ssh-pipe') {
    return {
      ...execution,
      kind: 'ssh-local-assets',
      assetMode: LOCAL_ASSET_MODE,
      nodeDistDir: nonEmptyString(options.nodeDistDir),
      nodeVersion: nonEmptyString(options.nodeVersion),
      sourceRef: nonEmptyString(options.sourceRef || 'HEAD')
    };
  }
  return execution;
}

function resolveDryRunState(step) {
  if (isExecutableStep(step)) return 'dry-run';
  if (step && step.status === 'manual') return 'manual';
  if (step && step.status === 'needs-input') return 'needs-input';
  return 'blocked';
}

function normalizeManualCommands(manualCommands) {
  return (Array.isArray(manualCommands) ? manualCommands : [])
    .map((item) => ({
      key: nonEmptyString(item && item.key),
      label: nonEmptyString(item && item.label),
      command: nonEmptyString(item && item.command),
      note: nonEmptyString(item && item.note)
    }))
    .filter((item) => item.command);
}

function buildApplyActions(executionPlan = [], options = {}) {
  return (Array.isArray(executionPlan) ? executionPlan : []).map((step) => {
    const executable = isExecutableStep(step);
    const execution = resolveActionExecution(step, options);
    const action = {
      order: Number(step && step.order) || 0,
      resultKey: nonEmptyString(step && step.resultKey),
      target: nonEmptyString(step && step.target),
      title: nonEmptyString(step && step.title),
      channel: nonEmptyString(step && step.channel) || 'none',
      probeStatus: nonEmptyString(step && step.status),
      summary: execution && execution.kind === 'ssh-local-assets'
        ? 'Transfer current source and a local Node.js runtime over SSH, then bootstrap without target internet.'
        : nonEmptyString(step && step.summary),
      note: nonEmptyString(step && step.note),
      command: execution && execution.kind === 'ssh-local-assets'
        ? `local assets over ssh: ${nonEmptyString(step && step.target)}`
        : nonEmptyString(step && step.command),
      manualCommands: normalizeManualCommands(step && step.manualCommands),
      executable,
      executionState: options.execute && executable ? 'pending' : resolveDryRunState(step),
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false
    };
    Object.defineProperty(action, 'execution', {
      value: execution,
      enumerable: false
    });
    return action;
  });
}

function summarizeApplyActions(actions = []) {
  return (Array.isArray(actions) ? actions : []).reduce((summary, action) => {
    summary.total += 1;
    if (action.executable) summary.executable += 1;
    if (action.executionState === 'executed') summary.executed += 1;
    if (action.executionState === 'failed') summary.failed += 1;
    if (action.executionState === 'dry-run') summary.dryRun += 1;
    if (action.executionState === 'manual') summary.manual += 1;
    if (action.executionState === 'needs-input') summary.needsInput += 1;
    if (action.executionState === 'blocked') summary.blocked += 1;
    return summary;
  }, {
    total: 0,
    executable: 0,
    dryRun: 0,
    executed: 0,
    failed: 0,
    manual: 0,
    needsInput: 0,
    blocked: 0
  });
}

function buildNodeBootstrapApplyPreview(report = {}, options = {}) {
  const source = report && typeof report === 'object' ? report : {};
  const executionPlan = Array.isArray(source.executionPlan)
    ? source.executionPlan
    : buildProbeExecutionPlan(source.results || []);
  const applyOptions = {
    ...options,
    execute: false,
    assetMode: normalizeAssetMode(options.assetMode || DEFAULT_ASSET_MODE)
  };
  const actions = buildApplyActions(executionPlan, applyOptions);
  return {
    ok: true,
    mode: 'dry-run',
    assetMode: applyOptions.assetMode,
    executeTimeoutMs: normalizePositiveInteger(options.executeTimeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS, 1000, 24 * 60 * 60 * 1000),
    executeConcurrency: normalizePositiveInteger(options.executeConcurrency, DEFAULT_EXECUTE_CONCURRENCY, 1, 16),
    plan: {
      ok: true,
      actions,
      summary: summarizeApplyActions(actions),
      warnings: Array.isArray(source.warnings) ? source.warnings.slice() : []
    }
  };
}

function safeKill(child) {
  try {
    if (child && typeof child.kill === 'function') child.kill('SIGTERM');
  } catch (_error) {}
}

function appendStream(target, chunk) {
  return `${target}${String(chunk || '')}`.slice(0, 8000);
}

function normalizeArgs(args) {
  return Array.isArray(args) ? args.map((item) => String(item)) : [];
}

function isAiHomeEntrypoint(value) {
  const basename = path.basename(nonEmptyString(value));
  return basename === 'ai-home.js' || basename === 'aih';
}

function resolveBootstrapSpawnSpec(execution, processObj) {
  const command = nonEmptyString(execution && execution.bootstrapCommand);
  const args = normalizeArgs(execution && execution.bootstrapArgs);
  if (command !== 'aih') return { command, args };

  const argv = Array.isArray(processObj && processObj.argv) ? processObj.argv : [];
  const execPath = nonEmptyString(processObj && processObj.execPath);
  const entrypoint = nonEmptyString(argv[1]);
  if (!execPath || !isAiHomeEntrypoint(entrypoint)) return { command, args };

  return {
    command: execPath,
    args: [entrypoint, ...args]
  };
}

function createStructuredRunner(deps = {}) {
  const spawnImpl = deps.spawnImpl || spawn;
  const processObj = deps.processObj || process;
  return function runStructuredCommand(command, options = {}) {
    const execution = options && options.action && options.action.execution;
    if (execution && execution.kind === 'ssh-local-assets') {
      return runSshLocalAssetBootstrap(execution, {
        timeoutMs: options.timeoutMs,
        nodeDistDir: execution.nodeDistDir,
        nodeVersion: execution.nodeVersion,
        sourceRef: execution.sourceRef
      }, deps);
    }
    if (!execution || execution.kind !== 'ssh-pipe') {
      return Promise.resolve({
        status: 1,
        stdout: '',
        stderr: 'unsupported bootstrap execution descriptor',
        timedOut: false
      });
    }
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let finished = false;
      let bootstrapClosed = false;
      let sshClosed = false;
      let bootstrapStatus = null;
      let sshStatus = null;
      let timer = null;

      const done = (result) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        resolve({
          status: Number(result.status || 0),
          signal: result.signal || '',
          stdout,
          stderr,
          timedOut: Boolean(result.timedOut)
        });
      };
      const maybeDone = () => {
        if (!bootstrapClosed || !sshClosed) return;
        const status = bootstrapStatus && bootstrapStatus !== 0 ? bootstrapStatus : (sshStatus || 0);
        done({ status });
      };

      let bootstrapChild;
      let sshChild;
      try {
        const bootstrapSpec = resolveBootstrapSpawnSpec(execution, processObj);
        bootstrapChild = spawnImpl(bootstrapSpec.command, bootstrapSpec.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: processObj.env || process.env
        });
        sshChild = spawnImpl(execution.sshCommand, normalizeArgs(execution.sshArgs), {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: processObj.env || process.env
        });
      } catch (error) {
        stderr = appendStream(stderr, (error && error.message) || error || '');
        safeKill(bootstrapChild);
        safeKill(sshChild);
        done({ status: 1 });
        return;
      }

      timer = setTimeout(() => {
        safeKill(bootstrapChild);
        safeKill(sshChild);
        done({ status: 124, timedOut: true });
      }, normalizePositiveInteger(options.timeoutMs, DEFAULT_EXECUTE_TIMEOUT_MS, 1000, 24 * 60 * 60 * 1000));

      if (bootstrapChild.stdout && sshChild.stdin && typeof bootstrapChild.stdout.pipe === 'function') {
        bootstrapChild.stdout.pipe(sshChild.stdin);
      }
      if (sshChild.stdin && typeof sshChild.stdin.on === 'function') {
        sshChild.stdin.on('error', () => {});
      }

      if (bootstrapChild.stderr && typeof bootstrapChild.stderr.on === 'function') {
        bootstrapChild.stderr.on('data', (chunk) => { stderr = appendStream(stderr, chunk); });
      }
      if (sshChild.stdout && typeof sshChild.stdout.on === 'function') {
        sshChild.stdout.on('data', (chunk) => { stdout = appendStream(stdout, chunk); });
      }
      if (sshChild.stderr && typeof sshChild.stderr.on === 'function') {
        sshChild.stderr.on('data', (chunk) => { stderr = appendStream(stderr, chunk); });
      }

      if (typeof bootstrapChild.on === 'function') {
        bootstrapChild.on('error', (error) => {
          stderr = appendStream(stderr, (error && error.message) || error || '');
          bootstrapStatus = 1;
          bootstrapClosed = true;
          if (sshChild.stdin && typeof sshChild.stdin.end === 'function') sshChild.stdin.end();
          maybeDone();
        });
        bootstrapChild.on('close', (code) => {
          bootstrapStatus = code === null ? 1 : Number(code);
          bootstrapClosed = true;
          if (sshChild.stdin && typeof sshChild.stdin.end === 'function') sshChild.stdin.end();
          maybeDone();
        });
      } else {
        bootstrapStatus = 1;
        bootstrapClosed = true;
      }

      if (typeof sshChild.on === 'function') {
        sshChild.on('error', (error) => {
          stderr = appendStream(stderr, (error && error.message) || error || '');
          sshStatus = 1;
          sshClosed = true;
          maybeDone();
        });
        sshChild.on('close', (code) => {
          sshStatus = code === null ? 1 : Number(code);
          sshClosed = true;
          maybeDone();
        });
      } else {
        sshStatus = 1;
        sshClosed = true;
      }
      maybeDone();
    });
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function executeApplyActions(actions, options, deps = {}) {
  const commandRunner = deps.commandRunner || createStructuredRunner(deps);
  await mapWithConcurrency(actions, options.executeConcurrency, async (action) => {
    if (!action.executable) return;
    const result = await commandRunner(action.command, {
      target: action.target,
      action,
      timeoutMs: options.executeTimeoutMs
    });
    action.exitCode = Number(result && result.status) || 0;
    action.stdout = nonEmptyString(result && result.stdout).slice(0, 4000);
    action.stderr = nonEmptyString(result && result.stderr).slice(0, 4000);
    action.timedOut = Boolean(result && result.timedOut);
    action.executionState = action.exitCode === 0 && !action.timedOut ? 'executed' : 'failed';
  });
}

async function runNodeBootstrapApply(rawArgs = [], deps = {}) {
  const options = parseNodeBootstrapApplyArgs(rawArgs);
  if (options.execute && !options.assumeYes) {
    const error = new Error('bootstrap_apply_confirmation_required');
    error.code = 'bootstrap_apply_confirmation_required';
    throw error;
  }
  if (options.execute) {
    assertExecuteInputsComplete(options.probeArgs, options);
  }

  const probeRunner = deps.runNodeBootstrapProbe || runNodeBootstrapProbe;
  const probeResult = await probeRunner(options.probeArgs, deps);
  const report = probeResult && probeResult.report && typeof probeResult.report === 'object'
    ? probeResult.report
    : {};
  const executionPlan = Array.isArray(report.executionPlan)
    ? report.executionPlan
    : buildProbeExecutionPlan(report.results || []);
  const actions = buildApplyActions(executionPlan, options);
  let summary = summarizeApplyActions(actions);
  let planError = '';
  let planMessage = '';
  if (options.execute && summary.executable === 0) {
    planError = NO_EXECUTABLE_ACTIONS_ERROR;
    planMessage = NO_EXECUTABLE_ACTIONS_MESSAGE;
  }
  if (options.execute && !planError) {
    await executeApplyActions(actions, options, deps);
    summary = summarizeApplyActions(actions);
  }
  const warnings = Array.isArray(report.warnings) ? report.warnings.slice() : [];
  if (planMessage && !warnings.includes(planMessage)) warnings.push(planMessage);
  const ok = options.execute ? !planError && summary.failed === 0 : true;
  return {
    ok,
    json: Boolean(options.json || probeResult && probeResult.json),
    mode: options.execute ? 'execute' : 'dry-run',
    assetMode: options.assetMode,
    executeTimeoutMs: options.executeTimeoutMs,
    executeConcurrency: options.executeConcurrency,
    probe: {
      ok: Boolean(probeResult && probeResult.ok),
      report
    },
    plan: {
      ok,
      ...(planError ? { error: planError, message: planMessage } : {}),
      actions,
      summary,
      warnings
    }
  };
}

function formatActionLine(action) {
  const state = String(action.executionState || '').toUpperCase();
  return `${action.order}. ${state} ${action.title}: ${action.target}`;
}

function appendManualCommands(lines, manualCommands) {
  const commands = normalizeManualCommands(manualCommands);
  if (!commands.length) return;
  lines.push('     manual commands:');
  commands.forEach((item) => {
    lines.push(`       - ${item.label || item.key || 'command'}: ${item.command}`);
    if (item.note) lines.push(`         note: ${item.note}`);
  });
}

function formatNodeBootstrapApplyReport(result) {
  const source = result && typeof result === 'object' ? result : {};
  const plan = source.plan && typeof source.plan === 'object' ? source.plan : {};
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const summary = plan.summary || summarizeApplyActions(actions);
  const lines = [
    '[aih] node bootstrap apply',
    `[aih] mode: ${source.mode === 'execute' ? 'execute' : 'dry-run'}`,
    `[aih] asset mode: ${source.assetMode || DEFAULT_ASSET_MODE}`,
    `[aih] execute concurrency: ${Number(source.executeConcurrency || 0) || DEFAULT_EXECUTE_CONCURRENCY}`,
    `[aih] actions: total:${summary.total || 0}, executable:${summary.executable || 0}, dry-run:${summary.dryRun || 0}, executed:${summary.executed || 0}, failed:${summary.failed || 0}, manual:${summary.manual || 0}, needs-input:${summary.needsInput || 0}, blocked:${summary.blocked || 0}`
  ];

  const probeReport = source.probe && source.probe.report;
  if (probeReport && (Array.isArray(probeReport.results) || Array.isArray(probeReport.executionPlan))) {
    lines.push('');
    lines.push(formatNodeBootstrapProbeReport(probeReport));
  }

  if (Array.isArray(plan.warnings) && plan.warnings.length) {
    lines.push('');
    lines.push('[aih] apply warnings:');
    plan.warnings.forEach((warning) => lines.push(`  - ${warning}`));
  }

  lines.push('');
  lines.push('[aih] apply actions:');
  actions.forEach((action) => {
    lines.push(`  ${formatActionLine(action)}`);
    lines.push(`     channel: ${action.channel}, probe status: ${action.probeStatus}`);
    if (action.summary) lines.push(`     next: ${action.summary}`);
    if (action.command) lines.push(`     command: ${action.command}`);
    appendManualCommands(lines, action.manualCommands);
    if (action.note) lines.push(`     note: ${action.note}`);
    if (action.executionState === 'failed') {
      lines.push(`     exit: ${action.exitCode}${action.timedOut ? ' (timeout)' : ''}`);
      if (action.stderr) lines.push(`     stderr: ${action.stderr}`);
    }
  });

  if (source.mode !== 'execute' && summary.executable > 0) {
    lines.push('');
    lines.push('[aih] dry-run only. Re-run with --execute --yes to execute SSH-ready bootstrap actions.');
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_EXECUTE_CONCURRENCY,
  DEFAULT_EXECUTE_TIMEOUT_MS,
  buildNodeBootstrapApplyArgs,
  buildNodeBootstrapApplyCommand,
  buildNodeBootstrapApplyPreview,
  parseNodeBootstrapApplyArgs,
  resolveRequiredExecuteInputs,
  buildApplyActions,
  summarizeApplyActions,
  createStructuredRunner,
  formatNodeBootstrapApplyReport,
  runNodeBootstrapApply
};
