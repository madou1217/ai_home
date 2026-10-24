#!/usr/bin/env node
'use strict';

// Read-only local smoke for the provider-session event/title pipeline. It sends
// bounded synthetic hook payloads to an already running AIH server and reads
// only the resulting state snapshots. No provider credentials or live prompts
// are needed, and no provider configuration is modified.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createBuiltinTitleSources } = require('../lib/cli/services/pty/terminal-title/sources');
const { createTitleSourceRegistry } = require('../lib/cli/services/pty/terminal-title/registry');

const HOME = process.env.AIH_HOME_DIR || path.join(require('node:os').homedir(), '.ai_home');
const baseUrlArg = process.argv.find((arg) => arg.startsWith('--base-url='));
const BASE_URL = String(baseUrlArg ? baseUrlArg.slice('--base-url='.length) : 'http://127.0.0.1:9527').replace(/\/$/, '');
const PROJECT_PATH = path.resolve(process.cwd());

function key(session) {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: session.provider,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    projectDirName: ''
  })).digest('hex');
}

function post(body) {
  const output = execFileSync('curl', [
    '--noproxy', '*', '-sS', '-X', 'POST',
    `${BASE_URL}/v0/webui/session-events/provider-hook`,
    '-H', 'content-type: application/json',
    '--data', JSON.stringify(body),
    '-w', '\n%{http_code}'
  ], { encoding: 'utf8' });
  const lines = output.trimEnd().split('\n');
  const status = Number(lines.pop());
  const payload = JSON.parse(lines.join('\n'));
  if (status < 200 || status >= 300 || !payload.ok) throw new Error(`hook failed: HTTP ${status}`);
  return payload;
}

function readState(session) {
  const filePath = path.join(HOME, 'run', 'provider-session-state', `${key(session)}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const claude = { provider: 'claude', sessionId: `smoke-claude-${process.pid}`, projectPath: PROJECT_PATH };
  const codex = { provider: 'codex', sessionId: `smoke-codex-${process.pid}`, projectPath: PROJECT_PATH };
  post({ ...claude, eventName: 'Statusline', statusline: { contextPct: 68, tokens: 12000 }, eventId: `${claude.sessionId}:status` });
  post({ ...claude, eventName: 'StopFailure', error: 'network unavailable', eventId: `${claude.sessionId}:failure` });
  post({ ...codex, eventName: 'SessionStart', correlationId: `${codex.sessionId}:corr`, eventId: `${codex.sessionId}:start` });
  post({ ...codex, eventName: 'Stop', correlationId: `${codex.sessionId}:corr`, eventId: `${codex.sessionId}:stop` });

  const registry = createTitleSourceRegistry({ sources: createBuiltinTitleSources() });
  const claudeState = readState(claude);
  const codexState = readState(codex);
  const frames = registry.collectFrames({ provider: 'claude', accountId: 'smoke', model: 'smoke-model', sessionState: claudeState });
  process.stdout.write(`${JSON.stringify({
    baseUrl: BASE_URL,
    isolated: claudeState.session.sessionId !== codexState.session.sessionId,
    claude: { turnState: claudeState.turnState, error: claudeState.error, statusline: claudeState.statusline, frames },
    codex: { turnState: codexState.turnState, recentEventIds: codexState.recentEventIds }
  }, null, 2)}\n`);
}

main();
