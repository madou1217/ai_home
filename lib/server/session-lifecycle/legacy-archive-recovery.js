'use strict';

const nodePath = require('node:path');

function createLegacyArchiveRecovery(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  if (!hostHomeDir) throw new TypeError('legacy archive recovery hostHomeDir is required');

  return {
    list() {
      return [
        ...listClaudeArchives({ fs, path, hostHomeDir }),
        ...listGeminiArchives({ fs, path, hostHomeDir })
      ];
    },
    unarchive(input = {}) {
      const provider = String(input.provider || '').trim().toLowerCase();
      const sessionId = String(input.sessionId || '').trim();
      if (!sessionId) throw codedError('missing_params', 400, 'sessionId 必填');
      if (provider === 'claude') return restoreClaude({ fs, path, hostHomeDir, sessionId });
      if (provider === 'gemini') return restoreGemini({ fs, path, hostHomeDir, sessionId });
      throw codedError('session_unarchive_unsupported', 422, `${provider} 不支持历史归档恢复`);
    }
  };
}

function listClaudeArchives(context) {
  const { fs, path, hostHomeDir } = context;
  const projectsRoot = path.join(hostHomeDir, '.claude', 'projects');
  const result = [];
  for (const projectDirName of safeDirectoryNames(fs, projectsRoot)) {
    const projectRoot = safeChild(path, projectsRoot, projectDirName);
    const archivedRoot = path.join(projectRoot, '.archived');
    for (const fileName of safeFileNames(fs, archivedRoot, '.jsonl')) {
      const filePath = safeChild(path, archivedRoot, fileName);
      const stats = safeStat(fs, filePath);
      result.push({
        id: fileName.slice(0, -'.jsonl'.length),
        title: readClaudeTitle(fs, filePath),
        provider: 'claude',
        projectDirName,
        origin: 'legacy',
        canUnarchive: true,
        updatedAt: stats ? stats.mtimeMs : 0,
        archivedAt: stats ? stats.mtimeMs : 0
      });
    }
  }
  return result;
}

function listGeminiArchives(context) {
  const { fs, path, hostHomeDir } = context;
  const projectsRoot = path.join(hostHomeDir, '.gemini', 'tmp');
  const result = [];
  for (const projectDirName of safeDirectoryNames(fs, projectsRoot)) {
    const projectRoot = safeChild(path, projectsRoot, projectDirName);
    const archivedRoot = path.join(projectRoot, 'chats', '.archived');
    for (const fileName of safeFileNames(fs, archivedRoot, '.json')) {
      const filePath = safeChild(path, archivedRoot, fileName);
      const data = readJson(fs, filePath);
      if (!data) continue;
      const stats = safeStat(fs, filePath);
      result.push({
        id: String(data.sessionId || fileName.slice(0, -'.json'.length)).trim(),
        title: geminiTitle(data),
        provider: 'gemini',
        projectDirName,
        origin: 'legacy',
        canUnarchive: true,
        updatedAt: stats ? stats.mtimeMs : 0,
        archivedAt: stats ? stats.mtimeMs : 0
      });
    }
  }
  return result;
}

function restoreClaude(context) {
  const { fs, path, hostHomeDir, sessionId } = context;
  const projectsRoot = path.join(hostHomeDir, '.claude', 'projects');
  for (const projectDirName of safeDirectoryNames(fs, projectsRoot)) {
    const projectRoot = safeChild(path, projectsRoot, projectDirName);
    const source = path.join(projectRoot, '.archived', `${sessionId}.jsonl`);
    if (!isSafeDescendant(path, path.join(projectRoot, '.archived'), source) || !safeExists(fs, source)) continue;
    const destination = path.join(projectRoot, `${sessionId}.jsonl`);
    moveWithoutOverwrite(fs, source, destination);
    return { provider: 'claude', sessionId, projectDirName };
  }
  throw codedError('legacy_archive_not_found', 404, '未找到 Claude 历史归档');
}

function restoreGemini(context) {
  const { fs, path, hostHomeDir, sessionId } = context;
  const projectsRoot = path.join(hostHomeDir, '.gemini', 'tmp');
  for (const projectDirName of safeDirectoryNames(fs, projectsRoot)) {
    const chatsRoot = path.join(safeChild(path, projectsRoot, projectDirName), 'chats');
    const archivedRoot = path.join(chatsRoot, '.archived');
    for (const fileName of safeFileNames(fs, archivedRoot, '.json')) {
      const source = safeChild(path, archivedRoot, fileName);
      const data = readJson(fs, source);
      const currentId = String(data && data.sessionId || fileName.slice(0, -'.json'.length)).trim();
      if (currentId !== sessionId) continue;
      moveWithoutOverwrite(fs, source, safeChild(path, chatsRoot, fileName));
      return { provider: 'gemini', sessionId, projectDirName };
    }
  }
  throw codedError('legacy_archive_not_found', 404, '未找到 Gemini 历史归档');
}

function readClaudeTitle(fs, filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (!record || record.type !== 'user' || !record.message) continue;
      const text = contentText(record.message.content);
      if (text) return text.slice(0, 80);
    }
  } catch (_error) {}
  return '未命名会话';
}

function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text')
    .map((part) => String(part.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

function geminiTitle(data) {
  const summary = String(data && data.summary || '').trim();
  if (summary) return summary;
  const messages = Array.isArray(data && data.messages) ? data.messages : [];
  const firstUser = messages.find((message) => message && message.type === 'user');
  const text = contentText(firstUser && firstUser.content);
  return text ? text.slice(0, 80) : '未命名会话';
}

function safeDirectoryNames(fs, root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && safeName(entry.name))
      .map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
}

function safeFileNames(fs, root, suffix) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && safeName(entry.name) && entry.name.endsWith(suffix))
      .map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
}

function safeName(value) {
  const text = String(value || '');
  return Boolean(text && text !== '.' && text !== '..' && !text.includes('/') && !text.includes('\\'));
}

function safeChild(path, root, name) {
  if (!safeName(name)) throw codedError('legacy_archive_path_invalid', 400, '归档路径无效');
  const child = path.join(root, name);
  if (!isSafeDescendant(path, root, child)) throw codedError('legacy_archive_path_invalid', 400, '归档路径无效');
  return child;
}

function isSafeDescendant(path, root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readJson(fs, filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function safeStat(fs, filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_error) {
    return null;
  }
}

function safeExists(fs, filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_error) {
    return false;
  }
}

function moveWithoutOverwrite(fs, source, destination) {
  if (safeExists(fs, destination)) {
    throw codedError('legacy_archive_restore_conflict', 409, '目标会话文件已存在');
  }
  fs.renameSync(source, destination);
}

function codedError(code, statusCode, message) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  createLegacyArchiveRecovery
};
