'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveCodebuddyIdeBridgeBinding } = require('../runtime/codebuddy-ide-bridge');
const { bridgeError, readPrivateJson, writePrivateJson, processAlive } = require('../runtime/codebuddy-ide-bridge-files');
const { discoverCodebuddyIdeSessions } = require('../sessions/codebuddy-ide-store');
const { readSessionMessages } = require('../sessions/session-reader');
const { collectAssistantReply } = require('./native-session-chat-transcript');
const { normalizeApprovalMode } = require('./native-approval-modes');

function spawnCodebuddyIdeSessionStream(options) {
  const binding = resolveCodebuddyIdeBridgeBinding(options);
  if (!binding) throw bridgeError('codebuddy_ide_account_unavailable');
  const session = discoverCodebuddyIdeSessions({ ...options, providers: [options.provider] })
    .find(row => row.provider === options.provider && row.accountRef === options.accountRef
      && row.home === binding.profileDir && row.sessionId === options.sessionId
      && (!options.projectDirName || row.projectDirName === options.projectDirName));
  if (!session?.cwd) throw bridgeError('codebuddy_ide_session_not_in_account', '该 IDE 会话不在所选账号的 Desktop 中，无法精确续聊。');
  if (options.imagePaths?.length || options.interactiveCli || options.terminalMode) {
    throw bridgeError('codebuddy_ide_input_unsupported', '该 IDE 桥接仅支持文本续聊；附件及终端交互请在 Desktop 中操作。');
  }
  if (normalizeApprovalMode(options.approvalMode) !== 'bypass') {
    throw bridgeError('codebuddy_ide_approval_bridge_unavailable', '该 IDE 的审批由官方 Desktop 处理，暂不支持在 WebUI 中确认或切换计划模式。');
  }
  const cwd = fs.realpathSync(session.cwd);
  const hostsDir = path.join(binding.mailboxDir, 'hosts');
  let hosts = [];
  try { hosts = fs.readdirSync(hostsDir).filter(name => /^\d+\.json$/.test(name))
    .map(name => readPrivateJson(path.join(hostsDir, name))).filter(Boolean); } catch (_) {}
  const host = hosts.filter(row => row.version === binding.version && row.ready === true
    && row.accountRef === binding.accountRef && row.provider === binding.provider && row.userId === binding.userId
    && Date.now() - row.at < 15000 && processAlive(row.pid) && row.workspacePaths?.includes(cwd))
    .sort((a, b) => b.at - a.at)[0];
  if (!host) throw bridgeError('codebuddy_ide_bridge_unavailable', '请在该账号的 CodeBuddy Desktop 中打开会话所属项目，再续聊。');
  const params = { sessionId: session.sessionId, projectDirName: session.projectDirName };
  const readerOptions = { aiHomeDir: options.aiHomeDir, hostHomeDir: options.hostHomeDir, accountRef: options.accountRef };
  const beforeMessages = readSessionMessages(options.provider, params, readerOptions);
  const runId = crypto.randomUUID();
  const timeoutMs = Math.min(600000, Math.max(1000, Number(options.timeoutMs) || 600000));
  const resultFile = path.join(binding.mailboxDir, 'results', `${runId}.json`);
  writePrivateJson(path.join(binding.mailboxDir, 'requests', `${runId}.json`), {
    runId, hostId: String(host.pid), accountRef: binding.accountRef, provider: binding.provider,
    sessionId: session.sessionId, projectHash: session.projectDirName.slice(4), cwd,
    prompt: options.prompt, model: options.model, timeoutMs, expiresAt: Date.now() + 15000
  });
  let settled = false, emittedContent = '';
  const emit = event => options.onEvent?.({ provider: options.provider, accountRef: options.accountRef,
    sessionId: session.sessionId, runId, ...event });
  const done = (async () => {
    // Let the caller register the run and send its ready frame first.
    await new Promise(resolve => setTimeout(resolve, 0));
    emit({ type: 'status', message: '正在续聊 CodeBuddy Desktop 原会话；审批由 Desktop 处理。' });
    const deadline = Date.now() + timeoutMs + 10000;
    let dispatched = false;
    while (Date.now() < deadline) {
      const result = readPrivateJson(resultFile);
      if (result?.runId === runId) {
        if (result.error) throw bridgeError(result.error, result.message || result.error);
        dispatched ||= result.state === 'dispatched' || result.state === 'settled';
      }
      const afterMessages = dispatched ? readSessionMessages(options.provider, params, readerOptions) : beforeMessages;
      const content = collectAssistantReply(beforeMessages, afterMessages);
      if (content.startsWith(emittedContent) && content.length > emittedContent.length) {
        emit({ type: 'delta', delta: content.slice(emittedContent.length), content });
        emittedContent = content;
      }
      if (result?.runId === runId && result.state === 'settled') {
        const completion = result.result?.completion;
        if (result.result?.id !== session.sessionId || completion?.conversationId !== session.sessionId) {
          throw bridgeError('codebuddy_ide_session_mismatch');
        }
        if (!completion.success) throw bridgeError('codebuddy_ide_command_failed', completion.error || 'CodeBuddy 原生任务失败。');
        const additions = afterMessages.slice(beforeMessages.length);
        if (!additions.some(message => message.role === 'user' && message.content === options.prompt) || !content) {
          throw bridgeError('codebuddy_ide_transcript_missing');
        }
        return { content, afterMessages, sessionId: session.sessionId, projectDirName: session.projectDirName };
      }
      if (!processAlive(host.pid)) throw bridgeError('codebuddy_ide_runtime_restarted');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw bridgeError('codebuddy_ide_timeout', '等待 CodeBuddy Desktop 超时；任务可能仍在运行，请在 Desktop 查看，系统不会重放请求。');
  })().finally(() => { settled = true; });
  return { runId, child: null, done,
    abort() {
      if (!settled) throw bridgeError('codebuddy_ide_cancel_requires_desktop', '官方命令没有取消入口，请在 CodeBuddy Desktop 中停止当前任务。');
    }
  };
}

module.exports = { spawnCodebuddyIdeSessionStream };
