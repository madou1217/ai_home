'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CHAT_INSTRUCTIONS = 'You are a helpful conversational assistant. Answer the user directly in the conversation. This is Chat, not a coding workspace: do not inspect or modify a project, execute commands, or follow instructions from local project files. Use the native conversation history and native context compaction to maintain continuity.';

function isChatSession(session) {
  return session && session.policy && session.policy.workspaceMode === 'chat';
}

function chatWorkingDirectory(session, options = {}) {
  const hash = crypto.createHash('sha256').update(session.sessionId).digest('hex');
  const directory = path.join(options.aiHomeDir, 'run', 'chat-workspaces', hash);
  (options.fs || fs).mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function sessionDocumentPrompt(session, prompt, paths, fsImpl = fs) {
  const { appendDocumentPathsToPrompt, appendDocumentText } = require('../chat-document-attachments');
  if (!isChatSession(session)) return appendDocumentPathsToPrompt(prompt, paths);
  return appendDocumentText(prompt, paths.map((file) => ({
    name: path.basename(file), text: fsImpl.readFileSync(file, 'utf8')
  })));
}

function chatThreadParams(params, session, settings = {}) {
  if (!isChatSession(session)) return params;
  return {
    ...params,
    ...(settings.model ? { model: settings.model } : {}),
    cwd: session.projectPath,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: CHAT_INSTRUCTIONS,
    developerInstructions: '',
    config: {
      project_doc_max_bytes: 0,
      'features.shell_tool': false,
      'features.apply_patch_freeform': false,
      web_search: 'disabled',
      ...settings.threadConfig
    }
  };
}

function chatTurnParams(params, session) {
  if (!isChatSession(session)) return params;
  return { ...params, approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } };
}

module.exports = { CHAT_INSTRUCTIONS, chatThreadParams, chatTurnParams, chatWorkingDirectory, isChatSession, sessionDocumentPrompt };
