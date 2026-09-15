'use strict';

/**
 * CodeBuddy 家族会话读取适配器。
 *
 * 覆盖四个 Provider：codebuddy / codebuddycn / workbuddy / workbuddycn。
 *
 * 原生事实（2026-09-14/15 实机核对）：
 *   - 会话根由 `CODEBUDDY_CONFIG_DIR`（其次各产品自己的 *_CONFIG_DIR）决定，
 *     默认 `~/.codebuddy`；WorkBuddy 两个站点分别用 `~/.workbuddy-ai` / `~/.workbuddy`。
 *   - 落盘形态与 Claude Code 同构：`<configDir>/projects/<sanitized-cwd>/<sessionId>.jsonl`。
 *   - 记录形态是 **ACP/CodeBuddy 私有格式**，与 Claude 的 `{type:'user'|'assistant', message}`
 *     不同：`{id, timestamp(ms), type, ...}`，其中
 *       type=message        role=user|assistant，content=[{type:'input_text'|'output_text', text}]
 *       type=ai-title       aiTitle（标题真值）、sessionId、cwd
 *       type=reasoning      rawContent=[{type:'reasoning_text', text}]，providerData.model
 *       type=function_call  name / arguments / callId，providerData.model
 *       type=function_call_result name / callId / status / output={type:'text', text}
 *       type=file-history-snapshot  cwd（项目路径兜底）
 *     `.meta.json` / `.file-rollback.ndjson` 是旁挂元数据，不是会话消息。
 *
 * 站点合并口径（用户口径："按地区共享一份历史"）：
 *   同一站点的 WorkBuddy 与 CodeBuddy 跑的是**同一套 CodeBuddy Code runtime**，
 *   账号与用量在地区内通用，因此 aih 把同地区的两个数据根合并成一份历史：
 *     国内站（cn）    = ~/.workbuddy      + ~/.codebuddy-cn
 *     国际站（global）= ~/.workbuddy-ai   + ~/.codebuddy
 *   于是无论从哪个 Provider 进入，看到的都是同一份地区历史；这也是"切换账号
 *   会话不受影响"的前提——读的是地区级宿主目录，而不是某个账号的沙箱。
 *
 * 边界：账号沙箱（auth-projections/<provider>/<accountRef>）**不**在这里读取。
 * `projects` 已由 provider-storage-policy 声明为共享条目，沙箱里的 `projects`
 * 与宿主是同一份目录，走宿主路径即可（与 codex 的 `sessions` 同口径）。
 */

const path = require('node:path');
const fs = require('fs-extra');
const {
  getRealHome,
  safeParseJsonLine,
  forEachJsonlLineSync
} = require('./session-reader-utils');

// 读取标题/项目路径只需要头部若干条记录（实测最长首行 41KB），这里给足余量，
// 并用 shouldStop 在信息齐备时提前结束，避免整文件扫描。
const CODEBUDDY_SESSION_META_MAX_BYTES = 512 * 1024;

// 工具结果可能极大（整文件读、长命令输出）。截断到与 opencode 同量级，避免
// 单条消息把会话缓存撑爆。
const CODEBUDDY_TOOL_OUTPUT_MAX_CHARS = 32000;

const CODEBUDDY_FAMILY_PROVIDERS = Object.freeze([
  'codebuddy',
  'codebuddycn',
  'workbuddy',
  'workbuddycn'
]);

// 每个 Provider 各自的配置根（= CLIConfig.globalDir / 存储策略 nativeRoot），
// 用于需要"只读自己那一支"的场景（如会话文件路径归属判定）。
const CODEBUDDY_CONFIG_DIR_BY_PROVIDER = Object.freeze({
  codebuddy: '.codebuddy',
  codebuddycn: '.codebuddy-cn',
  workbuddy: '.workbuddy-ai',
  workbuddycn: '.workbuddy'
});

// 地区 = 共享同一份会话历史的原生数据根集合（顺序只影响读取优先级）。
const CODEBUDDY_SESSION_ROOTS_BY_PROVIDER = Object.freeze({
  // 国际站：CodeBuddy CLI 国际根 + WorkBuddy AI.app 数据根
  codebuddy: Object.freeze(['.codebuddy', '.workbuddy-ai']),
  workbuddy: Object.freeze(['.workbuddy-ai', '.codebuddy']),
  // 国内站：CodeBuddy CN 根 + WorkBuddy.app 数据根
  codebuddycn: Object.freeze(['.codebuddy-cn', '.workbuddy']),
  workbuddycn: Object.freeze(['.workbuddy', '.codebuddy-cn'])
});

function normalizeCodebuddyProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function isCodebuddyFamilyProvider(provider) {
  return Object.prototype.hasOwnProperty.call(
    CODEBUDDY_SESSION_ROOTS_BY_PROVIDER,
    normalizeCodebuddyProvider(provider)
  );
}

function resolveCodebuddyConfigDirNames(provider) {
  const dirName = CODEBUDDY_CONFIG_DIR_BY_PROVIDER[normalizeCodebuddyProvider(provider)];
  return dirName ? [dirName] : [];
}

/**
 * 该 Provider 所属地区的全部会话根（宿主 HOME 下的 `<configDir>/projects`）。
 *
 * @param {string} provider
 * @param {{hostHomeDir?: string}} [options]
 * @returns {string[]} 绝对路径；hostHomeDir 不可用时返回 []
 */
function resolveCodebuddyProjectsRoots(provider, options = {}) {
  const hostHomeDir = String(options.hostHomeDir || getRealHome() || '').trim();
  if (!hostHomeDir) return [];
  const roots = [];
  const seen = new Set();
  for (const dirName of CODEBUDDY_SESSION_ROOTS_BY_PROVIDER[normalizeCodebuddyProvider(provider)] || []) {
    const root = path.join(hostHomeDir, dirName, 'projects');
    if (seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}

function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  return String(value || '').trim();
}

function readCodebuddyRecordModel(record) {
  const providerData = record && record.providerData;
  return providerData && typeof providerData.model === 'string'
    ? providerData.model.trim()
    : '';
}

function collectCodebuddyBlockText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && (block.type === 'input_text'
      || block.type === 'output_text'
      || block.type === 'text'))
    .map((block) => String(block.text || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * 剥掉 WorkBuddy/CodeBuddy 每轮注入的 `<system-reminder data-role="user-context">`
 * 前导块（含 identity 文件、env 说明）。这不是用户输入，留在气泡里会淹没问题。
 */
function stripCodebuddySystemReminder(text) {
  return String(text || '')
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
    .trim();
}

function collectCodebuddyReasoningText(record) {
  const parts = [];
  const rawContent = Array.isArray(record && record.rawContent) ? record.rawContent : [];
  for (const block of rawContent) {
    if (block && block.type === 'reasoning_text' && block.text) parts.push(String(block.text));
  }
  if (parts.length === 0) {
    const inline = record && record.providerData && record.providerData.reasoning;
    if (typeof inline === 'string' && inline.trim()) parts.push(inline);
  }
  return parts.join('\n').trim();
}

function renderCodebuddyToolArguments(args) {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return args.trim();
  try {
    return JSON.stringify(args, null, 2);
  } catch (_error) {
    return '';
  }
}

function collectCodebuddyToolResultText(output) {
  if (!output) return '';
  if (typeof output === 'string') return output;
  if (typeof output.text === 'string') return output.text;
  if (Array.isArray(output.content)) return collectCodebuddyBlockText(output.content);
  try {
    return JSON.stringify(output);
  } catch (_error) {
    return '';
  }
}

function capCodebuddyToolOutput(text) {
  const normalized = String(text || '').trim();
  if (normalized.length <= CODEBUDDY_TOOL_OUTPUT_MAX_CHARS) return normalized;
  return `${normalized.slice(0, CODEBUDDY_TOOL_OUTPUT_MAX_CHARS)}...`;
}

/**
 * 读取一个会话文件的标题与项目路径（只扫头部）。
 *
 * 标题优先级：ai-title 记录（原生真值） → 首条用户消息（已剥离 system-reminder）→
 * 项目目录名。刻意**不**丢弃无标题会话：会话 id 才是主键，隐藏数据比显示一个
 * 兜底标题更糟。
 */
function readCodebuddySessionHead(sessionPath) {
  let title = '';
  let projectPath = '';
  let firstUserText = '';
  try {
    forEachJsonlLineSync(sessionPath, (line) => {
      const record = safeParseJsonLine(line);
      if (!record) return;
      if (!projectPath) projectPath = String(record.cwd || '').trim();
      if (record.type === 'ai-title') {
        const aiTitle = String(record.aiTitle || '').trim();
        if (aiTitle && !title) title = aiTitle;
        if (!projectPath) projectPath = String(record.cwd || '').trim();
      }
      if (!firstUserText && record.type === 'message' && record.role === 'user') {
        firstUserText = stripCodebuddySystemReminder(collectCodebuddyBlockText(record.content));
      }
    }, {
      maxBytes: CODEBUDDY_SESSION_META_MAX_BYTES,
      shouldStop: () => Boolean(title && projectPath && firstUserText)
    });
  } catch (_error) {
    /* 头部读不到就退化成"无标题/无路径"，由调用方兜底 */
  }
  return { title, projectPath, firstUserText };
}

/**
 * 读取该 Provider 所属地区的全部项目与会话。
 *
 * 同一 `projectDirName` 出现在多个数据根时按 sessionId 合并（取 mtime 更新的那条），
 * 这正是"国内 work+code 共用一份历史"的落地方式。
 *
 * @param {string} provider
 * @param {{hostHomeDir?: string}} [options]
 */
function readCodebuddyProjects(provider, options = {}) {
  const normalized = normalizeCodebuddyProvider(provider);
  const projectsById = new Map();

  for (const projectsRoot of resolveCodebuddyProjectsRoots(normalized, options)) {
    if (!fs.existsSync(projectsRoot)) continue;
    let projectDirNames;
    try {
      projectDirNames = fs.readdirSync(projectsRoot);
    } catch (_error) {
      continue;
    }

    for (const projectDirName of projectDirNames) {
      const projectDir = path.join(projectsRoot, projectDirName);
      let projectStat;
      try {
        projectStat = fs.statSync(projectDir);
      } catch (_error) {
        continue;
      }
      if (!projectStat.isDirectory()) continue;

      let fileNames;
      try {
        fileNames = fs.readdirSync(projectDir);
      } catch (_error) {
        continue;
      }

      const sessions = [];
      let projectPath = '';
      for (const fileName of fileNames) {
        if (!fileName.endsWith('.jsonl')) continue;
        const sessionId = fileName.slice(0, -'.jsonl'.length);
        if (!sessionId) continue;
        const sessionPath = path.join(projectDir, fileName);

        const head = readCodebuddySessionHead(sessionPath);
        if (!projectPath && head.projectPath) projectPath = head.projectPath;

        let updatedAt = 0;
        try {
          updatedAt = Number(fs.statSync(sessionPath).mtimeMs) || 0;
        } catch (_error) {
          continue;
        }

        sessions.push({
          id: sessionId,
          title: head.title || head.firstUserText || path.basename(head.projectPath || projectDirName),
          updatedAt,
          provider: normalized,
          projectDirName
        });
      }

      if (sessions.length === 0) continue;

      const existing = projectsById.get(projectDirName);
      const mergedSessions = new Map(
        ((existing && existing.sessions) || []).map((session) => [session.id, session])
      );
      for (const session of sessions) {
        const previous = mergedSessions.get(session.id);
        if (!previous || session.updatedAt > previous.updatedAt) mergedSessions.set(session.id, session);
      }
      projectsById.set(projectDirName, {
        id: projectDirName,
        name: path.basename(projectPath || projectDirName),
        path: projectPath || projectDirName,
        sessions: Array.from(mergedSessions.values())
          .sort((left, right) => right.updatedAt - left.updatedAt),
        provider: normalized
      });
    }
  }

  return Array.from(projectsById.values());
}

/**
 * 定位会话文件。
 *
 * 地区内的任一数据根都可能持有该会话（例如会话由 workbuddy 产生、但从 codebuddy
 * 进入），所以按地区根逐个探测——这正是"可续聊"能跨 work/code 生效的原因。
 *
 * @param {string} provider
 * @param {string} sessionId
 * @param {string} [projectDirName]
 * @param {{hostHomeDir?: string}} [options]
 * @returns {string} 绝对路径；找不到返回 ''
 */
function resolveCodebuddySessionPath(provider, sessionId, projectDirName, options = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const wantedProjectDir = String(projectDirName || '').trim();

  for (const projectsRoot of resolveCodebuddyProjectsRoots(provider, options)) {
    if (wantedProjectDir) {
      const candidate = path.join(projectsRoot, wantedProjectDir, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
      continue;
    }
    let dirNames;
    try {
      dirNames = fs.readdirSync(projectsRoot);
    } catch (_error) {
      continue;
    }
    for (const dirName of dirNames) {
      const candidate = path.join(projectsRoot, dirName, `${id}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return '';
}

/**
 * 读取会话消息，输出与 claude/codex 同构的 `{role, content, timestamp, model?}`。
 *
 * 思考与工具调用内联成 `:::thinking` / `:::tool{name="…"}` / `:::tool-result`
 * 标记（WebUI 的 chat parser 直接消费这套标记）。一个用户轮次内的所有 assistant
 * 记录（reasoning + 文本 + 工具）合并成同一个 assistant 气泡。
 */
function readCodebuddySessionMessages(provider, sessionId, projectDirName, options = {}) {
  const filePath = resolveCodebuddySessionPath(provider, sessionId, projectDirName, options);
  if (!filePath || !fs.existsSync(filePath)) return [];

  const messages = [];
  const callIdToMessageIndex = new Map();
  let assistantIndex = -1;

  const ensureAssistant = (record) => {
    if (assistantIndex >= 0 && messages[assistantIndex]) {
      const existing = messages[assistantIndex];
      if (!existing.model) {
        const model = readCodebuddyRecordModel(record);
        if (model) existing.model = model;
      }
      return existing;
    }
    const model = readCodebuddyRecordModel(record);
    messages.push({
      role: 'assistant',
      content: '',
      timestamp: toIsoTimestamp(record && record.timestamp),
      ...(model ? { model } : {})
    });
    assistantIndex = messages.length - 1;
    return messages[assistantIndex];
  };

  const appendAssistantChunk = (record, chunk) => {
    const text = String(chunk || '').trim();
    if (!text) return;
    const message = ensureAssistant(record);
    message.content = message.content ? `${message.content}\n${text}` : text;
  };

  const appendToMessage = (index, chunk) => {
    const text = String(chunk || '').trim();
    const message = Number.isInteger(index) ? messages[index] : null;
    if (!text || !message) return;
    message.content = message.content ? `${message.content}\n${text}` : text;
  };

  forEachJsonlLineSync(filePath, (line) => {
    const record = safeParseJsonLine(line);
    if (!record) return;
    const type = String(record.type || '');

    if (type === 'message') {
      const role = String(record.role || '').trim();
      if (role === 'user') {
        assistantIndex = -1;
        const text = stripCodebuddySystemReminder(collectCodebuddyBlockText(record.content));
        if (text) {
          messages.push({
            role: 'user',
            content: text,
            timestamp: toIsoTimestamp(record.timestamp)
          });
        }
        return;
      }
      if (role === 'assistant') {
        appendAssistantChunk(record, collectCodebuddyBlockText(record.content));
      }
      return;
    }

    if (type === 'reasoning') {
      const thinking = collectCodebuddyReasoningText(record);
      if (thinking) appendAssistantChunk(record, `:::thinking\n${thinking}\n:::`);
      return;
    }

    if (type === 'function_call') {
      const toolName = String(record.name || 'tool').trim() || 'tool';
      const body = renderCodebuddyToolArguments(record.arguments);
      appendAssistantChunk(record, `:::tool{name="${toolName}"}\n${body}\n:::`);
      const callId = String(record.callId || '').trim();
      if (callId && assistantIndex >= 0) callIdToMessageIndex.set(callId, assistantIndex);
      return;
    }

    if (type === 'function_call_result') {
      const resultText = capCodebuddyToolOutput(collectCodebuddyToolResultText(record.output));
      if (!resultText) return;
      const callId = String(record.callId || '').trim();
      const knownIndex = callId ? callIdToMessageIndex.get(callId) : undefined;
      const targetIndex = Number.isInteger(knownIndex)
        ? knownIndex
        : assistantIndex;
      appendToMessage(targetIndex, `:::tool-result\n${resultText}\n:::`);
    }
  });

  return messages.filter((message) => String(message.content || '').trim());
}

module.exports = {
  CODEBUDDY_CONFIG_DIR_BY_PROVIDER,
  CODEBUDDY_FAMILY_PROVIDERS,
  CODEBUDDY_SESSION_META_MAX_BYTES,
  CODEBUDDY_SESSION_ROOTS_BY_PROVIDER,
  CODEBUDDY_TOOL_OUTPUT_MAX_CHARS,
  isCodebuddyFamilyProvider,
  readCodebuddyProjects,
  readCodebuddySessionMessages,
  resolveCodebuddyConfigDirNames,
  resolveCodebuddyProjectsRoots,
  resolveCodebuddySessionPath,
  stripCodebuddySystemReminder
};
