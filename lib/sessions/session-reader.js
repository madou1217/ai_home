'use strict';
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');

/**
 * 获取真实的宿主 HOME (非沙盒)
 */
function getRealHome() {
  if (process.env.REAL_HOME) return process.env.REAL_HOME;
  const homeDir = os.homedir();
  if (homeDir.includes('/.ai_home/profiles/')) {
    const parts = homeDir.split('/.ai_home/');
    if (parts.length > 0) return parts[0];
  }
  const testPaths = [
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.gemini')
  ];
  for (const testPath of testPaths) {
    if (fs.existsSync(testPath)) return homeDir;
  }
  if (process.env.HOME && !process.env.HOME.includes('/.ai_home/')) {
    return process.env.HOME;
  }
  return homeDir;
}

function safeParseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch (_error) {
    return null;
  }
}

function forEachJsonlLineSync(filePath, onLine, options = {}) {
  const chunkSize = Math.max(4096, Number(options.chunkSize) || 256 * 1024);
  const maxCarryChars = Math.max(1024, Number(options.maxCarryChars) || 8 * 1024 * 1024);
  let fd;

  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(chunkSize);
    let bytesRead = 0;
    let carry = '';

    do {
      bytesRead = fs.readSync(fd, buffer, 0, chunkSize, null);
      if (bytesRead <= 0) break;

      carry += buffer.toString('utf8', 0, bytesRead);
      let newlineIndex = carry.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = carry.slice(0, newlineIndex).replace(/\r$/, '');
        carry = carry.slice(newlineIndex + 1);
        if (line.trim()) onLine(line);
        newlineIndex = carry.indexOf('\n');
      }

      if (carry.length > maxCarryChars) {
        carry = '';
      }
    } while (bytesRead > 0);

    if (carry.trim()) onLine(carry.replace(/\r$/, ''));
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_error) {}
    }
  }
}

/**
 * Claude CLI 的 sanitizePath: 所有非字母数字字符替换为 -
 * 来源: claude-code cli/src/utils/sessionStoragePortable.ts
 */
function sanitizePath(name) {
  return name.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * 收集所有已知项目路径（从 Codex config.toml、Gemini 等）
 * 用于与 Claude 的 sanitized 目录名做正向匹配
 */
function collectKnownProjectPaths() {
  const hostHome = getRealHome();
  const paths = new Set();

  // 从 Codex config.toml
  try {
    const configPath = path.join(hostHome, '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const regex = /\[projects\."([^"]+)"\]/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        paths.add(match[1]);
      }
    }
  } catch (e) { /* ignore */ }

  // 从 Gemini trustedFolders.json
  try {
    const trustedPath = path.join(hostHome, '.gemini', 'trustedFolders.json');
    if (fs.existsSync(trustedPath)) {
      const data = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
      for (const p of Object.keys(data)) {
        paths.add(p);
      }
    }
  } catch (e) { /* ignore */ }

  // 从 Gemini history 目录的 .project_root
  try {
    const historyDir = path.join(hostHome, '.gemini', 'history');
    if (fs.existsSync(historyDir)) {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          const p = fs.readFileSync(rootFile, 'utf8').trim();
          if (p) paths.add(p);
        }
      }
    }
  } catch (e) { /* ignore */ }

  return paths;
}

/**
 * ��� Claude 的 sanitized 目录名反向推断真实路径
 * sanitizePath: 所有非 [a-zA-Z0-9] 替换为 -，不可逆
 * 策略：
 *   1. 用已知路径正向编码匹配
 *   2. 贪心法逐段拼接，验证目录存在性
 */
function resolveClaudeProjectPath(sanitizedDirName, knownPaths) {
  // 1. 用已知路径正向编码匹配
  for (const realPath of knownPaths) {
    if (sanitizePath(realPath) === sanitizedDirName) {
      return realPath;
    }
  }

  // 2. 贪心法逐段拼接：每遇到 - 先尝试当作 / 分隔，不存在则保留为 -
  const parts = sanitizedDirName.split('-').filter(Boolean);
  let current = '';
  for (let i = 0; i < parts.length; i++) {
    // 先尝试用 / 连接（正常路径分隔）
    const withSlash = current ? current + '/' + parts[i] : '/' + parts[i];
    // 再尝试用 - 连接（原始字符含 -）
    const withDash = current ? current + '-' + parts[i] : '/' + parts[i];
    // 再尝试用 . 连接（原始字符含 .，如 .claude）
    const withDot = current ? current + '.' + parts[i] : '/.' + parts[i];
    // 再尝试用 _ 连接
    const withUnderscore = current ? current + '_' + parts[i] : '/' + parts[i];

    if (fs.existsSync(withSlash)) {
      current = withSlash;
    } else if (fs.existsSync(withDash)) {
      current = withDash;
    } else if (fs.existsSync(withDot)) {
      current = withDot;
    } else if (fs.existsSync(withUnderscore)) {
      current = withUnderscore;
    } else {
      // 都不存在，默认用 /
      current = withSlash;
    }
  }

  if (current && fs.existsSync(current)) {
    return current;
  }

  // 3. 最终 fallback
  return sanitizedDirName.replace(/-/g, '/');
}

// ============================================================
// Claude 项目读取
// ============================================================
function readClaudeProjectsFromHost(knownPaths) {
  const projects = [];
  const hostHome = getRealHome();
  const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');

  try {
    if (!fs.existsSync(claudeProjectsDir)) return [];

    const projectDirs = fs.readdirSync(claudeProjectsDir);

    for (const projectDirName of projectDirs) {
      const projectPath = path.join(claudeProjectsDir, projectDirName);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;

      // 用正向编码匹配还原真实路径
      const realPath = resolveClaudeProjectPath(projectDirName, knownPaths);

      // 读取会话文件
      const sessionFiles = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
      const sessions = [];

      for (const sessionFile of sessionFiles) {
        const sessionId = sessionFile.replace('.jsonl', '');
        const sessionFilePath = path.join(projectPath, sessionFile);
        const stats = fs.statSync(sessionFilePath);

        let title = '未命名会话';
        try {
          // 只读前 16KB 提取标题（不需要读整个文件）
          const fd = fs.openSync(sessionFilePath, 'r');
          try {
            const buf = Buffer.alloc(16384);
            const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
            const chunk = buf.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n').filter(l => l.trim());

            for (const line of lines) {
              try {
                const record = JSON.parse(line);
                if (record.type === 'user' && record.message && record.message.content) {
                  const msg = record.message;
                  let text = '';
                  if (typeof msg.content === 'string') {
                    text = msg.content;
                  } else if (Array.isArray(msg.content)) {
                    text = msg.content
                      .map(block => block.type === 'text' ? block.text : '')
                      .filter(Boolean)
                      .join(' ');
                  }
                  if (text &&
                      !text.startsWith('Caveat:') &&
                      !text.startsWith('<command-name>') &&
                      !text.startsWith('<local-command') &&
                      !text.startsWith('<ide_opened_file>')) {
                    title = text.slice(0, 50);
                    break;
                  }
                }
              } catch (e) { /* skip malformed line */ }
            }
          } finally { fs.closeSync(fd); }
        } catch (e) { /* ignore */ }

        if (title === 'Warmup' || title === '未命名会话') continue;

        sessions.push({
          id: sessionId,
          title,
          updatedAt: stats.mtimeMs,
          provider: 'claude',
          projectDirName
        });
      }

      if (sessions.length === 0) continue;

      projects.push({
        id: projectDirName,
        name: path.basename(realPath),
        path: realPath,
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
        provider: 'claude'
      });
    }
  } catch (error) {
    console.error('Failed to read Claude projects:', error);
  }

  return projects;
}

// ============================================================
// Codex 项目读取
// ============================================================

/**
 * 从 Codex session 文件首行提取 cwd
 * 使用正则直接匹配 "cwd":"..." 字段，无需解析完整 JSON
 * 只读前 512 字节（cwd 字段在 session_meta 前部，远在 instructions 之前）
 */
function readCodexSessionCwd(sessionFilePath) {
  let fd;
  try {
    fd = fs.openSync(sessionFilePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    const chunk = buf.toString('utf8', 0, bytesRead);
    // session_meta 格式: {"timestamp":"...","type":"session_meta","payload":{"id":"...","timestamp":"...","cwd":"/path",...}}
    // cwd 字段在 payload 的前部，一定在前 512 字节内
    const match = chunk.match(/"cwd"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  } catch (e) { /* ignore */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch(e) {} }
  return null;
}

function readCodexProjectsFromHost() {
  const hostHome = getRealHome();
  const codexDir = path.join(hostHome, '.codex');

  try {
    // 1. 读取 session_index.jsonl 获取 thread_name 映射
    const sessionIndexPath = path.join(codexDir, 'session_index.jsonl');
    const nameMap = new Map(); // session id -> {thread_name, updated_at}
    if (fs.existsSync(sessionIndexPath)) {
      const lines = fs.readFileSync(sessionIndexPath, 'utf8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          // append-only, 后面的覆盖前面的
          nameMap.set(entry.id, {
            thread_name: entry.thread_name,
            updated_at: entry.updated_at
          });
        } catch (e) { /* ignore */ }
      }
    }

    // 2. 扫描 session 文件，从 metadata 提取 cwd，按 cwd 分组
    const projectSessionMap = new Map(); // cwd -> sessions[]
    const sessionsDir = path.join(codexDir, 'sessions');

    if (fs.existsSync(sessionsDir)) {
      const findSessionFiles = (dir) => {
        const results = [];
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              // 跳过 archived 目录（已归档的会话）
              if (entry.name === 'archived') continue;
              results.push(...findSessionFiles(fullPath));
            } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
              results.push(fullPath);
            }
          }
        } catch (e) { /* ignore */ }
        return results;
      };

      const sessionFiles = findSessionFiles(sessionsDir);

      for (const sessionFile of sessionFiles) {
        const cwd = readCodexSessionCwd(sessionFile);
        if (!cwd) continue;

        // 过滤 worktree 临时目录
        if (cwd.includes('/.codex/worktrees/')) continue;

        // 从文件名提取 session id (rollout-YYYY-MM-DDTHH-MM-SS-UUID.jsonl)
        const fileName = path.basename(sessionFile, '.jsonl');
        const uuidMatch = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        if (!uuidMatch) continue;

        const sessionId = uuidMatch[1];
        const nameEntry = nameMap.get(sessionId);
        const title = nameEntry?.thread_name || '未命名会话';

        if (title === 'Warmup' || title === '未命名会话') continue;

        const stats = fs.statSync(sessionFile);

        if (!projectSessionMap.has(cwd)) {
          projectSessionMap.set(cwd, []);
        }
        projectSessionMap.get(cwd).push({
          id: sessionId,
          title,
          updatedAt: nameEntry?.updated_at
            ? new Date(nameEntry.updated_at).getTime()
            : stats.mtimeMs,
          provider: 'codex'
        });
      }
    }

    // 3. 转换为项目列表
    const projects = [];
    for (const [cwd, sessions] of projectSessionMap) {
      if (sessions.length === 0) continue;
      projects.push({
        id: Buffer.from(cwd).toString('base64').replace(/[/+=]/g, '_'),
        name: path.basename(cwd),
        path: cwd,
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
        provider: 'codex'
      });
    }

    return projects;
  } catch (error) {
    console.error('Failed to read Codex projects:', error);
  }

  return [];
}

// ============================================================
// Gemini 项目读取
// ============================================================
function readGeminiProjectsFromHost() {
  const projects = [];
  const hostHome = getRealHome();
  const geminiDir = path.join(hostHome, '.gemini');

  try {
    // 从 history 目录获取项目路径映射
    const projectPathMap = new Map(); // projectName -> realPath
    const historyDir = path.join(geminiDir, 'history');
    if (fs.existsSync(historyDir)) {
      for (const name of fs.readdirSync(historyDir)) {
        const rootFile = path.join(historyDir, name, '.project_root');
        if (fs.existsSync(rootFile)) {
          projectPathMap.set(name, fs.readFileSync(rootFile, 'utf8').trim());
        }
      }
    }

    // 从 tmp 目录读取实际会话
    const tmpDir = path.join(geminiDir, 'tmp');
    if (!fs.existsSync(tmpDir)) return [];

    for (const projectName of fs.readdirSync(tmpDir)) {
      const chatsDir = path.join(tmpDir, projectName, 'chats');
      if (!fs.existsSync(chatsDir)) continue;

      const sessions = [];
      const chatFiles = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));

      for (const chatFile of chatFiles) {
        try {
          const chatPath = path.join(chatsDir, chatFile);
          // 只读前 1KB 提取标题
          const fd = fs.openSync(chatPath, 'r');
          try {
            const buf = Buffer.alloc(2048);
            const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
            const chunk = buf.toString('utf8', 0, bytesRead);

            const sessionIdMatch = chunk.match(/"sessionId"\s*:\s*"([^"]+)"/);
            const summaryMatch = chunk.match(/"summary"\s*:\s*"([^"]+)"/);
            const lastUpdatedMatch = chunk.match(/"lastUpdated"\s*:\s*"([^"]+)"/);

            // 也尝试获取首条用户消息作为标题
            let title = summaryMatch ? summaryMatch[1] : '';
            if (!title) {
              // 读取完整文件获取首条消息
              const fullData = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
              if (fullData.messages && fullData.messages.length > 0) {
                const firstUser = fullData.messages.find(m => m.type === 'user');
                if (firstUser && firstUser.content) {
                  const textBlock = Array.isArray(firstUser.content)
                    ? firstUser.content.find(c => c.text)
                    : firstUser.content;
                  title = (typeof textBlock === 'string' ? textBlock : textBlock?.text || '').slice(0, 50);
                }
              }
            }

            if (!title || title === 'Warmup') continue;

            const sessionId = sessionIdMatch ? sessionIdMatch[1] : chatFile.replace('.json', '');
            const updatedAt = lastUpdatedMatch ? new Date(lastUpdatedMatch[1]).getTime() : fs.statSync(chatPath).mtimeMs;

            sessions.push({
              id: sessionId,
              title,
              updatedAt,
              provider: 'gemini',
              projectDirName: projectName // Gemini 用项目名作为目录标识
            });
          } finally { fs.closeSync(fd); }
        } catch (e) { /* ignore */ }
      }

      const projectPath = projectPathMap.get(projectName) || '';

      projects.push({
        id: 'gemini-' + projectName,
        name: projectName,
        path: projectPath,
        sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
        provider: 'gemini'
      });
    }
  } catch (error) {
    console.error('Failed to read Gemini projects:', error);
  }

  return projects;
}

// ============================================================
// 项目名称映射
// ============================================================
function readProjectNameMappings() {
  const hostHome = getRealHome();
  const mappings = {};

  try {
    const geminiProjectsPath = path.join(hostHome, '.gemini', 'projects.json');
    if (fs.existsSync(geminiProjectsPath)) {
      const data = JSON.parse(fs.readFileSync(geminiProjectsPath, 'utf8'));
      if (data.projects) Object.assign(mappings, data.projects);
    }
  } catch (e) { /* ignore */ }

  return mappings;
}

// ============================================================
// 读取所有项目（主入口）
// ============================================================
function readAllProjectsFromHost() {
  // 先收集已知路径，用于 Claude 路径解码
  const knownPaths = collectKnownProjectPaths();

  const claudeProjects = readClaudeProjectsFromHost(knownPaths);
  const codexProjects = readCodexProjectsFromHost();
  const geminiProjects = readGeminiProjectsFromHost();

  // 名称映射
  const nameMappings = readProjectNameMappings();

  const allProjects = [...claudeProjects, ...codexProjects, ...geminiProjects];
  for (const project of allProjects) {
    if (nameMappings[project.path]) {
      project.name = nameMappings[project.path];
      continue;
    }
    // 模糊匹配
    const normalizedPath = project.path.replace(/[/_]/g, '');
    for (const [mappingPath, mappingName] of Object.entries(nameMappings)) {
      const normalizedMappingPath = mappingPath.replace(/[/_]/g, '');
      if (normalizedPath === normalizedMappingPath) {
        project.name = mappingName;
        break;
      }
    }
  }

  return allProjects;
}

// ============================================================
// Session 消息读取
// ============================================================
function readClaudeSessionMessages(sessionId, projectDirName) {
  const messages = [];
  const hostHome = getRealHome();

  try {
    const sessionPath = resolveClaudeSessionPath(sessionId, projectDirName, hostHome);
    if (!fs.existsSync(sessionPath)) return messages;

    const content = fs.readFileSync(sessionPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    // 两遍处理：第一遍收集 tool_use 的 id，第二遍将 tool_result 合并回去
    const toolUseMap = new Map(); // tool_use id -> tool name
    const toolResultMap = new Map(); // tool_use_id -> result text

    // 第一遍：收集所有 tool_use id 和 tool_result
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (!record.message || !record.message.content) continue;
        const blocks = Array.isArray(record.message.content) ? record.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            toolUseMap.set(block.id, block.name);
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            let resultText = '';
            if (typeof block.content === 'string') {
              resultText = block.content.length > 300 ? block.content.slice(0, 300) + '...' : block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
              if (resultText.length > 300) resultText = resultText.slice(0, 300) + '...';
            }
            toolResultMap.set(block.tool_use_id, resultText);
          }
        }
      } catch (e) { /* ignore */ }
    }

    // 第二遍：构建消息，tool_use+tool_result 合并到 assistant 消息
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const msg = record.message || {};
        if (record.type !== 'user' && record.type !== 'assistant') continue;

        let text = '';
        if (msg.content) {
          if (typeof msg.content === 'string') {
            text = msg.content;
          } else if (Array.isArray(msg.content)) {
            const parts = [];
            let hasOnlyToolResult = true;

            for (const block of msg.content) {
              if (block.type === 'thinking' && block.thinking) {
                // thinking 块 - 用特殊标记包裹
                const thinkText = block.thinking.length > 500
                  ? block.thinking.slice(0, 500) + '...'
                  : block.thinking;
                parts.push('\n:::thinking\n' + thinkText + '\n:::\n');
                hasOnlyToolResult = false;
              } else if (block.type === 'text') {
                parts.push(block.text);
                hasOnlyToolResult = false;
              } else if (block.type === 'tool_use') {
                hasOnlyToolResult = false;
                const input = block.input || {};
                const name = block.name || 'Unknown';
                let body = '';

                if (name === 'Bash' && input.command) body = input.command;
                else if (name === 'TodoWrite' && input.todos) body = JSON.stringify(input.todos);
                else if ((name === 'Read' || name === 'Write' || name === 'Edit') && input.file_path) body = input.file_path;
                else if (name === 'Grep' && input.pattern) body = input.pattern + (input.path ? ' in ' + input.path : '');
                else if (name === 'Glob' && input.pattern) body = input.pattern;
                else if (name === 'WebFetch' && input.url) body = input.url;
                else {
                  body = Object.entries(input).map(([k, v]) => {
                    const val = typeof v === 'string' ? (v.length > 60 ? v.slice(0, 60) + '...' : v) : JSON.stringify(v).slice(0, 60);
                    return k + ': ' + val;
                  }).join('\n');
                }

                // 合并 tool_result 到 tool_use 下方
                const result = block.id ? toolResultMap.get(block.id) : '';
                let toolSection = '\n:::tool{name="' + name + '"}\n' + body + '\n:::\n';
                if (result) {
                  toolSection += '\n:::tool-result\n' + result + '\n:::\n';
                }
                parts.push(toolSection);
              } else if (block.type === 'tool_result') {
                // tool_result 在 user turn 里，跳过（已合并到 assistant 的 tool_use）
                continue;
              }
            }

            // 如果这个 user 消息只有 tool_result，完全跳过
            if (record.type === 'user' && hasOnlyToolResult) continue;

            text = parts.filter(Boolean).join('\n');
          }
        }

        // 过滤系统消息和 IDE 标签
        if (!text) continue;
        if (text.startsWith('Caveat:') || text.startsWith('<command-name>') ||
            text.startsWith('<local-command') || text.startsWith('<system-reminder>') ||
            text.startsWith('<ide_opened_file>') || text.startsWith('<ide_')) continue;

        let cleanText = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
          .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
          .trim();
        if (!cleanText) continue;

        messages.push({
          role: record.type === 'user' ? 'user' : 'assistant',
          content: cleanText,
          timestamp: record.timestamp || msg.timestamp
        });
      } catch (e) { /* ignore */ }
    }
  } catch (error) {
    console.error('Failed to read Claude session messages:', error);
  }

  return messages;
}

function readCodexSessionMessages(sessionId) {
  const messages = [];
  const hostHome = getRealHome();

  try {
    // Codex 使用 rollout 格式：sessions/YYYY/MM/DD/rollout-*-UUID.jsonl
    // 需要递归查找包含该 UUID 的文件
    const sessionsDir = path.join(hostHome, '.codex', 'sessions');
    if (!fs.existsSync(sessionsDir)) return messages;

    const sessionPath = resolveCodexSessionPath(sessionId, hostHome);
    if (!sessionPath) return messages;

    // 第一遍：收集 function_call 结果
    const callResultMap = new Map(); // call_id -> output text
    forEachJsonlLineSync(sessionPath, (line) => {
      const record = safeParseJsonLine(line);
      if (!record) return;
      const payload = record.payload || {};
      if (record.type !== 'response_item' || payload.type !== 'function_call_output') return;
      const output = String(payload.output || '');
      if (payload.call_id) {
        callResultMap.set(payload.call_id, output.length > 300 ? output.slice(0, 300) + '...' : output);
      }
    });

    // 第二遍：构建消息
    forEachJsonlLineSync(sessionPath, (line) => {
      const record = safeParseJsonLine(line);
      if (!record) return;
      const payload = record.payload || {};

      // 用户消息: event_msg + type=user_message
      if (record.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
        messages.push({
          role: 'user',
          content: payload.message,
          timestamp: record.timestamp
        });
      }

      // 助手消息: response_item + role=assistant (含 output_text)
      if (record.type === 'response_item' && payload.role === 'assistant') {
        const contentBlocks = payload.content || [];
        if (Array.isArray(contentBlocks)) {
          const text = contentBlocks
            .filter(b => b.type === 'output_text' && b.text)
            .map(b => b.text)
            .join('\n');
          if (text.trim()) {
            messages.push({
              role: 'assistant',
              content: text,
              timestamp: record.timestamp
            });
          }
        }
      }

      // function_call (exec_command 等) -> 渲染为 tool 块
      if (record.type === 'response_item' && payload.type === 'function_call') {
        const name = payload.name || 'Unknown';
        let args = {};
        try { args = JSON.parse(payload.arguments || '{}'); } catch (e) { /* ignore */ }

        let toolName = name;
        let body = '';

        if (name === 'exec_command' || name === 'shell') {
          toolName = 'Terminal';
          body = args.cmd || args.command || '';
          if (args.workdir) body += '\n# cwd: ' + args.workdir;
        } else if (name === 'create_file' || name === 'write_file') {
          toolName = 'Write';
          body = args.path || args.file_path || '';
        } else if (name === 'read_file') {
          toolName = 'Read';
          body = args.path || args.file_path || '';
        } else if (name === 'apply_diff' || name === 'edit_file') {
          toolName = 'Edit';
          body = args.path || args.file_path || '';
        } else {
          body = payload.arguments ? payload.arguments.slice(0, 200) : '';
        }

        // 合并 function_call_output
        const result = payload.call_id ? callResultMap.get(payload.call_id) : '';
        let content = '\n:::tool{name="' + toolName + '"}\n' + body + '\n:::\n';
        if (result) {
          content += '\n:::tool-result\n' + result + '\n:::\n';
        }

        messages.push({
          role: 'assistant',
          content: content,
          timestamp: record.timestamp
        });
      }
    });
  } catch (error) {
    console.error('Failed to read Codex session messages:', error);
  }

  return messages;
}

function readGeminiSessionMessages(sessionId, projectDirName) {
  const messages = [];
  const hostHome = getRealHome();

  try {
    const sessionPath = resolveGeminiSessionPath(sessionId, projectDirName, hostHome);
    if (!sessionPath) return messages;
    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    if (!sessionData || !sessionData.messages) return messages;

    for (const msg of sessionData.messages) {
      let text = '';
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(c => c.text)
          .map(c => c.text)
          .join('\n');
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }

      if (!text.trim()) continue;

      // Gemini 的 type: user/model
      const role = msg.type === 'user' ? 'user' : 'assistant';
      messages.push({ role, content: text, timestamp: msg.timestamp });
    }
  } catch (error) {
    console.error('Failed to read Gemini session messages:', error);
  }

  return messages;
}

function resolveClaudeSessionPath(sessionId, projectDirName, hostHome = getRealHome()) {
  const projectName = String(projectDirName || '').trim();
  const id = String(sessionId || '').trim();
  if (!projectName || !id) return '';
  return path.join(hostHome, '.claude', 'projects', projectName, `${id}.jsonl`);
}

function resolveCodexSessionPath(sessionId, hostHome = getRealHome()) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const sessionsDir = path.join(hostHome, '.codex', 'sessions');
  if (!fs.existsSync(sessionsDir)) return '';

  const findFile = (dir) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = findFile(fullPath);
          if (result) return result;
        } else if (entry.name.includes(id) && entry.name.endsWith('.jsonl')) {
          return fullPath;
        }
      }
    } catch (e) { /* ignore */ }
    return '';
  };

  return findFile(sessionsDir) || '';
}

function resolveGeminiSessionPath(sessionId, projectDirName, hostHome = getRealHome()) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const tmpDir = path.join(hostHome, '.gemini', 'tmp');
  if (!fs.existsSync(tmpDir)) return '';

  const findInChatsDir = (chatsDir) => {
    if (!fs.existsSync(chatsDir)) return '';
    for (const f of fs.readdirSync(chatsDir)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(chatsDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (data.sessionId === id) return fp;
      } catch (e) { /* ignore */ }
    }
    return '';
  };

  const projectName = String(projectDirName || '').trim();
  if (projectName) {
    const matched = findInChatsDir(path.join(tmpDir, projectName, 'chats'));
    if (matched) return matched;
  }

  for (const proj of fs.readdirSync(tmpDir)) {
    const matched = findInChatsDir(path.join(tmpDir, proj, 'chats'));
    if (matched) return matched;
  }

  return '';
}

function resolveSessionFilePath(provider, params = {}) {
  const { sessionId, projectDirName } = params;
  switch (provider) {
    case 'claude':
      return resolveClaudeSessionPath(sessionId, projectDirName);
    case 'codex':
      return resolveCodexSessionPath(sessionId);
    case 'gemini':
      return resolveGeminiSessionPath(sessionId, projectDirName);
    default:
      return '';
  }
}

function readSessionMessages(provider, params = {}) {
  const { sessionId, projectDirName } = params;
  switch (provider) {
    case 'claude':
      return readClaudeSessionMessages(sessionId, projectDirName);
    case 'codex':
      return readCodexSessionMessages(sessionId);
    case 'gemini':
      return readGeminiSessionMessages(sessionId, projectDirName);
    default:
      return [];
  }
}

module.exports = {
  readAllProjectsFromHost,
  readSessionMessages,
  resolveSessionFilePath,
  getRealHome
};
