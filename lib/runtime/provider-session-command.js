'use strict';

const { getProviderDefinition } = require('../provider-catalog');

// Stable verb intent -> shared contract argv, with no provider switch or I/O.
function buildSessionCommand(provider, verb, sessionId = '', extraArgs = []) {
  const name = String(provider || '').trim().toLowerCase();
  const sessions = getProviderDefinition(name)?.nativeBoundary?.sessions;
  const command = sessions && sessions[verb];
  if (!command || !Array.isArray(command.withId)) {
    const tuiOnly = sessions?.flags?.some((flag) => String(flag).startsWith('/'));
    return { ok: false, reason: tuiOnly ? 'resume_in_tui_only' : `${verb}_unsupported`,
      message: tuiOnly ? `${name} 的会话入口在原生 TUI 内，aih 不猜启动参数。`
        : `${name} 未声明 ${verb} 入口，aih 不猜参数；请查看原生 CLI 帮助。` };
  }
  const identity = String(sessionId == null ? '' : sessionId).trim();
  if (/[\s\x00-\x1f\x7f]/.test(identity) || identity.startsWith('-')) {
    return { ok: false, reason: 'resume_identity_invalid', message: '会话身份不能包含空白、控制字符或以 - 开头。' };
  }
  const template = identity ? command.withId : command.withoutId;
  if (!Array.isArray(template) || !template.length) {
    return { ok: false, reason: 'resume_identity_required', message: `${name} 需要精确会话 ID；请先查看原生会话列表。` };
  }
  const slots = template.filter((part) => part === '{sessionId}').length;
  const flags = new Set(sessions.flags || []);
  if (slots !== (identity ? 1 : 0) || template.some((part, index) => part !== '{sessionId}'
    && (typeof part !== 'string' || !part || /[\x00\r\n]/.test(part)
      || ((index === 0 || part.startsWith('-')) && !flags.has(part))))) {
    return { ok: false, reason: 'session_command_contract_invalid', message: `${name} 的会话命令合同无效。` };
  }
  return { ok: true, args: [...template.map((part) => part === '{sessionId}' ? identity : part),
    ...(Array.isArray(extraArgs) ? extraArgs.map(String) : [])] };
}

module.exports = { buildSessionCommand };
