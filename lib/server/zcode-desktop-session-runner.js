'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveZcodeDesktopBridgeBinding } = require('../runtime/zcode-desktop-bridge-binding');
const { bridgeError, readPrivateJson, writePrivateJson, processAlive } = require('../runtime/native-session-bridge-files');
const { readSessionMessages, readProjectsFromHostByProviders } = require('../sessions/session-reader');
const { collectAssistantReply } = require('./native-session-chat-transcript');
const { normalizeApprovalMode } = require('./native-approval-modes');

function spawnZcodeDesktopSessionStream(options) {
  const binding = resolveZcodeDesktopBridgeBinding(options);
  if (!options.sessionId) throw bridgeError('zcode_desktop_resume_required', '请在 ZCode Desktop 中新建会话；WebUI 可续聊已有原生会话。');
  if (options.imagePaths?.length || options.interactiveCli || options.terminalMode || options.initialInput) {
    throw bridgeError('zcode_desktop_input_unsupported', 'ZCode Desktop 桥接目前支持文本续聊；附件和交互命令请在 Desktop 操作。');
  }
  const approvalMode = normalizeApprovalMode(options.approvalMode);
  if (approvalMode === 'confirm') throw bridgeError('zcode_desktop_approval_requires_desktop', 'ZCode 的权限确认由 Desktop 处理，请使用计划模式或在 Desktop 续聊。');
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 1024 * 1024) {
    throw bridgeError('zcode_desktop_invalid_request');
  }
  const readerOptions = { accountRef: options.accountRef, aiHomeDir: options.aiHomeDir, hostHomeDir: options.hostHomeDir };
  const project = readProjectsFromHostByProviders(['zcode'], readerOptions).find(row => row.sessions.some(session => session.id === options.sessionId));
  if (!project?.path) throw bridgeError('zcode_desktop_session_not_found');
  const cwd = fs.realpathSync(project.path);
  if (options.projectPath && fs.realpathSync(options.projectPath) !== cwd) throw bridgeError('zcode_desktop_workspace_mismatch');
  const params = { sessionId: options.sessionId, projectDirName: project.path };
  const beforeMessages = readSessionMessages('zcode', params, readerOptions);
  let hosts = [];
  try { hosts = fs.readdirSync(path.join(binding.mailboxDir, 'hosts')).filter(name => /^\d+\.json$/.test(name))
    .map(name => readPrivateJson(path.join(binding.mailboxDir, 'hosts', name))).filter(Boolean); } catch (_) {}
  const host = hosts.filter(row => row.ready && row.version === binding.version && row.provider === 'zcode'
    && row.accountRef === binding.accountRef && row.identity === binding.identity
    && Date.now() - row.at < 15000 && processAlive(row.pid)
    && row.sessions?.some(session => {
      try { return session.sessionId === options.sessionId && fs.realpathSync(session.cwd) === cwd; } catch (_) { return false; }
    }))
    .sort((a, b) => b.at - a.at)[0];
  if (!host) throw bridgeError('zcode_desktop_bridge_unavailable', '请在该账号的 ZCode Desktop 中打开原会话，再从 WebUI 续聊。');
  const runId = crypto.randomUUID();
  const expiresAt = Date.now() + 15000;
  const resultFile = path.join(binding.mailboxDir, 'results', `${runId}.json`);
  writePrivateJson(path.join(binding.mailboxDir, 'requests', `${runId}.json`), {
    runId, hostId: String(host.pid), accountRef: binding.accountRef, identity: binding.identity,
    sessionId: options.sessionId, cwd, prompt: options.prompt, model: options.model,
    approvalMode, expiresAt
  });
  let settled = false, emittedContent = '';
  const done = (async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    options.onEvent?.({ type: 'status', provider: 'zcode', accountRef: options.accountRef,
      runId, sessionId: options.sessionId, message: '正在续聊 ZCode Desktop 原会话。' });
    const deadline = Date.now() + Math.min(600000, Math.max(1000, Number(options.timeoutMs) || 600000));
    let dispatched = false, transcriptDeadline;
    while (Date.now() < deadline) {
      const result = readPrivateJson(resultFile);
      if (!result && Date.now() > expiresAt) throw bridgeError('zcode_desktop_request_expired');
      if (result?.runId === runId && result.error) throw bridgeError(result.error, result.message || result.error);
      dispatched ||= result?.runId === runId && ['dispatched', 'settled'].includes(result.state);
      const afterMessages = dispatched ? readSessionMessages('zcode', params, readerOptions) : beforeMessages;
      const content = collectAssistantReply(beforeMessages, afterMessages);
      if (content.startsWith(emittedContent) && content.length > emittedContent.length) {
        options.onEvent?.({ type: 'delta', provider: 'zcode', accountRef: options.accountRef,
          runId, sessionId: options.sessionId, delta: content.slice(emittedContent.length), content });
        emittedContent = content;
      }
      if (result?.runId === runId && result.state === 'settled') {
        if (result.sessionId !== options.sessionId) throw bridgeError('zcode_desktop_transcript_missing');
        const promptPersisted = afterMessages.slice(beforeMessages.length)
          .some(message => message.role === 'user' && message.content === options.prompt);
        if (content && promptPersisted) {
          return { content, afterMessages, sessionId: options.sessionId, projectDirName: params.projectDirName };
        }
        // The native completion event can precede the SQLite writer's flush.
        // Wait for its stored turn; never send the accepted prompt again.
        transcriptDeadline ??= Date.now() + 5000;
        if (Date.now() >= transcriptDeadline) {
          throw bridgeError('zcode_desktop_transcript_missing');
        }
      }
      if (!processAlive(host.pid)) throw bridgeError('zcode_desktop_runtime_restarted');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw bridgeError('zcode_desktop_timeout', '等待 ZCode Desktop 超时；请求不会重放，请在 Desktop 查看任务状态。');
  })().finally(() => { settled = true; });
  return { runId, child: null, done, abort() {
    if (!settled) writePrivateJson(path.join(binding.mailboxDir, 'cancellations', `${runId}.json`), { runId, hostId: String(host.pid) });
  } };
}

module.exports = { spawnZcodeDesktopSessionStream };
