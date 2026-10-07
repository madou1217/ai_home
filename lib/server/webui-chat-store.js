'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getRealHome } = require('../sessions/session-reader');
const { writeFileAtomic } = require('../runtime/atomic-file-write');

// WebUI 纯聊天会话属于 aih 自己的数据，只放在 ~/.ai_home 下，不在宿主 home
// 另起目录。目录只在真正写入时创建，读取/列表不凭空建空目录。
function getChatStoreDir(hostHome) {
  return path.join(hostHome || getRealHome(), '.ai_home', 'chat-sessions');
}

function listChatSessions(hostHome) {
  const dir = getChatStoreDir(hostHome);
  if (!fs.existsSync(dir)) return [];
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const session = JSON.parse(content);
        if (session && session.id) {
          sessions.push(session);
        }
      } catch (_e) {}
    }
    return sessions.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  } catch (_error) {
    return [];
  }
}

function readChatSession(sessionId, hostHome) {
  if (!sessionId) return null;
  const dir = getChatStoreDir(hostHome);
  const filePath = path.join(dir, `${sessionId}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function saveChatSession(session, hostHome) {
  if (!session || !session.id) return null;
  const dir = getChatStoreDir(hostHome);
  const filePath = path.join(dir, `${session.id}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(fs, filePath, JSON.stringify(session, null, 2), 'utf8');
    return session;
  } catch (_error) {
    return null;
  }
}

function deleteChatSession(sessionId, hostHome) {
  if (!sessionId) return false;
  const dir = getChatStoreDir(hostHome);
  const filePath = path.join(dir, `${sessionId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (_error) {
      return false;
    }
  }
  return false;
}

function appendMessageToChatSession(sessionId, userMessage, assistantMessage, meta = {}, hostHome) {
  if (!sessionId) return null;
  let session = readChatSession(sessionId, hostHome);
  const now = Date.now();
  if (!session) {
    const userText = typeof userMessage === 'string'
      ? userMessage
      : (userMessage && userMessage.content || '');
    session = {
      id: sessionId,
      title: (String(userText || '').trim().slice(0, 50)) || '新对话',
      provider: meta.provider || 'claude',
      model: meta.model || '',
      accountRef: meta.accountRef || '',
      mode: 'chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  session.updatedAt = now;
  if (meta.model) session.model = meta.model;
  if (meta.provider) session.provider = meta.provider;
  if (meta.accountRef) session.accountRef = meta.accountRef;

  const currentModel = meta.model || session.model || '';

  if (userMessage) {
    const formattedUser = typeof userMessage === 'string'
      ? { role: 'user', content: userMessage, timestamp: now, ...(currentModel ? { model: currentModel } : {}) }
      : { role: 'user', ...userMessage, timestamp: userMessage.timestamp || now, model: userMessage.model || currentModel };
    session.messages.push(formattedUser);
  }

  if (assistantMessage) {
    const formattedAssistant = typeof assistantMessage === 'string'
      ? {
          role: 'assistant',
          content: assistantMessage,
          timestamp: now,
          ...(currentModel ? { model: currentModel } : {}),
          ...(meta.metrics ? { metrics: meta.metrics } : {})
        }
      : {
          role: 'assistant',
          ...assistantMessage,
          timestamp: assistantMessage.timestamp || now,
          model: assistantMessage.model || currentModel,
          metrics: assistantMessage.metrics || meta.metrics
        };
    session.messages.push(formattedAssistant);
  }

  saveChatSession(session, hostHome);
  return session;
}

module.exports = {
  getChatStoreDir,
  listChatSessions,
  readChatSession,
  saveChatSession,
  deleteChatSession,
  appendMessageToChatSession,
};
