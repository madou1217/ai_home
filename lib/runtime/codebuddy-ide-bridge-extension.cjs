'use strict';

// This standard user extension calls only the official public command registry.
// It does not load the vendor's internals or request the restricted agentManager API.
const fs = require('node:fs');
const path = require('node:path');
const {
  bridgeError, readPrivateJson, writePrivateJson, ensurePrivateDirectory, processAlive
} = require('./codebuddy-ide-bridge-files');

const PREFIX = 'tencentcloud.codingcopilot.';
const ID = /^[a-f0-9]{32}$/;
const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_NATIVE_INDEX_BYTES = 8 * 1024 * 1024;
const normalizeModel = model => ['auto', 'default-model'].includes(String(model).toLowerCase())
  ? 'default-model' : String(model || '').trim();

function createCodebuddyIdeCommandBridge(options) {
  const { binding, executeCommand, workspacePaths } = options;
  const mailbox = binding.mailboxDir;
  const pid = options.pid || process.pid;
  const hostId = String(pid);
  const statusFile = path.join(mailbox, 'hosts', `${hostId}.json`);
  const lockFile = path.join(mailbox, 'writer.json');
  let checking = false, disposed = false, heartbeatTimer, requestTimer;
  const active = new Set();

  function status(context) {
    return { version: binding.version, accountRef: binding.accountRef, provider: binding.provider,
      userId: binding.userId, pid, at: Date.now(), ready: !disposed
        && context?.authenticated === true && context.userId === binding.userId,
      workspacePaths: workspacePaths() };
  }

  async function heartbeat() {
    try {
      const context = await executeCommand(`${PREFIX}getContext`);
      writePrivateJson(statusFile, status(context));
    } catch (_) {
      writePrivateJson(statusFile, status(null));
    }
  }

  function acquireWriter(runId) {
    // A second IDE window or a restarted server cannot dispatch a second turn
    // while the first official command is still running.
    const previous = readPrivateJson(lockFile);
    if (previous && !processAlive(previous.pid)) {
      if (!RUN_ID.test(previous.runId)) throw bridgeError('codebuddy_ide_writer_invalid');
      writePrivateJson(path.join(mailbox, 'results', `${previous.runId}.json`), {
        runId: previous.runId, error: 'codebuddy_ide_runtime_restarted'
      });
      fs.unlinkSync(lockFile);
    }
    try { fs.writeFileSync(lockFile, JSON.stringify({ runId, pid }), { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw bridgeError('native_session_busy');
      throw error;
    }
  }

  function validateRequest(request) {
    if (!request || !RUN_ID.test(request.runId) || request.hostId !== hostId
      || request.accountRef !== binding.accountRef || request.provider !== binding.provider
      || !ID.test(request.sessionId) || !ID.test(request.projectHash)
      || typeof request.prompt !== 'string' || !request.prompt.trim()
      || !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()
      || !Number.isFinite(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 600000) {
      throw bridgeError('codebuddy_ide_invalid_request');
    }
    if (!workspacePaths().includes(request.cwd)) throw bridgeError('codebuddy_ide_workspace_mismatch');
    const project = path.join(binding.historyRoot, request.projectHash);
    const index = readPrivateJson(path.join(project, request.sessionId, 'index.json'), MAX_NATIVE_INDEX_BYTES);
    const conversation = readPrivateJson(path.join(project, 'index.json'), MAX_NATIVE_INDEX_BYTES)?.conversations
      ?.find(row => row.id === request.sessionId);
    if (!conversation || !Array.isArray(index?.messages) || !Array.isArray(index?.requests)) {
      throw bridgeError('codebuddy_ide_session_not_found');
    }
    const model = normalizeModel(request.model);
    if (model && model !== normalizeModel(conversation.selectedModelId)) {
      throw bridgeError('codebuddy_ide_model_switch_required', '请先在 CodeBuddy Desktop 中选择该模型，再续聊同一会话。');
    }
  }

  async function execute(request) {
    let ownsWriter = false;
    try {
      validateRequest(request);
      acquireWriter(request.runId);
      ownsWriter = true;
      const context = await executeCommand(`${PREFIX}getContext`);
      if (!context?.authenticated || context.userId !== binding.userId) {
        throw bridgeError('codebuddy_ide_account_mismatch');
      }
      const target = await executeCommand(`${PREFIX}isAgentBusy`, request.sessionId);
      const current = await executeCommand(`${PREFIX}isAgentBusy`);
      if (target?.busy || current?.busy) throw bridgeError('native_session_busy');
      // Mark dispatch before invoking the vendor. An uncertain outcome is never
      // replayed, even if the server or extension host disappears afterwards.
      writePrivateJson(path.join(mailbox, 'results', `${request.runId}.json`), {
        runId: request.runId, state: 'dispatched', sessionId: request.sessionId
      });
      const result = await executeCommand(`${PREFIX}chat.sendMessage`, {
        message: request.prompt,
        options: { conversationId: request.sessionId, headless: false, prefillOnly: false,
          waitForCompletion: true, withSummary: false, timeout: request.timeoutMs }
      });
      if (result?.id !== request.sessionId || result?.completion?.conversationId !== request.sessionId) {
        throw bridgeError(result?.error === 'conversation_not_found'
          ? 'codebuddy_ide_session_not_found' : 'codebuddy_ide_session_mismatch');
      }
      writePrivateJson(path.join(mailbox, 'results', `${request.runId}.json`), {
        runId: request.runId, state: 'settled', result
      });
    } catch (error) {
      writePrivateJson(path.join(mailbox, 'results', `${request.runId}.json`), {
        runId: request.runId, error: error.code || 'codebuddy_ide_command_failed',
        message: error.code ? error.message : 'CodeBuddy 官方命令执行失败。'
      });
    } finally {
      if (ownsWriter && readPrivateJson(lockFile)?.runId === request.runId) fs.unlinkSync(lockFile);
    }
  }

  async function poll() {
    if (checking || disposed) return;
    checking = true;
    try {
      for (const name of fs.readdirSync(path.join(mailbox, 'requests'))) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name) || active.has(name)) continue;
        const file = path.join(mailbox, 'requests', name);
        if (fs.existsSync(`${file}.accepted`)) continue;
        const request = readPrivateJson(file);
        if (!request || request.hostId !== hostId || name !== `${request.runId}.json`) continue;
        // Atomic rename claims a request exactly once; accepted files are never
        // consumed again after reload, timeout or connection loss.
        try { fs.renameSync(file, `${file}.accepted`); } catch (_) { continue; }
        active.add(name);
        execute(request).catch(() => {}).finally(() => active.delete(name));
      }
    } finally { checking = false; }
  }

  return {
    poll, heartbeat,
    async start() {
      for (const name of ['hosts', 'requests', 'results']) ensurePrivateDirectory(path.join(mailbox, name));
      await heartbeat();
      heartbeatTimer = setInterval(() => heartbeat().catch(() => {}), 2000);
      requestTimer = setInterval(() => poll().catch(() => {}), 200);
    },
    dispose() {
      disposed = true;
      clearInterval(heartbeatTimer);
      clearInterval(requestTimer);
      try { writePrivateJson(statusFile, status(null)); } catch (_) {}
    }
  };
}

async function activate(context) {
  const vscode = require('vscode');
  const binding = readPrivateJson(path.join(context.extensionPath, 'binding.json'));
  if (!binding) throw bridgeError('codebuddy_ide_bridge_binding_missing');
  const bridge = createCodebuddyIdeCommandBridge({ binding,
    executeCommand: (...args) => vscode.commands.executeCommand(...args),
    workspacePaths: () => (vscode.workspace.workspaceFolders || []).flatMap(folder => {
      try { return [fs.realpathSync(folder.uri.fsPath)]; } catch (_) { return []; }
    }) });
  context.subscriptions.push(bridge);
  await bridge.start();
}

module.exports = { activate, createCodebuddyIdeCommandBridge };
