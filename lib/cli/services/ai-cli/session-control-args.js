'use strict';

const persistentSession = require('../../../runtime/persistent-session');

// Only AIH prefix controls are consumed. Validate all input before mutating intent.
function extractSessionLabelFlag(args, env) {
  const input = Array.isArray(args) ? args.slice() : [];
  const out = [];
  let label = '';
  let resume = false;
  let mirror = false;
  let remote = '';
  let headlessRunner = '';
  for (let i = 0; i < input.length; i += 1) {
    const token = String(input[i] == null ? '' : input[i]);
    if (token === '--') {
      out.push(...input.slice(i));
      break;
    }
    if (token === '-S' || token === '--session') {
      const next = input[i + 1];
      if (next == null || String(next) === '' || String(next).startsWith('-')) return { args: input, error: `missing_value:${token}` };
      label = String(next); i += 1;
      continue;
    }
    const m = token.match(/^(?:--session|-S)=(.*)$/);
    if (m) {
      if (!m[1]) return { args: input, error: 'missing_value:--session' };
      label = m[1]; continue;
    }
    if (token === '-R' || token === '--aih-resume') { resume = true; continue; }
    if (token === '-M' || token === '--aih-mirror') { mirror = true; continue; }
    if (token === '--remote' || token === '--aih-remote') {
      const next = input[i + 1];
      if (next == null || String(next) === '' || String(next).startsWith('-')) return { args: input, error: `missing_value:${token}` };
      remote = String(next); i += 1;
      continue;
    }
    const rm = token.match(/^(?:--remote|--aih-remote)=(.*)$/);
    if (rm) {
      if (!rm[1]) return { args: input, error: 'missing_value:--remote' };
      remote = rm[1]; continue;
    }
    // `--aih-headless-runner native|app-server|auto`：headless 走哪条通路（使用时可选）。
    // 默认 auto = 由 provider 策略的 shouldPrefer() 决定（如 zcode 的 Start Plan 账号走
    // app-server）。namespaced 到 aih，避免与原生 CLI 的旗标撞名。
    if (token === '--aih-headless-runner' || token === '--aih-runner') {
      const next = input[i + 1];
      if (next == null || String(next) === '' || String(next).startsWith('-')) return { args: input, error: `missing_value:${token}` };
      headlessRunner = String(next); i += 1;
      continue;
    }
    const hr = token.match(/^(?:--aih-headless-runner|--aih-runner)=(.*)$/);
    if (hr) {
      if (!hr[1]) return { args: input, error: 'missing_value:--aih-headless-runner' };
      headlessRunner = hr[1]; continue;
    }
    out.push(input[i]);
  }
  if (label && env) persistentSession.setSessionIntentField(env, 'label', label);
  if (resume && env) persistentSession.setSessionIntentField(env, 'resume', '1');
  if (mirror && env) persistentSession.setSessionIntentField(env, 'mirror', '1');
  if (remote && env) persistentSession.setSessionIntentField(env, 'remoteSsh', remote);
  return { args: out, headlessRunner: headlessRunner.trim().toLowerCase() };
}

module.exports = { extractSessionLabelFlag };
