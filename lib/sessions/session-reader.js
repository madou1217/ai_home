'use strict';
const path = require('node:path');
const fs = require('fs-extra');
const os = require('node:os');
const {
  readAgySessionMessagesFromFile,
  readGeminiSessionMessagesFromFile
} = require('./provider-session-adapters');
const {
  getOpenCodeDbPath,
  openOpenCodeDb
} = require('./opencode-session-store');

const codexSessionIndexCache = {
  sessionIndexPath: '',
  fileSize: 0,
  mtimeMs: 0,
  offset: 0,
  entries: new Map()
};

const codexSessionMetaCache = new Map();
const codexSessionPathCache = new Map();
let DatabaseSyncCtor = null;
let didResolveDatabaseSync = false;

function getDatabaseSyncCtor() {
  if (didResolveDatabaseSync) return DatabaseSyncCtor;
  didResolveDatabaseSync = true;
  try {
    ({ DatabaseSync: DatabaseSyncCtor } = require('node:sqlite'));
  } catch (_error) {
    DatabaseSyncCtor = null;
  }
  return DatabaseSyncCtor;
}

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

function trimToolResultOutput(text, maxLength = 300) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength) + '...';
}

function cleanCodexExecCommandOutput(output) {
  const text = String(output || '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';

  const lines = text.split('\n');
  const sections = [];
  let index = 0;

  while (index < lines.length) {
    if (!/^Chunk ID:\s*/.test(lines[index])) {
      index += 1;
      continue;
    }

    index += 1;
    while (index < lines.length && !/^Output:\s*(.*)$/.test(lines[index])) {
      if (/^Chunk ID:\s*/.test(lines[index])) break;
      index += 1;
    }

    if (index >= lines.length || /^Chunk ID:\s*/.test(lines[index])) {
      continue;
    }

    const outputMatch = lines[index].match(/^Output:\s*(.*)$/);
    const body = [];
    if (outputMatch && outputMatch[1]) {
      body.push(outputMatch[1]);
    }
    index += 1;

    while (index < lines.length && !/^Chunk ID:\s*/.test(lines[index])) {
      body.push(lines[index]);
      index += 1;
    }

    const sectionText = body.join('\n').trim();
    if (sectionText) sections.push(sectionText);
  }

  if (sections.length > 0) {
    return sections.join('\n\n');
  }

  const outputIndex = lines.findIndex((line) => /^Output:\s*(.*)$/.test(line));
  if (outputIndex >= 0) {
    const inlineMatch = lines[outputIndex].match(/^Output:\s*(.*)$/);
    const body = [];
    if (inlineMatch && inlineMatch[1]) {
      body.push(inlineMatch[1]);
    }
    body.push(...lines.slice(outputIndex + 1));
    return body.join('\n').trim();
  }

  return text.trim();
}

function basenameLike(filePath) {
  const text = String(filePath || '').trim();
  if (!text) return '';
  return path.basename(text.replace(/[?#].*$/, ''));
}

function summarizeCommandLabel(command, result) {
  const cmd = String(command || '').trim();
  const output = String(result || '').trim();
  if (!cmd) return 'Ran command';

  const quotedPathMatch = cmd.match(/["']([^"']+\.[a-zA-Z0-9_-]+)["']/);
  const pathMatch = quotedPathMatch && quotedPathMatch[1] ? quotedPathMatch[1] : '';
  const fileName = basenameLike(pathMatch);
  if (fileName && /(?:^|\s)(cat|sed|nl|head|tail|less|more|bat|rg)\b/.test(cmd)) {
    return `Read ${fileName}`;
  }
  if (/npm\s+run\s+([^\s]+)/.test(cmd)) {
    return `Ran npm run ${cmd.match(/npm\s+run\s+([^\s]+)/)[1]}`;
  }
  if (/node\s+--test\b/.test(cmd)) {
    return 'Ran tests';
  }
  if (/git\s+diff\b/.test(cmd)) {
    return 'Checked git diff';
  }
  if (output) {
    const firstLine = output.split('\n').map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine.length > 64 ? firstLine.slice(0, 64) + '...' : firstLine;
  }
  return cmd.length > 64 ? cmd.slice(0, 64) + '...' : cmd;
}

function shouldSkipCodexFunctionCall(name) {
  const toolName = String(name || '').trim();
  return toolName === 'write_stdin'
    || toolName === 'send_input'
    || toolName === 'resize_run_terminal'
    || toolName === 'read_thread_terminal';
}

function buildCodexExecCommandResult(payload = {}) {
  const aggregatedOutput = String(payload.aggregated_output || '').trim();
  const formattedOutput = String(payload.formatted_output || '').trim();
  const stdout = String(payload.stdout || '').trim();
  const stderr = String(payload.stderr || '').trim();
  const rawOutput = aggregatedOutput || formattedOutput || stdout || stderr;

  return {
    output: trimToolResultOutput(cleanCodexExecCommandOutput(rawOutput)),
    parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
    exitCode: Number.isInteger(payload.exit_code) ? payload.exit_code : null,
    cwd: String(payload.cwd || '').trim(),
    command: Array.isArray(payload.command) ? payload.command.map((item) => String(item || '')) : []
  };
}

function normalizeCodexFunctionCall(payload, callResultMap) {
  const name = payload && payload.name ? payload.name : 'Unknown';
  if (shouldSkipCodexFunctionCall(name)) return null;

  let args = {};
  try { args = JSON.parse(payload.arguments || '{}'); } catch (e) { /* ignore */ }

  let toolName = name;
  let body = '';
  const resultInfo = payload.call_id ? callResultMap.get(payload.call_id) : null;

  if (name === 'exec_command' || name === 'shell') {
    const parsedPrimary = resultInfo && Array.isArray(resultInfo.parsedCmd) ? resultInfo.parsedCmd[0] : null;
    const parsedType = String(parsedPrimary && parsedPrimary.type || '').trim();
    if (parsedType === 'read') {
      toolName = 'Read';
      body = parsedPrimary.path || parsedPrimary.name || args.cmd || args.command || '';
    } else if (parsedType === 'write') {
      toolName = 'Write';
      body = parsedPrimary.path || parsedPrimary.name || args.cmd || args.command || '';
    } else if (parsedType === 'edit') {
      toolName = 'Edit';
      body = parsedPrimary.path || parsedPrimary.name || args.cmd || args.command || '';
    } else {
      toolName = 'Terminal';
      body = args.cmd || args.command || '';
      const cwd = (resultInfo && resultInfo.cwd) || args.workdir;
      if (cwd) body += '\n# cwd: ' + cwd;
    }
  } else if (name === 'create_file' || name === 'write_file') {
    toolName = 'Write';
    body = args.path || args.file_path || '';
  } else if (name === 'read_file') {
    toolName = 'Read';
    body = args.path || args.file_path || '';
  } else if (name === 'apply_diff' || name === 'edit_file' || name === 'apply_patch') {
    toolName = 'Edit';
    body = args.path || args.file_path || '';
  } else if (name === 'TodoWrite' && Array.isArray(args.todos)) {
    toolName = 'TodoWrite';
    body = JSON.stringify(args.todos);
  } else if ((name === 'Task' || name === 'update_plan') && (Array.isArray(args.tasks) || Array.isArray(args.plan) || Array.isArray(args.items))) {
    toolName = name === 'update_plan' ? 'update_plan' : 'Task';
    body = JSON.stringify({
      explanation: args.explanation || '',
      [toolName === 'update_plan' ? 'plan' : 'tasks']: Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.plan) ? args.plan : args.items
    });
  } else if (name === 'request_user_input') {
    toolName = 'request_user_input';
    body = JSON.stringify({
      questions: Array.isArray(args.questions) ? args.questions : []
    });
  } else if (isCodexGoalToolName(name)) {
    toolName = name;
    // goal 工具的结果会异步补齐；body 保留请求参数，前端可先显示待创建/待更新状态。
    body = JSON.stringify(args || {});
  } else {
    body = payload.arguments ? payload.arguments.slice(0, 4000) : '';
  }

  const result = resultInfo && typeof resultInfo.output === 'string' ? resultInfo.output : '';
  let content = '\n:::tool{name="' + toolName + '"}\n' + body + '\n:::\n';
  if (result) {
    content += '\n:::tool-result\n' + result + '\n:::\n';
  }

  const summaryLabel = summarizeCodexToolCallLabel(toolName, args, body, result);

  return {
    content,
    summaryLabel
  };
}

function isCodexGoalToolName(name) {
  return name === 'create_goal' || name === 'update_goal' || name === 'get_goal';
}

function summarizeCodexToolCallLabel(toolName, args, body, result) {
  if (toolName === 'Terminal') return summarizeCommandLabel(args.cmd || args.command || '', result);
  if (toolName === 'Read') return `Read ${basenameLike(body)}`;
  if (toolName === 'Write') return `Wrote ${basenameLike(body)}`;
  if (toolName === 'Edit') return `Edited ${basenameLike(body)}`;
  if (toolName === 'Task') return 'Updated plan';
  if (toolName === 'request_user_input') return 'Waiting for user input';
  if (isCodexGoalToolName(toolName)) return 'Goal';
  return toolName;
}

function mergeUniqueStrings(existing, incoming) {
  const merged = [];
  const seen = new Set();
  const source = []
    .concat(Array.isArray(existing) ? existing : [])
    .concat(Array.isArray(incoming) ? incoming : []);
  source.forEach((item) => {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    merged.push(value);
  });
  return merged;
}

function toTimestampMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function areCloseTimestamps(left, right, toleranceMs = 1000) {
  const leftMs = toTimestampMs(left);
  const rightMs = toTimestampMs(right);
  if (!leftMs || !rightMs) return String(left || '') === String(right || '');
  return Math.abs(leftMs - rightMs) <= toleranceMs;
}

function isSyntheticCodexUserContent(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (isCodexGoalContextContent(content)) return false;
  return text.startsWith('# AGENTS.md instructions')
    || text.startsWith('<environment_context')
    || text.startsWith('<codex_internal_context')
    || text.startsWith('<goal_context')
    || text.startsWith('<turn_aborted')
    || text.startsWith('<user_instructions')
    || text.startsWith('<user_shell_command')
    || text.includes('<INSTRUCTIONS>');
}

function isCodexGoalContextContent(content) {
  const raw = String(content || '').trim();
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (!normalized.startsWith('<codex_internal_context') && !normalized.startsWith('<goal_context')) {
    return false;
  }
  return /<objective(?:\s+[^>]*)?>[\s\S]*?<\/objective>/i.test(raw);
}

function isCodexSessionTitleSyntheticContent(content) {
  return isSyntheticCodexUserContent(content) || isCodexGoalContextContent(content);
}

function compactCodexSessionTitle(content) {
  return String(content || '').replace(/\s+/g, ' ').trim();
}

function stripEmbeddedCodexSessionPickerTranscript(content) {
  const title = compactCodexSessionTitle(content);
  const markerIndex = title.indexOf('[aih] 选择要进入的持久会话');
  if (markerIndex < 0) return title;
  return title.slice(0, markerIndex).trim().replace(/[\s:：-]+$/, '').trim();
}

function normalizeCodexSessionTitle(content, maxLength = 0) {
  const title = stripEmbeddedCodexSessionPickerTranscript(content);
  if (!title || title === 'Warmup' || title === '未命名会话') return '';
  return maxLength > 0 ? title.slice(0, maxLength) : title;
}

function extractClaudeImageMarkerPaths(text) {
  const paths = [];
  const sourceText = String(text || '');
  const regex = /\[Image:\s*(?:source:\s*)?([^\]]+)\]/gi;
  let match;
  while ((match = regex.exec(sourceText)) !== null) {
    const imagePath = String(match[1] || '').trim();
    if (imagePath) paths.push(imagePath);
  }
  return paths;
}

function stripClaudeImageMarkers(text, options = {}) {
  let cleaned = String(text || '')
    .replace(/\[Image:\s*(?:source:\s*)?[^\]]+\]/gi, '')
    .replace(/<image\s+[^>]*>/gi, '');

  if (options.stripPlaceholders) {
    cleaned = cleaned.replace(/\s*\[Image\s*#[0-9]+\]\s*/gi, ' ');
  }

  return cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

function normalizeClaudeImageSource(block) {
  if (!block || typeof block !== 'object') return '';
  const blockType = String(block.type || '').trim().toLowerCase();
  if (blockType !== 'image' && !blockType.startsWith('image/')) return '';
  const source = block.source || block;
  const sourceType = String(source.type || '').trim().toLowerCase();

  if (sourceType === 'base64' || source.data || source.base64 || block.data || block.base64) {
    const data = String(source.data || source.base64 || block.data || block.base64 || '').trim();
    if (!data) return '';
    const mediaType = String(
      source.media_type
      || source.mediaType
      || block.media_type
      || block.mediaType
      || (blockType.startsWith('image/') ? block.type : '')
      || 'image/png'
    ).trim() || 'image/png';
    return `data:${mediaType};base64,${data}`;
  }

  if (sourceType === 'url') {
    return String(source.url || '').trim();
  }

  if (sourceType === 'file') {
    return String(source.path || source.file_path || '').trim();
  }

  return '';
}

function normalizeClaudeToolResultContent(content) {
  const textParts = [];
  let images = [];

  const visit = (item) => {
    if (item == null) return;
    if (typeof item === 'string') {
      textParts.push(item);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item !== 'object') {
      textParts.push(String(item));
      return;
    }

    const imageSource = normalizeClaudeImageSource(item);
    if (imageSource) {
      images = mergeUniqueStrings(images, [imageSource]);
      return;
    }

    if (item.type === 'text' && item.text) {
      textParts.push(item.text);
      return;
    }

    if (item.content) {
      visit(item.content);
    }
  };

  visit(content);

  return {
    text: trimToolResultOutput(textParts.join('\n')),
    images
  };
}

function isRenderableClaudeImageReference(imagePath) {
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(imagePath)) return true;
  return path.isAbsolute(imagePath) && fs.existsSync(imagePath);
}

function selectClaudeImages(markerPaths, inlineImages) {
  const markers = mergeUniqueStrings([], markerPaths);
  const inline = mergeUniqueStrings([], inlineImages);
  if (markers.length === 0) return inline;

  const selected = [];
  markers.forEach((marker, index) => {
    if (isRenderableClaudeImageReference(marker)) {
      selected.push(marker);
    } else if (inline[index]) {
      selected.push(inline[index]);
    }
  });
  if (inline.length > markers.length) {
    selected.push(...inline.slice(markers.length));
  }
  return mergeUniqueStrings([], selected);
}

function preferIncomingClaudeImages(existing, incoming) {
  const existingList = mergeUniqueStrings([], existing);
  const incomingList = mergeUniqueStrings([], incoming);
  if (incomingList.length === 0) return existingList;
  if (incomingList.some((item) => !/^data:image\//i.test(item))) {
    if (incomingList.length >= existingList.length) return incomingList;
    const selected = existingList.slice();
    incomingList.forEach((item, index) => {
      selected[index] = item;
    });
    return mergeUniqueStrings([], selected);
  }
  return mergeUniqueStrings(existingList, incomingList);
}

function tryMergeClaudeUserMessage(messages, nextMessage) {
  if (!nextMessage || nextMessage.role !== 'user') return false;
  const previous = messages[messages.length - 1];
  if (!previous || previous.role !== 'user') return false;
  if (!areCloseTimestamps(previous.timestamp, nextMessage.timestamp)) return false;

  const previousContent = String(previous.content || '').trim();
  const nextContent = String(nextMessage.content || '').trim();
  if (previousContent && nextContent && previousContent !== nextContent) return false;

  previous.content = previousContent || nextContent;
  previous.images = preferIncomingClaudeImages(previous.images, nextMessage.images);
  previous.timestamp = previous.timestamp || nextMessage.timestamp;
  return true;
}

function tryMergeClaudeAssistantMessage(messages, nextMessage) {
  if (!nextMessage || nextMessage.role !== 'assistant') return false;
  const previous = messages[messages.length - 1];
  if (!previous || previous.role !== 'assistant') return false;

  const previousContent = String(previous.content || '').trim();
  const nextContent = String(nextMessage.content || '').trim();
  const previousImages = mergeUniqueStrings([], previous.images || []);
  const nextImages = mergeUniqueStrings([], nextMessage.images || []);
  const normalizedNextContent = nextImages.length > 0
    ? shiftClaudeImageReferences(nextContent, previousImages.length)
    : nextContent;
  const mergedContent = [previousContent, normalizedNextContent].filter(Boolean).join('\n\n');

  previous.content = mergedContent;
  previous.images = mergeUniqueStrings(previousImages, nextImages);
  previous.timestamp = previous.timestamp || nextMessage.timestamp;
  return true;
}

// Claude 每条 tool_result 的图片编号是局部编号；合并连续 assistant turn 时必须平移到整条消息的全局编号。
function shiftClaudeImageReferences(content, offset) {
  const baseOffset = Number(offset) || 0;
  if (baseOffset <= 0) return String(content || '');
  return String(content || '').replace(/\[Image\s*#(\d+)\]/gi, (_match, numberText) => {
    const imageNumber = Number(numberText);
    if (!Number.isFinite(imageNumber) || imageNumber <= 0) return _match;
    return `[Image #${imageNumber + baseOffset}]`;
  });
}

function extractCodexUserResponseMessage(payload) {
  const contentBlocks = Array.isArray(payload && payload.content) ? payload.content : [];
  const textParts = [];
  const images = [];

  contentBlocks.forEach((block) => {
    if (!block || typeof block !== 'object') return;
    if (block.type === 'input_text') {
      const text = String(block.text || '');
      if (text) {
        textParts.push(text);
      }
      return;
    }
    if (block.type === 'input_image') {
      const imageUrl = String(block.image_url || '').trim();
      if (imageUrl) images.push(imageUrl);
    }
  });

  return {
    content: cleanCodexUserMessageContent(textParts.join('\n'), images.length > 0),
    images
  };
}

function cleanCodexUserMessageContent(content, _hasImages = false) {
  return String(content || '')
    .replace(/<\/?image\b[^>]*>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toCodexUserMessageKey(content) {
  return cleanCodexUserMessageContent(content, true)
    .replace(/\s+/g, ' ')
    .trim();
}

function getCodexImagePriority(source) {
  const value = String(source || '').trim();
  if (/^data:image\//i.test(value)) return 5;
  if (/^(blob:|https?:\/\/)/i.test(value)) return 4;
  if (value.startsWith('/v0/webui/chat/attachments')) return 3;
  if (path.isAbsolute(value) && fs.existsSync(value)) return 2;
  return value ? 1 : 0;
}

function preferCodexImageSource(existing, incoming) {
  if (!existing) return incoming || '';
  if (!incoming) return existing;
  return getCodexImagePriority(incoming) > getCodexImagePriority(existing) ? incoming : existing;
}

function mergeCodexUserImages(existing, incoming) {
  const existingList = mergeUniqueStrings([], existing);
  const incomingList = mergeUniqueStrings([], incoming);
  const maxLength = Math.max(existingList.length, incomingList.length);
  const merged = [];

  for (let index = 0; index < maxLength; index += 1) {
    merged.push(preferCodexImageSource(existingList[index], incomingList[index]));
  }

  return mergeUniqueStrings([], merged);
}

function guessImageMimeTypeFromPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
}

function toRenderableCodexImageSource(source) {
  const value = String(source || '').trim();
  if (!value) return '';
  if (/^(data:image\/|blob:|https?:\/\/|\/v0\/webui\/chat\/attachments)/i.test(value)) return value;
  if (!path.isAbsolute(value) || !fs.existsSync(value)) return value;

  try {
    const stat = fs.statSync(value);
    if (!stat || !stat.isFile()) return value;
    const mimeType = guessImageMimeTypeFromPath(value);
    if (!/^image\//i.test(mimeType)) return value;
    return `data:${mimeType};base64,${fs.readFileSync(value).toString('base64')}`;
  } catch (_error) {
    return value;
  }
}

function extractCodexReasoningText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (Array.isArray(payload.summary)) {
    const summaryText = payload.summary
      .filter((item) => item && item.type === 'summary_text' && item.text)
      .map((item) => String(item.text || '').trim())
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (summaryText) return summaryText;
  }
  return String(payload.text || '').trim();
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

function forEachJsonlLineSyncFromOffset(filePath, startOffset, onLine, options = {}) {
  const chunkSize = Math.max(4096, Number(options.chunkSize) || 256 * 1024);
  const maxCarryChars = Math.max(1024, Number(options.maxCarryChars) || 8 * 1024 * 1024);
  let fd;

  try {
    fd = fs.openSync(filePath, 'r');
    const stats = fs.fstatSync(fd);
    const safeStart = Math.max(0, Math.min(Number(startOffset) || 0, Number(stats.size) || 0));
    const buffer = Buffer.alloc(chunkSize);
    let position = safeStart;
    let carry = '';
    let skipPartialFirstLine = safeStart > 0;

    if (safeStart > 0) {
      const prevByte = Buffer.alloc(1);
      const prevRead = fs.readSync(fd, prevByte, 0, 1, safeStart - 1);
      if (prevRead > 0 && prevByte.toString('utf8') === '\n') {
        skipPartialFirstLine = false;
      }
    }

    while (position < stats.size) {
      const bytesToRead = Math.min(chunkSize, stats.size - position);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) break;
      position += bytesRead;

      carry += buffer.toString('utf8', 0, bytesRead);
      let newlineIndex = carry.indexOf('\n');

      while (newlineIndex >= 0) {
        const line = carry.slice(0, newlineIndex).replace(/\r$/, '');
        carry = carry.slice(newlineIndex + 1);
        if (!skipPartialFirstLine && line.trim()) onLine(line);
        skipPartialFirstLine = false;
        newlineIndex = carry.indexOf('\n');
      }

      if (carry.length > maxCarryChars) {
        carry = '';
        skipPartialFirstLine = false;
      }
    }

    if (!skipPartialFirstLine && carry.trim()) {
      onLine(carry.replace(/\r$/, ''));
    }

    return Number(stats.size) || 0;
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

  function addKnownPath(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    paths.add(normalized);
  }

  collectCodexWorkspaceRoots().forEach(addKnownPath);

  // 从 Gemini trustedFolders.json
  try {
    const trustedPath = path.join(hostHome, '.gemini', 'trustedFolders.json');
    if (fs.existsSync(trustedPath)) {
      const data = JSON.parse(fs.readFileSync(trustedPath, 'utf8'));
      for (const p of Object.keys(data)) {
        addKnownPath(p);
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
          addKnownPath(p);
        }
      }
    }
  } catch (e) { /* ignore */ }

  return paths;
}

function collectCodexWorkspaceRoots() {
  const hostHome = getRealHome();
  const roots = [];
  const seen = new Set();

  function addRoot(value) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    roots.push(normalized);
  }

  try {
    const configPath = path.join(hostHome, '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const regex = /\[projects\."([^"]+)"\]/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        addRoot(match[1]);
      }
    }
  } catch (_error) { /* ignore */ }

  try {
    const globalStatePath = path.join(hostHome, '.codex', '.codex-global-state.json');
    if (fs.existsSync(globalStatePath)) {
      const state = JSON.parse(fs.readFileSync(globalStatePath, 'utf8'));
      [
        state['electron-saved-workspace-roots'],
        state['active-workspace-roots'],
        state['project-order']
      ].forEach((items) => {
        (Array.isArray(items) ? items : []).forEach(addRoot);
      });

      const threadWorkspaceHints = state['thread-workspace-root-hints'];
      if (threadWorkspaceHints && typeof threadWorkspaceHints === 'object') {
        Object.values(threadWorkspaceHints).forEach(addRoot);
      }
    }
  } catch (_error) { /* ignore */ }

  return roots;
}

function resetCodexSessionIndexCache(sessionIndexPath = '') {
  codexSessionIndexCache.sessionIndexPath = sessionIndexPath;
  codexSessionIndexCache.fileSize = 0;
  codexSessionIndexCache.mtimeMs = 0;
  codexSessionIndexCache.offset = 0;
  codexSessionIndexCache.entries = new Map();
}

function readCodexSessionIndexMap(codexDir) {
  const sessionIndexPath = path.join(codexDir, 'session_index.jsonl');
  if (!fs.existsSync(sessionIndexPath)) {
    resetCodexSessionIndexCache(sessionIndexPath);
    return codexSessionIndexCache.entries;
  }

  try {
    const stats = fs.statSync(sessionIndexPath);
    const fileSize = Number(stats.size) || 0;
    const mtimeMs = Number(stats.mtimeMs) || 0;
    const isSameFile = codexSessionIndexCache.sessionIndexPath === sessionIndexPath;
    const needsFullReload = !isSameFile
      || fileSize < codexSessionIndexCache.fileSize
      || mtimeMs < codexSessionIndexCache.mtimeMs;

    if (needsFullReload) {
      resetCodexSessionIndexCache(sessionIndexPath);
    }

    if (fileSize > codexSessionIndexCache.offset) {
      forEachJsonlLineSyncFromOffset(sessionIndexPath, codexSessionIndexCache.offset, (line) => {
        const entry = safeParseJsonLine(line);
        if (!entry || !entry.id) return;
        codexSessionIndexCache.entries.set(entry.id, {
          thread_name: entry.thread_name,
          updated_at: entry.updated_at
        });
      });
      codexSessionIndexCache.offset = fileSize;
    }

    codexSessionIndexCache.sessionIndexPath = sessionIndexPath;
    codexSessionIndexCache.fileSize = fileSize;
    codexSessionIndexCache.mtimeMs = mtimeMs;
    return codexSessionIndexCache.entries;
  } catch (_error) {
    resetCodexSessionIndexCache(sessionIndexPath);
    return codexSessionIndexCache.entries;
  }
}

function extractCodexSessionIdFromPath(sessionFilePath) {
  const fileName = path.basename(sessionFilePath, '.jsonl');
  const uuidMatch = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuidMatch ? uuidMatch[1] : '';
}

function normalizeCodexSessionFilePath(codexDir, sessionId, sessionFilePath) {
  const id = String(sessionId || '').trim();
  const rawPath = String(sessionFilePath || '').trim();
  if (!id || !rawPath) return '';
  const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(codexDir, rawPath);
  if (!path.basename(candidate).includes(id) || !candidate.endsWith('.jsonl')) return '';
  try {
    if (!fs.existsSync(candidate)) return '';
    if (!fs.statSync(candidate).isFile()) return '';
    return candidate;
  } catch (_error) {
    return '';
  }
}

function cacheCodexSessionPath(sessionId, sessionFilePath) {
  const id = String(sessionId || '').trim();
  const normalizedPath = String(sessionFilePath || '').trim();
  if (!id || !normalizedPath) return;
  codexSessionPathCache.set(id, normalizedPath);
}

function getCachedCodexSessionPath(sessionId) {
  const id = String(sessionId || '').trim();
  const cachedPath = id ? codexSessionPathCache.get(id) : '';
  if (!cachedPath) return '';
  const normalizedPath = String(cachedPath || '').trim();
  try {
    if (
      normalizedPath
      && path.basename(normalizedPath).includes(id)
      && fs.existsSync(normalizedPath)
      && fs.statSync(normalizedPath).isFile()
    ) {
      return normalizedPath;
    }
  } catch (_error) { /* ignore stale cache */ }
  codexSessionPathCache.delete(id);
  return '';
}

function getCachedCodexSessionMeta(sessionFilePath, stats, options = {}) {
  const fileSize = Number(stats && stats.size) || 0;
  const mtimeMs = Number(stats && stats.mtimeMs) || 0;
  let cacheEntry = codexSessionMetaCache.get(sessionFilePath);

  if (!cacheEntry) {
    cacheEntry = {
      sessionId: '',
      cwd: '',
      fallbackTitle: '',
      lastKnownSize: 0,
      lastKnownMtimeMs: 0,
      lastTitleScanSize: 0
    };
    codexSessionMetaCache.set(sessionFilePath, cacheEntry);
  }

  if (fileSize < cacheEntry.lastKnownSize || mtimeMs < cacheEntry.lastKnownMtimeMs) {
    cacheEntry.cwd = '';
    cacheEntry.fallbackTitle = '';
    cacheEntry.lastTitleScanSize = 0;
  }

  if (!cacheEntry.sessionId) {
    cacheEntry.sessionId = extractCodexSessionIdFromPath(sessionFilePath);
  }

  if (!cacheEntry.cwd) {
    cacheEntry.cwd = readCodexSessionCwd(sessionFilePath) || '';
  }

  const shouldReadFallbackTitle = Boolean(options.readFallbackTitle)
    && !cacheEntry.fallbackTitle
    && fileSize > Number(cacheEntry.lastTitleScanSize || 0);
  if (shouldReadFallbackTitle) {
    cacheEntry.fallbackTitle = readCodexSessionTitle(sessionFilePath) || '';
    cacheEntry.lastTitleScanSize = fileSize;
  }

  cacheEntry.lastKnownSize = fileSize;
  cacheEntry.lastKnownMtimeMs = mtimeMs;
  return cacheEntry;
}

function pruneCodexSessionMetaCache(sessionFiles, sessionsDir) {
  const knownFiles = new Set(Array.isArray(sessionFiles) ? sessionFiles : []);
  for (const sessionFilePath of codexSessionMetaCache.keys()) {
    if (!String(sessionFilePath || '').startsWith(sessionsDir)) continue;
    if (!knownFiles.has(sessionFilePath)) {
      codexSessionMetaCache.delete(sessionFilePath);
    }
  }
}

function removeCodexSessionMetaCacheEntry(sessionFilePath) {
  codexSessionMetaCache.delete(sessionFilePath);
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

function isClaudeSidechainRecord(record) {
  return Boolean(record && typeof record === 'object' && record.isSidechain === true);
}

function isClaudePrimaryConversationRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.isSidechain === true) return false;
  return record.type === 'user' || record.type === 'assistant';
}

function repairClaudeSessionTranscript(sessionFilePath) {
  const normalizedPath = String(sessionFilePath || '').trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) return false;

  let sawSidechain = false;
  let sawPrimaryConversation = false;
  const tempPath = `${normalizedPath}.repair-${process.pid}-${Date.now()}`;
  let fd;

  try {
    fd = fs.openSync(tempPath, 'w');
    forEachJsonlLineSync(normalizedPath, (line) => {
      const record = safeParseJsonLine(line);
      if (isClaudeSidechainRecord(record)) {
        sawSidechain = true;
        return;
      }
      if (isClaudePrimaryConversationRecord(record)) {
        sawPrimaryConversation = true;
      }
      fs.writeSync(fd, `${line}\n`);
    });
  } catch (_error) {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch (_closeError) {}
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_unlinkError) {}
    return false;
  }

  try {
    if (fd !== undefined) fs.closeSync(fd);
  } catch (_error) {}

  if (!sawSidechain || !sawPrimaryConversation) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_error) {}
    return false;
  }

  try {
    fs.moveSync(tempPath, normalizedPath, { overwrite: true });
    return true;
  } catch (_error) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_unlinkError) {}
    return false;
  }
}

// ============================================================
// Claude 项目读取
// ============================================================
function readClaudeProjectFromHostDir(projectDirName, knownPaths) {
  const hostHome = getRealHome();
  const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');
  const projectPath = path.join(claudeProjectsDir, projectDirName);

  if (!fs.existsSync(projectPath)) return null;

  const stat = fs.statSync(projectPath);
  if (!stat.isDirectory()) return null;

  const sessionFiles = fs.readdirSync(projectPath).filter((fileName) => fileName.endsWith('.jsonl'));
  const sessions = [];
  let resolvedCwd = '';

  function adoptResolvedCwd(record) {
    if (resolvedCwd) return;
    if (!record || typeof record !== 'object') return;
    const cwd = String(record.cwd || '').trim();
    if (!cwd || !fs.existsSync(cwd)) return;
    try {
      if (!fs.statSync(cwd).isDirectory()) return;
    } catch (_error) {
      return;
    }
    resolvedCwd = cwd;
  }

  for (const sessionFile of sessionFiles) {
    const sessionId = sessionFile.replace('.jsonl', '');
    const sessionFilePath = path.join(projectPath, sessionFile);
    repairClaudeSessionTranscript(sessionFilePath);
    const stats = fs.statSync(sessionFilePath);

    let title = '未命名会话';
    try {
      const fd = fs.openSync(sessionFilePath, 'r');
      try {
        const buf = Buffer.alloc(16384);
        const bytesRead = fs.readSync(fd, buf, 0, 16384, 0);
        const chunk = buf.toString('utf8', 0, bytesRead);
        const lines = chunk.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          try {
            const record = JSON.parse(line);
            adoptResolvedCwd(record);
            if (record.isSidechain === true) continue;
            if (record.type === 'user' && record.message && record.message.content) {
              const msg = record.message;
              let text = '';
              if (typeof msg.content === 'string') {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                text = msg.content
                  .map((block) => block.type === 'text' ? block.text : '')
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
          } catch (_error) { /* skip malformed line */ }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (_error) { /* ignore */ }

    if (title === 'Warmup' || title === '未命名会话') continue;

    sessions.push({
      id: sessionId,
      title,
      updatedAt: stats.mtimeMs,
      provider: 'claude',
      projectDirName
    });
  }

  if (sessions.length === 0) return null;

  const realPath = resolvedCwd || resolveClaudeProjectPath(projectDirName, knownPaths);

  return {
    id: projectDirName,
    name: path.basename(realPath),
    path: realPath,
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    provider: 'claude'
  };
}

function readClaudeProjectsFromHostByDirNames(projectDirNames, knownPaths) {
  const projects = [];
  const seen = new Set();

  for (const projectDirName of Array.isArray(projectDirNames) ? projectDirNames : []) {
    const normalizedName = String(projectDirName || '').trim();
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);

    try {
      const project = readClaudeProjectFromHostDir(normalizedName, knownPaths);
      if (project) projects.push(project);
    } catch (_error) { /* ignore */ }
  }

  return projects;
}

function readClaudeProjectsFromHost(knownPaths) {
  const projects = [];
  const hostHome = getRealHome();
  const claudeProjectsDir = path.join(hostHome, '.claude', 'projects');

  try {
    if (!fs.existsSync(claudeProjectsDir)) return [];

    const projectDirs = fs.readdirSync(claudeProjectsDir);
    for (const project of readClaudeProjectsFromHostByDirNames(projectDirs, knownPaths)) {
      projects.push(project);
    }
  } catch (error) {
    console.error('Failed to read Claude projects:', error);
  }

  return projects;
}

// ============================================================
// Codex 项目读取
// ============================================================

function parseJsonStringLiteral(value) {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : '';
  } catch (_error) {
    return '';
  }
}

/**
 * 从 Codex session 文件首块提取 cwd。
 * 只解析 cwd 这个 JSON 字符串，避免完整读取大 transcript，同时保留 Windows 路径转义语义。
 */
function readCodexSessionCwd(sessionFilePath) {
  let fd;
  try {
    fd = fs.openSync(sessionFilePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    const chunk = buf.toString('utf8', 0, bytesRead);
    const match = chunk.match(/"cwd"\s*:\s*("(?:\\.|[^"\\])*")/);
    if (match && match[1]) return parseJsonStringLiteral(match[1]);
  } catch (_error) { /* ignore */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_closeError) {} }
  return null;
}

function extractCodexUserTitleFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';

  if (payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
    const text = payload.content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'input_text') return String(block.text || '');
        if (block.type === 'text') return String(block.text || '');
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
    return text;
  }

  if (payload.type === 'user_message') {
    return String(payload.message || '').trim();
  }

  return '';
}

function readCodexSessionTitle(sessionFilePath) {
  let title = '';
  try {
    forEachJsonlLineSync(sessionFilePath, (line) => {
      if (title) return;
      const record = safeParseJsonLine(line);
      if (!record) return;
      const nextTitle = extractCodexUserTitleFromPayload(record.payload || {});
      if (!nextTitle) return;
      if (nextTitle.startsWith('Caveat:') || nextTitle.startsWith('<command-name>') || nextTitle.startsWith('<local-command')) return;
      if (isCodexSessionTitleSyntheticContent(nextTitle)) return;
      title = normalizeCodexSessionTitle(nextTitle, 50);
    });
  } catch (_error) {
    return '';
  }
  return title;
}

function normalizeProjectPathForLookup(projectPath) {
  const normalizedPath = String(projectPath || '').trim();
  if (!normalizedPath) return '';
  return normalizedPath.replace(/\/+$/, '');
}

function isCodexWorktreeProjectPath(projectPath) {
  return normalizeProjectPathForLookup(projectPath).replace(/\\/g, '/').includes('/.codex/worktrees/');
}

function buildCodexProjectFromSessions(cwd, sessions) {
  return {
    id: Buffer.from(cwd).toString('base64').replace(/[/+=]/g, '_'),
    name: path.basename(cwd),
    path: cwd,
    sessions: sessions.sort((left, right) => right.updatedAt - left.updatedAt),
    provider: 'codex'
  };
}

function buildCodexSessionRecord(sessionFilePath, stats, nameMap) {
  const baseMeta = getCachedCodexSessionMeta(sessionFilePath, stats);
  const cwd = normalizeProjectPathForLookup(baseMeta.cwd);
  if (!cwd) return null;
  if (isCodexWorktreeProjectPath(cwd)) return null;

  const sessionId = baseMeta.sessionId;
  if (!sessionId) return null;

  const nameEntry = nameMap.get(sessionId);
  const sessionMeta = nameEntry && nameEntry.thread_name
    ? baseMeta
    : getCachedCodexSessionMeta(sessionFilePath, stats, { readFallbackTitle: true });
  const title = normalizeCodexSessionTitle(nameEntry?.thread_name || sessionMeta.fallbackTitle);
  if (!title) return null;

  return {
    cwd,
    session: {
      id: sessionId,
      title,
      updatedAt: nameEntry?.updated_at
        ? new Date(nameEntry.updated_at).getTime()
        : stats.mtimeMs,
      provider: 'codex'
    }
  };
}

function listCodexStateDbPaths(codexDir) {
  try {
    return fs.readdirSync(codexDir)
      .filter((entryName) => /^state_\d+\.sqlite$/i.test(entryName))
      .map((entryName) => path.join(codexDir, entryName))
      .sort((left, right) => {
        const leftVersion = Number((path.basename(left).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        const rightVersion = Number((path.basename(right).match(/^state_(\d+)\.sqlite$/i) || [])[1]) || 0;
        if (leftVersion !== rightVersion) return rightVersion - leftVersion;
        try {
          return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
        } catch (_error) {
          return 0;
        }
      });
  } catch (_error) {
    return [];
  }
}

function getSqliteTableColumns(db, tableName) {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info(${tableName})`).all()
        .map((row) => String(row && row.name || '').trim())
        .filter(Boolean)
    );
  } catch (_error) {
    return new Set();
  }
}

function buildCodexThreadsQuery(columns) {
  if (!columns.has('id') || !columns.has('cwd') || !columns.has('title')) return '';

  const updatedAtMsExpr = columns.has('updated_at_ms') ? 'updated_at_ms' : 'NULL AS updated_at_ms';
  const updatedAtExpr = columns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';
  const rolloutPathExpr = columns.has('rollout_path') ? 'rollout_path' : 'NULL AS rollout_path';
  const firstUserMessageExpr = columns.has('first_user_message') ? 'first_user_message' : 'NULL AS first_user_message';
  const whereClause = columns.has('archived') ? 'WHERE archived = 0' : '';
  const orderExpr = columns.has('updated_at_ms') && columns.has('updated_at')
    ? 'COALESCE(updated_at_ms, updated_at * 1000)'
    : columns.has('updated_at_ms')
      ? 'updated_at_ms'
      : columns.has('updated_at')
        ? 'updated_at * 1000'
        : 'id';

  return `
    SELECT id, cwd, title, ${updatedAtExpr}, ${updatedAtMsExpr}, ${rolloutPathExpr}, ${firstUserMessageExpr}
    FROM threads
    ${whereClause}
    ORDER BY ${orderExpr} DESC, id DESC
  `;
}

function resolveCodexSessionPathFromStateDb(codexDir, sessionId) {
  const DatabaseSync = getDatabaseSyncCtor();
  if (!DatabaseSync) return '';

  for (const stateDbPath of listCodexStateDbPaths(codexDir)) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      const columns = getSqliteTableColumns(db, 'threads');
      if (!columns.has('id') || !columns.has('rollout_path')) continue;
      const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1').get(sessionId);
      const sessionFilePath = normalizeCodexSessionFilePath(codexDir, sessionId, row && row.rollout_path);
      if (!sessionFilePath) continue;
      cacheCodexSessionPath(sessionId, sessionFilePath);
      return sessionFilePath;
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return '';
}

function readCodexThreadsFromStateDb(codexDir, options = {}) {
  const DatabaseSync = getDatabaseSyncCtor();
  if (!DatabaseSync) return [];

  const stateDbPaths = listCodexStateDbPaths(codexDir);
  if (stateDbPaths.length === 0) return [];

  const projectPaths = new Set(
    (Array.isArray(options.projectPaths) ? options.projectPaths : [])
      .map((projectPath) => normalizeProjectPathForLookup(projectPath))
      .filter(Boolean)
  );
  const hasProjectFilter = projectPaths.size > 0;
  const nameMap = readCodexSessionIndexMap(codexDir);

  for (const stateDbPath of stateDbPaths) {
    let db = null;
    try {
      db = new DatabaseSync(stateDbPath, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');

      const query = buildCodexThreadsQuery(getSqliteTableColumns(db, 'threads'));
      if (!query) continue;
      const rows = db.prepare(query).all();

      return rows
        .map((row) => {
          const cwd = normalizeProjectPathForLookup(row && row.cwd);
          const id = String(row && row.id || '').trim();
          if (!id || !cwd) return null;
          if (isCodexWorktreeProjectPath(cwd)) return null;
          if (hasProjectFilter && !projectPaths.has(cwd)) return null;
          const sessionFilePath = normalizeCodexSessionFilePath(codexDir, id, row && row.rollout_path);
          const nameEntry = nameMap.get(id);
          const title = normalizeCodexSessionTitle(nameEntry && nameEntry.thread_name || row && (row.title || row.first_user_message))
            || (sessionFilePath ? readCodexSessionTitle(sessionFilePath) : '');
          if (!title) return null;
          return {
            cwd,
            sessionFilePath,
            session: {
              id,
              title,
              updatedAt: Number(row.updated_at_ms) || (Number(row.updated_at) * 1000) || 0,
              provider: 'codex'
            }
          };
        })
        .filter(Boolean);
    } catch (_error) {
      continue;
    } finally {
      if (db && typeof db.close === 'function') {
        try { db.close(); } catch (_closeError) {}
      }
    }
  }

  return [];
}

function addCodexSessionRecord(projectSessionMap, seenSessionIds, sessionRecord) {
  if (!sessionRecord || !sessionRecord.cwd || !sessionRecord.session) return;
  const sessionId = String(sessionRecord.session.id || '').trim();
  if (!sessionId || seenSessionIds.has(sessionId)) return;
  if (sessionRecord.sessionFilePath) {
    cacheCodexSessionPath(sessionId, sessionRecord.sessionFilePath);
  }
  seenSessionIds.add(sessionId);
  if (!projectSessionMap.has(sessionRecord.cwd)) {
    projectSessionMap.set(sessionRecord.cwd, []);
  }
  projectSessionMap.get(sessionRecord.cwd).push(sessionRecord.session);
}

function collectCachedCodexSessionFilesByProjectPaths(projectPaths, sessionsDir) {
  const targetPaths = new Set(
    (Array.isArray(projectPaths) ? projectPaths : [])
      .map((projectPath) => normalizeProjectPathForLookup(projectPath))
      .filter(Boolean)
  );
  const filesByProjectPath = new Map();

  for (const projectPath of targetPaths) {
    filesByProjectPath.set(projectPath, new Set());
  }

  for (const [sessionFilePath, cacheEntry] of codexSessionMetaCache.entries()) {
    if (!String(sessionFilePath || '').startsWith(sessionsDir)) continue;
    const cwd = normalizeProjectPathForLookup(cacheEntry && cacheEntry.cwd);
    if (!cwd || !targetPaths.has(cwd)) continue;
    filesByProjectPath.get(cwd).add(sessionFilePath);
  }

  return filesByProjectPath;
}

function readCodexSessionProjectPath(sessionFilePath) {
  const normalizedPath = String(sessionFilePath || '').trim();
  if (!normalizedPath) return '';

  let stats = null;
  try {
    if (fs.existsSync(normalizedPath)) {
      stats = fs.statSync(normalizedPath);
    }
  } catch (_error) {
    stats = null;
  }

  if (stats) {
    const meta = getCachedCodexSessionMeta(normalizedPath, stats);
    return normalizeProjectPathForLookup(meta && meta.cwd);
  }

  const cacheEntry = codexSessionMetaCache.get(normalizedPath);
  if (!cacheEntry) return '';
  return normalizeProjectPathForLookup(cacheEntry.cwd);
}

function readCodexProjectsFromHostByPaths(projectPaths) {
  const targetPaths = Array.from(new Set(
    (Array.isArray(projectPaths) ? projectPaths : [])
      .map((projectPath) => normalizeProjectPathForLookup(projectPath))
      .filter(Boolean)
  ));
  if (targetPaths.length === 0) return [];

  const hostHome = getRealHome();
  const codexDir = path.join(hostHome, '.codex');
  const sessionsDir = path.join(codexDir, 'sessions');
  const nameMap = readCodexSessionIndexMap(codexDir);
  const projectSessionMap = new Map();
  const seenSessionIds = new Set();
  const sessionFilesByProjectPath = collectCachedCodexSessionFilesByProjectPaths(targetPaths, sessionsDir);

  for (const projectPath of targetPaths) {
    projectSessionMap.set(projectPath, []);
  }

  for (const sessionRecord of readCodexThreadsFromStateDb(codexDir, { projectPaths: targetPaths })) {
    addCodexSessionRecord(projectSessionMap, seenSessionIds, sessionRecord);
  }

  for (const projectPath of targetPaths) {
    const sessionFiles = Array.from(sessionFilesByProjectPath.get(projectPath) || []);
    for (const sessionFilePath of sessionFiles) {
      const sessionId = extractCodexSessionIdFromPath(sessionFilePath);
      if (sessionId && seenSessionIds.has(sessionId)) {
        cacheCodexSessionPath(sessionId, sessionFilePath);
        continue;
      }

      if (!fs.existsSync(sessionFilePath)) {
        removeCodexSessionMetaCacheEntry(sessionFilePath);
        continue;
      }

      let stats = null;
      try {
        stats = fs.statSync(sessionFilePath);
      } catch (_error) {
        removeCodexSessionMetaCacheEntry(sessionFilePath);
        continue;
      }

      const sessionRecord = buildCodexSessionRecord(sessionFilePath, stats, nameMap);
      if (!sessionRecord || sessionRecord.cwd !== projectPath) continue;
      addCodexSessionRecord(projectSessionMap, seenSessionIds, sessionRecord);
    }
  }

  const workspaceRoots = new Set(
    collectCodexWorkspaceRoots()
      .map((workspaceRoot) => normalizeProjectPathForLookup(workspaceRoot))
      .filter(Boolean)
  );
  const projects = [];

  for (const [cwd, sessions] of projectSessionMap.entries()) {
    if (sessions.length === 0 && !workspaceRoots.has(cwd)) continue;
    if (workspaceRoots.has(cwd) && !fs.existsSync(cwd)) continue;
    projects.push(buildCodexProjectFromSessions(cwd, sessions));
  }

  return projects;
}

function readCodexProjectsFromHost() {
  const hostHome = getRealHome();
  const codexDir = path.join(hostHome, '.codex');

  try {
    // 1. 读取 session_index.jsonl 获取 thread_name 映射
    const nameMap = readCodexSessionIndexMap(codexDir); // session id -> {thread_name, updated_at}

    // 2. 扫描 session 文件，从 metadata 提取 cwd，按 cwd 分组
    const projectSessionMap = new Map(); // cwd -> sessions[]
    const seenSessionIds = new Set();
    for (const sessionRecord of readCodexThreadsFromStateDb(codexDir)) {
      addCodexSessionRecord(projectSessionMap, seenSessionIds, sessionRecord);
    }

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
      pruneCodexSessionMetaCache(sessionFiles, sessionsDir);

      for (const sessionFile of sessionFiles) {
        const sessionId = extractCodexSessionIdFromPath(sessionFile);
        if (sessionId && seenSessionIds.has(sessionId)) {
          cacheCodexSessionPath(sessionId, sessionFile);
          continue;
        }

        let stats;
        try {
          stats = fs.statSync(sessionFile);
        } catch (_error) {
          continue;
        }
        const sessionRecord = buildCodexSessionRecord(sessionFile, stats, nameMap);
        if (!sessionRecord) continue;
        addCodexSessionRecord(projectSessionMap, seenSessionIds, sessionRecord);
      }
    }

    const knownWorkspaceRoots = collectCodexWorkspaceRoots();
    for (const workspaceRoot of knownWorkspaceRoots) {
      const normalizedRoot = normalizeProjectPathForLookup(workspaceRoot);
      if (!normalizedRoot) continue;
      if (projectSessionMap.has(normalizedRoot)) continue;
      if (!fs.existsSync(normalizedRoot)) continue;
      let stats = null;
      try {
        stats = fs.statSync(normalizedRoot);
      } catch (_error) {
        stats = null;
      }
      if (!stats || !stats.isDirectory()) continue;
      projectSessionMap.set(normalizedRoot, []);
    }

    // 3. 转换为项目列表
    const projects = [];
    for (const [cwd, sessions] of projectSessionMap) {
      projects.push(buildCodexProjectFromSessions(cwd, sessions));
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
function buildGeminiProjectPathMap(geminiDir) {
  const projectPathMap = new Map();
  const historyDir = path.join(geminiDir, 'history');

  if (!fs.existsSync(historyDir)) {
    return projectPathMap;
  }

  for (const name of fs.readdirSync(historyDir)) {
    const rootFile = path.join(historyDir, name, '.project_root');
    if (!fs.existsSync(rootFile)) continue;
    projectPathMap.set(name, fs.readFileSync(rootFile, 'utf8').trim());
  }

  return projectPathMap;
}

// 解析 gemini 的 `.json` 检查点（/chat save 产物）：summary + messages[].type==='user'。
function readGeminiJsonChatSession(chatPath, normalizedName) {
  try {
    const fd = fs.openSync(chatPath, 'r');
    let chunk = '';
    try {
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      chunk = buf.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
    const sessionIdMatch = chunk.match(/"sessionId"\s*:\s*"([^"]+)"/);
    const summaryMatch = chunk.match(/"summary"\s*:\s*"([^"]+)"/);
    const lastUpdatedMatch = chunk.match(/"lastUpdated"\s*:\s*"([^"]+)"/);

    let title = summaryMatch ? summaryMatch[1] : '';
    if (!title) {
      const fullData = JSON.parse(fs.readFileSync(chatPath, 'utf8'));
      if (fullData.messages && fullData.messages.length > 0) {
        const firstUser = fullData.messages.find((message) => message.type === 'user');
        if (firstUser && firstUser.content) {
          const textBlock = Array.isArray(firstUser.content)
            ? firstUser.content.find((content) => content.text)
            : firstUser.content;
          title = (typeof textBlock === 'string' ? textBlock : textBlock?.text || '').slice(0, 50);
        }
      }
    }
    if (!title || title === 'Warmup') return null;

    const sessionId = sessionIdMatch ? sessionIdMatch[1] : path.basename(chatPath).replace(/\.json$/, '');
    const updatedAt = lastUpdatedMatch ? new Date(lastUpdatedMatch[1]).getTime() : fs.statSync(chatPath).mtimeMs;
    return { id: sessionId, title, updatedAt, provider: 'gemini', projectDirName: normalizedName };
  } catch (_error) {
    return null;
  }
}

// 解析 gemini 的 `.jsonl` 原生会话文件（WebUI native session / --session-file fork 产物）：
// 首行 meta 含 sessionId；后续 `type==='user'` 记录的 content 为标题来源。
// 旧实现只读 `.json` 检查点（仅 /chat save 产物），把这些 `.jsonl` 原生会话漏掉了 →
// WebUI 跑完 gemini 刷新后会话从列表“消失”（被误认为自动归档）。
function readGeminiJsonlChatSession(chatPath, normalizedName) {
  try {
    const lines = fs.readFileSync(chatPath, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length === 0) return null;

    let sessionId = '';
    const firstMeta = safeParseJsonLine(lines[0]);
    if (firstMeta && firstMeta.sessionId) sessionId = String(firstMeta.sessionId).trim();
    if (!sessionId) sessionId = path.basename(chatPath).replace(/\.jsonl$/, '');

    let title = '';
    for (const line of lines) {
      const record = safeParseJsonLine(line);
      if (!record || record.type !== 'user') continue;
      const content = record.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) text = (content.find((block) => block && block.text)?.text) || '';
      text = String(text || '').trim();
      if (text) { title = text.slice(0, 50); break; }
    }
    if (!title || title === 'Warmup') return null;

    let updatedAt = 0;
    try { updatedAt = Number(fs.statSync(chatPath).mtimeMs) || 0; } catch (_error) {}
    return { id: sessionId, title, updatedAt, provider: 'gemini', projectDirName: normalizedName };
  } catch (_error) {
    return null;
  }
}

function readGeminiProjectFromHostName(projectName, projectPathMap, geminiDir) {
  const normalizedName = String(projectName || '').trim();
  if (!normalizedName) return null;

  const tmpDir = path.join(geminiDir, 'tmp');
  const chatsDir = path.join(tmpDir, normalizedName, 'chats');
  if (!fs.existsSync(chatsDir)) return null;

  // 按 sessionId 去重：同一 sessionId 若既有 .json 检查点又有 .jsonl，以先读到的 .json 为准。
  const sessionsById = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(chatsDir);
  } catch (_error) {
    entries = [];
  }

  // 先读 .json（curated summary 优先），再补 .jsonl 原生会话。
  const jsonSessionIds = new Set();
  for (const fileName of entries.filter((name) => name.endsWith('.json'))) {
    const record = readGeminiJsonChatSession(path.join(chatsDir, fileName), normalizedName);
    if (record && !sessionsById.has(record.id)) {
      sessionsById.set(record.id, record);
      jsonSessionIds.add(record.id);
    }
  }
  for (const fileName of entries.filter((name) => name.endsWith('.jsonl'))) {
    const record = readGeminiJsonlChatSession(path.join(chatsDir, fileName), normalizedName);
    if (!record) continue;
    if (jsonSessionIds.has(record.id)) continue; // .json 检查点优先，不被 .jsonl 覆盖
    const existing = sessionsById.get(record.id);
    // 同 id 的多个 .jsonl fork 取 mtime 最新的那个（含本轮回复，最完整）。
    if (!existing || record.updatedAt > existing.updatedAt) sessionsById.set(record.id, record);
  }

  const sessions = Array.from(sessionsById.values());

  return {
    id: 'gemini-' + normalizedName,
    name: normalizedName,
    path: projectPathMap.get(normalizedName) || '',
    sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    provider: 'gemini'
  };
}

function readGeminiProjectsFromHostByNames(projectNames) {
  const projects = [];
  const hostHome = getRealHome();
  const geminiDir = path.join(hostHome, '.gemini');
  const projectPathMap = buildGeminiProjectPathMap(geminiDir);
  const seen = new Set();

  try {
    for (const projectName of Array.isArray(projectNames) ? projectNames : []) {
      const normalizedName = String(projectName || '').trim();
      if (!normalizedName || seen.has(normalizedName)) continue;
      seen.add(normalizedName);

      const project = readGeminiProjectFromHostName(normalizedName, projectPathMap, geminiDir);
      if (project) projects.push(project);
    }
  } catch (error) {
    console.error('Failed to read Gemini projects:', error);
  }

  return projects;
}

function readGeminiProjectsFromHost() {
  const projects = [];
  const hostHome = getRealHome();
  const geminiDir = path.join(hostHome, '.gemini');

  try {
    const tmpDir = path.join(geminiDir, 'tmp');
    if (!fs.existsSync(tmpDir)) return [];

    for (const project of readGeminiProjectsFromHostByNames(fs.readdirSync(tmpDir))) {
      projects.push(project);
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

function applyProjectNameMappings(projects, nameMappings) {
  const allProjects = Array.isArray(projects) ? projects : [];
  const mappings = nameMappings && typeof nameMappings === 'object'
    ? nameMappings
    : {};

  for (const project of allProjects) {
    if (!project || !project.path) continue;
    if (mappings[project.path]) {
      project.name = mappings[project.path];
      continue;
    }
    const normalizedPath = String(project.path).replace(/[/_]/g, '');
    for (const [mappingPath, mappingName] of Object.entries(mappings)) {
      const normalizedMappingPath = String(mappingPath).replace(/[/_]/g, '');
      if (normalizedPath === normalizedMappingPath) {
        project.name = mappingName;
        break;
      }
    }
  }

  return allProjects;
}

function sanitizeProjectSessions(projects) {
  // 会话 id 是读取、归档、恢复和消息路由的主键；空 id 不应进入 WebUI。
  return (Array.isArray(projects) ? projects : [])
    .map((project) => {
      if (!project || typeof project !== 'object') return project;
      const sessions = (Array.isArray(project.sessions) ? project.sessions : [])
        .filter((session) => String(session && session.id || '').trim());
      return {
        ...project,
        sessions
      };
    })
    .filter(Boolean);
}

function normalizeProviderFilter(providers) {
  const normalized = new Set(
    (Array.isArray(providers) ? providers : [providers])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (normalized.size === 0) {
    normalized.add('claude');
    normalized.add('codex');
    normalized.add('gemini');
    normalized.add('agy');
    normalized.add('opencode');
  }
  return normalized;
}

function normalizeProjectHintSet(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
}

// agy（antigravity）会话存储无项目信息，靠 WebUI 写的 sidecar 索引
// (~/.gemini/antigravity-cli/aih-session-projects.json: {sessionId:{projectPath,updatedAt}})
// 把 brain transcript 会话按 projectPath 归类、入项目列表。标题取首条用户消息。
function readAgyProjectsFromHost() {
  const hostHome = getRealHome();
  const indexPath = path.join(hostHome, '.gemini', 'antigravity-cli', 'aih-session-projects.json');
  let index = {};
  try {
    if (!fs.existsSync(indexPath)) return [];
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) index = parsed;
  } catch (_error) {
    return [];
  }

  const byProjectPath = new Map();
  for (const [sessionId, entry] of Object.entries(index)) {
    const id = String(sessionId || '').trim();
    const projectPath = normalizeProjectPathForLookup(entry && entry.projectPath);
    if (!id || !projectPath) continue;
    const sessionPath = resolveAgySessionPath(id, hostHome);
    if (!sessionPath || !fs.existsSync(sessionPath)) continue; // 会话还没落盘（transcript 未生成）

    let title = '';
    try {
      const messages = readAgySessionMessagesFromFile(sessionPath);
      const firstUser = Array.isArray(messages)
        ? messages.find((m) => m && m.role === 'user' && String(m.content || '').trim())
        : null;
      if (firstUser) title = String(firstUser.content || '').trim().slice(0, 50);
    } catch (_error) { /* ignore */ }
    if (!title || title === 'Warmup') continue;

    let updatedAt = 0;
    try { updatedAt = Number(fs.statSync(sessionPath).mtimeMs) || 0; } catch (_error) {}
    const entryTime = entry && entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
    if (entryTime) updatedAt = Math.max(updatedAt, entryTime);

    if (!byProjectPath.has(projectPath)) byProjectPath.set(projectPath, []);
    byProjectPath.get(projectPath).push({ id, title, updatedAt, provider: 'agy' });
  }

  const projects = [];
  for (const [projectPath, sessions] of byProjectPath) {
    projects.push({
      id: 'agy-' + Buffer.from(projectPath).toString('base64').replace(/[/+=]/g, '_'),
      name: path.basename(projectPath),
      path: projectPath,
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      provider: 'agy'
    });
  }
  return projects;
}

function parseJsonSafe(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function readOpenCodeProjectsFromHostByPaths(projectPaths = []) {
  const hostHome = getRealHome();
  const targetPaths = new Set(
    (Array.isArray(projectPaths) ? projectPaths : [])
      .map((projectPath) => normalizeProjectPathForLookup(projectPath))
      .filter(Boolean)
  );
  const hasProjectFilter = targetPaths.size > 0;
  let db = null;
  try {
    db = openOpenCodeDb(hostHome, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    const columns = getSqliteTableColumns(db, 'session');
    if (!columns.has('id') || !columns.has('directory') || !columns.has('title')) return [];
    const archivedClause = columns.has('time_archived') ? 'AND time_archived IS NULL' : '';
    const updatedExpr = columns.has('time_updated') ? 'time_updated' : 'time_created';
    const rows = db.prepare(`
      SELECT id, directory, title, ${updatedExpr} AS updated_at
      FROM session
      WHERE id <> '' ${archivedClause}
      ORDER BY ${updatedExpr} DESC, id DESC
    `).all();
    const byProjectPath = new Map();
    for (const row of rows) {
      const id = String(row && row.id || '').trim();
      const directory = normalizeProjectPathForLookup(row && row.directory);
      const title = String(row && row.title || '').trim();
      if (!id || !directory) continue;
      if (hasProjectFilter && !targetPaths.has(directory)) continue;
      if (!byProjectPath.has(directory)) byProjectPath.set(directory, []);
      byProjectPath.get(directory).push({
        id,
        title: title || id,
        updatedAt: Number(row && row.updated_at) || 0,
        provider: 'opencode'
      });
    }
    return Array.from(byProjectPath.entries()).map(([projectPath, sessions]) => ({
      id: 'opencode-' + Buffer.from(projectPath).toString('base64').replace(/[/+=]/g, '_'),
      name: path.basename(projectPath) || projectPath,
      path: projectPath,
      sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt),
      provider: 'opencode'
    }));
  } catch (_error) {
    return [];
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function readOpenCodeProjectsFromHost() {
  return readOpenCodeProjectsFromHostByPaths([]);
}

function readProjectsFromHostByProviders(providers, options = {}) {
  const requestedProviders = normalizeProviderFilter(providers);
  const knownPaths = collectKnownProjectPaths();
  const nameMappings = readProjectNameMappings();
  const projectHints = options && typeof options === 'object'
    ? options.projectHints || {}
    : {};
  const claudeProjectDirs = normalizeProjectHintSet(projectHints.claudeProjectDirs);
  const codexProjectPaths = normalizeProjectHintSet(projectHints.codexProjectPaths);
  const geminiProjectNames = normalizeProjectHintSet(projectHints.geminiProjectNames);
  const opencodeProjectPaths = normalizeProjectHintSet(projectHints.opencodeProjectPaths);
  const projects = [];

  if (requestedProviders.has('claude')) {
    projects.push(...(
      claudeProjectDirs.size > 0
        ? readClaudeProjectsFromHostByDirNames(Array.from(claudeProjectDirs), knownPaths)
        : readClaudeProjectsFromHost(knownPaths)
    ));
  }
  if (requestedProviders.has('codex')) {
    projects.push(...(
      codexProjectPaths.size > 0
        ? readCodexProjectsFromHostByPaths(Array.from(codexProjectPaths))
        : readCodexProjectsFromHost()
    ));
  }
  if (requestedProviders.has('gemini')) {
    projects.push(...(
      geminiProjectNames.size > 0
        ? readGeminiProjectsFromHostByNames(Array.from(geminiProjectNames))
        : readGeminiProjectsFromHost()
    ));
  }
  if (requestedProviders.has('agy')) {
    projects.push(...readAgyProjectsFromHost());
  }
  if (requestedProviders.has('opencode')) {
    projects.push(...(
      opencodeProjectPaths.size > 0
        ? readOpenCodeProjectsFromHostByPaths(Array.from(opencodeProjectPaths))
        : readOpenCodeProjectsFromHost()
    ));
  }

  return sanitizeProjectSessions(applyProjectNameMappings(projects, nameMappings));
}

// ============================================================
// 读取所有项目（主入口）
// ============================================================
function readAllProjectsFromHost() {
  return readProjectsFromHostByProviders(['claude', 'codex', 'gemini', 'agy', 'opencode']);
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
    repairClaudeSessionTranscript(sessionPath);

    const content = fs.readFileSync(sessionPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    // 两遍处理：第一遍收集 tool_use/tool_result，第二遍把结果合并回对应 assistant 工具块。
    const toolUseMap = new Map(); // tool_use id -> tool name
    const toolResultMap = new Map(); // tool_use_id -> { text, images }

    // 第一遍：收集所有 tool_use id 和 tool_result
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.isSidechain === true) continue;
        if (!record.message || !record.message.content) continue;
        const blocks = Array.isArray(record.message.content) ? record.message.content : [];
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            toolUseMap.set(block.id, block.name);
          }
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolResultMap.set(block.tool_use_id, normalizeClaudeToolResultContent(block.content));
          }
        }
      } catch (e) { /* ignore */ }
    }

    // 第二遍：构建消息，tool_use+tool_result 合并到 assistant 消息
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.isSidechain === true) continue;
        const msg = record.message || {};
        if (record.type !== 'user' && record.type !== 'assistant') continue;

        let text = '';
        let inlineImages = [];
        let markerImages = [];
        if (msg.content) {
          if (typeof msg.content === 'string') {
            text = msg.content;
            markerImages = extractClaudeImageMarkerPaths(text);
          } else if (Array.isArray(msg.content)) {
            const parts = [];
            let hasOnlyToolResult = true;

            for (const block of msg.content) {
              if (block.type === 'thinking' && block.thinking) {
                // Thinking 由前端折叠显示，后端保留完整内容，避免预览时丢上下文。
                parts.push('\n:::thinking\n' + block.thinking + '\n:::\n');
                hasOnlyToolResult = false;
              } else if (block.type === 'text') {
                parts.push(block.text);
                markerImages = mergeUniqueStrings(markerImages, extractClaudeImageMarkerPaths(block.text));
                hasOnlyToolResult = false;
              } else if (block.type === 'image') {
                inlineImages = mergeUniqueStrings(inlineImages, [normalizeClaudeImageSource(block)]);
                hasOnlyToolResult = false;
              } else if (block.type === 'tool_use') {
                hasOnlyToolResult = false;
                const input = block.input || {};
                const name = block.name || 'Unknown';
                let body = '';
                let toolName = name;

                if (name === 'Bash' && input.command) body = input.command;
                else if (name === 'TodoWrite' && input.todos) body = JSON.stringify(input.todos);
                else if (name === 'ExitPlanMode' && input.plan) {
                  parts.push('\n<proposed_plan>\n' + String(input.plan || '').trim() + '\n</proposed_plan>\n');
                  continue;
                }
                else if (name === 'TaskCreate' || name === 'TaskUpdate') {
                  parts.push('\n<task-notification>\n' + JSON.stringify({
                    taskId: input.taskId || input.id || '',
                    toolUseId: block.id || '',
                    outputFile: input.outputFile || input.output_file || '',
                    status: input.status || (name === 'TaskCreate' ? 'created' : ''),
                    summary: input.subject || input.description || input.summary || name
                  }) + '\n</task-notification>\n');
                  continue;
                }
                else if ((name === 'Task' || name === 'update_plan') && (input.tasks || input.plan || input.items)) {
                  toolName = name === 'update_plan' ? 'update_plan' : 'Task';
                  body = JSON.stringify({
                    explanation: input.explanation || '',
                    [toolName === 'update_plan' ? 'plan' : 'tasks']: input.tasks || input.plan || input.items
                  });
                }
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

                // 图片类 tool_result 只在正文里放轻量引用，真实数据放到 message.images 供前端统一预览。
                const resultPayload = block.id ? toolResultMap.get(block.id) : null;
                const resultImages = Array.isArray(resultPayload && resultPayload.images) ? resultPayload.images : [];
                const resultImageRefs = [];
                resultImages.forEach((imageSource) => {
                  const normalizedImageSource = String(imageSource || '').trim();
                  if (!normalizedImageSource) return;
                  const existingIndex = inlineImages.indexOf(normalizedImageSource);
                  if (existingIndex >= 0) {
                    resultImageRefs.push(`[Image #${existingIndex + 1}]`);
                    return;
                  }
                  inlineImages.push(normalizedImageSource);
                  resultImageRefs.push(`[Image #${inlineImages.length}]`);
                });
                const result = [
                  resultPayload && resultPayload.text ? resultPayload.text : '',
                  resultImageRefs.join(' ')
                ].filter(Boolean).join('\n');
                let toolSection = '\n:::tool{name="' + toolName + '"}\n' + body + '\n:::\n';
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
        const selectedImages = selectClaudeImages(markerImages, inlineImages);
        if (!text && selectedImages.length === 0) continue;
        if (text.startsWith('Caveat:') || text.startsWith('<command-name>') ||
            text.startsWith('<local-command') || text.startsWith('<system-reminder>') ||
            text.startsWith('<ide_opened_file>') || text.startsWith('<ide_')) continue;

        let cleanText = text
          .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
          .replace(/<ide_[^>]*>[\s\S]*?<\/ide_[^>]*>/g, '')
          .trim();
        if (markerImages.length > 0 || inlineImages.length > 0 || selectedImages.length > 0) {
          cleanText = stripClaudeImageMarkers(cleanText, {
            stripPlaceholders: false
          });
        }
        if (!cleanText && selectedImages.length === 0) continue;

        const nextMessage = {
          role: record.type === 'user' ? 'user' : 'assistant',
          content: cleanText,
          timestamp: record.timestamp || msg.timestamp
        };
        if (selectedImages.length > 0) {
          nextMessage.images = selectedImages;
        }
        if (tryMergeClaudeAssistantMessage(messages, nextMessage)) continue;
        if (tryMergeClaudeUserMessage(messages, nextMessage)) continue;
        messages.push(nextMessage);
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

    let currentAssistant = null;
    const callResultMap = new Map(); // call_id -> { output, parsedCmd, exitCode, cwd, command }
    const toolCallPartMap = new Map(); // call_id -> assistant content part
    const serializeAssistant = (assistant) => {
      if (!assistant || !Array.isArray(assistant.parts)) return '';
      return assistant.parts
        .map((part) => String(part && typeof part === 'object' ? part.content : part || '').trim())
        .filter(Boolean)
        .join('\n\n')
        .trim();
    };

    const flushAssistant = () => {
      if (!currentAssistant) return;
      const content = serializeAssistant(currentAssistant);
      if (content) {
        currentAssistant.messageIndex = messages.length;
        messages.push({
          role: 'assistant',
          content,
          timestamp: currentAssistant.timestamp
        });
      }
      currentAssistant = null;
    };

    const ensureAssistant = (timestamp) => {
      if (!currentAssistant) {
        currentAssistant = {
          parts: [],
          timestamp,
          messageIndex: null
        };
      }
      if (!currentAssistant.timestamp) currentAssistant.timestamp = timestamp;
      return currentAssistant;
    };

    const upsertUserMessage = (messageLike) => {
      const timestamp = String(messageLike && messageLike.timestamp || '').trim();
      const rawImages = mergeUniqueStrings([], messageLike && messageLike.images);
      const content = cleanCodexUserMessageContent(messageLike && messageLike.content, rawImages.length > 0);
      const messageKey = toCodexUserMessageKey(content);
      const images = mergeCodexUserImages([], rawImages);
      if (isSyntheticCodexUserContent(content)) return;
      if (!content && images.length === 0) return;

      const existingIndex = messages.findLastIndex((existing) => {
        if (!existing || existing.role !== 'user') return false;
        if (!areCloseTimestamps(existing.timestamp, timestamp)) return false;
        return toCodexUserMessageKey(existing.content) === messageKey;
      });

      if (existingIndex >= 0) {
        const existing = messages[existingIndex];
        const existingContent = String(existing && existing.content || '').trim();
        const nextContent = content.length > existingContent.length ? content : existingContent;
        messages[existingIndex] = {
          ...existing,
          content: nextContent,
          images: mergeCodexUserImages(existing && existing.images, images)
        };
        return;
      }

      messages.push({
        role: 'user',
        content,
        images,
        timestamp
      });
    };

    const appendAssistantContent = (text, timestamp) => {
      const cleanText = String(text || '').trim();
      if (!cleanText) return;
      ensureAssistant(timestamp).parts.push(cleanText);
    };

    const updateRenderedToolCall = (callId) => {
      const toolPart = toolCallPartMap.get(callId);
      if (!toolPart) return;
      const normalized = normalizeCodexFunctionCall(toolPart.payload, callResultMap);
      if (!normalized) return;
      toolPart.content = normalized.content;
      const owner = toolPart.owner;
      if (!owner || owner.messageIndex == null) return;
      const content = serializeAssistant(owner);
      if (!content || !messages[owner.messageIndex]) return;
      messages[owner.messageIndex] = {
        ...messages[owner.messageIndex],
        content
      };
    };

    const rememberFunctionCallOutput = (payload) => {
      if (!payload || !payload.call_id) return;
      const toolName = payload.name || payload.tool_name || '';
      let output = String(payload.output || '');
      if (toolName === 'exec_command' || toolName === 'shell') {
        output = cleanCodexExecCommandOutput(output);
      }
      if (!callResultMap.has(payload.call_id)) {
        callResultMap.set(payload.call_id, {
          output: trimToolResultOutput(output),
          parsedCmd: [],
          exitCode: null,
          cwd: '',
          command: []
        });
        updateRenderedToolCall(payload.call_id);
      }
    };

    const rememberExecCommandEnd = (payload) => {
      if (!payload || !payload.call_id) return;
      callResultMap.set(payload.call_id, buildCodexExecCommandResult(payload));
      updateRenderedToolCall(payload.call_id);
    };

    const appendAssistantToolCall = (payload, timestamp) => {
      const toolCall = normalizeCodexFunctionCall(payload, callResultMap);
      if (!toolCall) return;
      const owner = ensureAssistant(timestamp);
      const toolPart = {
        content: toolCall.content,
        payload,
        owner
      };
      owner.parts.push(toolPart);
      if (payload.call_id) {
        toolCallPartMap.set(payload.call_id, toolPart);
      }
    };

    forEachJsonlLineSync(sessionPath, (line) => {
      const record = safeParseJsonLine(line);
      if (!record) return;
      const payload = record.payload || {};

      if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        flushAssistant();
        upsertUserMessage({
          ...extractCodexUserResponseMessage(payload),
          timestamp: record.timestamp
        });
        return;
      }

      // 用户消息: event_msg + type=user_message
      if (record.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
        flushAssistant();
        upsertUserMessage({
          content: cleanCodexUserMessageContent(payload.message, mergeUniqueStrings(payload.images, payload.local_images).length > 0),
          images: mergeUniqueStrings(payload.images, payload.local_images).map(toRenderableCodexImageSource),
          timestamp: record.timestamp
        });
        return;
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
            appendAssistantContent(text, record.timestamp);
          }
        }
        return;
      }

      // function_call (exec_command 等) -> 渲染为 tool 块
      if (record.type === 'response_item' && payload.type === 'function_call') {
        appendAssistantToolCall(payload, record.timestamp);
        return;
      }

      if (record.type === 'event_msg' && payload.type === 'exec_command_end' && payload.call_id) {
        rememberExecCommandEnd(payload);
        return;
      }

      if (record.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id) {
        rememberFunctionCallOutput(payload);
      }
    });
    flushAssistant();
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
    return readGeminiSessionMessagesFromFile(sessionPath);
  } catch (error) {
    console.error('Failed to read Gemini session messages:', error);
  }

  return messages;
}

function readAgySessionMessages(sessionId) {
  const hostHome = getRealHome();
  try {
    const sessionPath = resolveAgySessionPath(sessionId, hostHome);
    if (!sessionPath) return [];
    return readAgySessionMessagesFromFile(sessionPath);
  } catch (error) {
    console.error('Failed to read AGY session messages:', error);
    return [];
  }
}

function normalizeOpenCodeMessageText(text, role) {
  let out = String(text || '').trim();
  if (role === 'user') out = out.replace(/^User:\s*/i, '').trim();
  if (role === 'assistant') out = out.replace(/^Assistant:\s*/i, '').trim();
  return out;
}

function readOpenCodeSessionMessages(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return [];
  let db = null;
  try {
    db = openOpenCodeDb(getRealHome(), { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    const rows = db.prepare(`
      SELECT
        message.id AS message_id,
        message.time_created AS message_time_created,
        message.data AS message_data,
        part.time_created AS part_time_created,
        part.data AS part_data
      FROM message
      LEFT JOIN part ON part.message_id = message.id
      WHERE message.session_id = ?
      ORDER BY message.time_created ASC, message.id ASC, part.time_created ASC, part.id ASC
    `).all(id);
    const byMessage = new Map();
    for (const row of rows) {
      const messageId = String(row && row.message_id || '').trim();
      if (!messageId) continue;
      if (!byMessage.has(messageId)) {
        const messageData = parseJsonSafe(row && row.message_data);
        byMessage.set(messageId, {
          data: messageData,
          timeCreated: Number(row && row.message_time_created) || 0,
          parts: []
        });
      }
      const partData = parseJsonSafe(row && row.part_data);
      if (partData) byMessage.get(messageId).parts.push(partData);
    }
    const messages = [];
    for (const message of byMessage.values()) {
      const role = String(message && message.data && message.data.role || '').trim();
      if (role !== 'user' && role !== 'assistant') continue;
      const content = message.parts
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (part.type === 'text') return String(part.text || '');
          if (part.type === 'reasoning') return `\n:::thinking\n${String(part.text || '').trim()}\n:::\n`;
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      const normalizedContent = normalizeOpenCodeMessageText(content, role);
      if (!normalizedContent) continue;
      messages.push({
        role,
        content: normalizedContent,
        timestamp: new Date(message.timeCreated || Date.now()).toISOString()
      });
    }
    return messages;
  } catch (_error) {
    return [];
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
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
  const cachedPath = getCachedCodexSessionPath(id);
  if (cachedPath) return cachedPath;

  const codexDir = path.join(hostHome, '.codex');
  const stateDbPath = resolveCodexSessionPathFromStateDb(codexDir, id);
  if (stateDbPath) return stateDbPath;

  if (!fs.existsSync(sessionsDir)) return '';

  const findFile = (dir) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = findFile(fullPath);
          if (result) return result;
        } else if (entry.name.includes(id) && entry.name.endsWith('.jsonl')) {
          cacheCodexSessionPath(id, fullPath);
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

  const readGeminiSessionId = (filePath) => {
    if (path.basename(filePath).includes(id)) return id;
    try {
      if (filePath.endsWith('.jsonl')) {
        const fd = fs.openSync(filePath, 'r');
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
          const firstLine = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/).find((line) => line.trim()) || '';
          const parsed = JSON.parse(firstLine);
          return String(parsed && parsed.sessionId || '').trim();
        } finally {
          fs.closeSync(fd);
        }
      }
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return String(data && data.sessionId || '').trim();
    } catch (_error) {
      return '';
    }
  };

  // 同一 sessionId 可能对应多个文件：gemini resume 走 --session-file 会 fork/重写，常留下
  // 时间戳名（session-<ms>-<short>）与日期名（session-<date>-<short>）两份，内容新旧不一。
  // 返回 mtime 最新的那个，确保读到最完整的会话（含本轮回复）。
  const findInChatsDir = (chatsDir) => {
    if (!fs.existsSync(chatsDir)) return '';
    let best = '';
    let bestMtime = -1;
    const consider = (fp) => {
      if (!fp) return;
      let m = 0;
      try { m = Number(fs.statSync(fp).mtimeMs) || 0; } catch (_error) {}
      if (m > bestMtime) { bestMtime = m; best = fp; }
    };
    for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
      const fp = path.join(chatsDir, entry.name);
      if (entry.isDirectory()) {
        consider(findInChatsDir(fp));
        continue;
      }
      if (!entry.name.endsWith('.json') && !entry.name.endsWith('.jsonl')) continue;
      if (readGeminiSessionId(fp) === id) consider(fp);
    }
    return best;
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

function resolveAgySessionPath(sessionId, hostHome = getRealHome()) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const roots = [
    path.join(hostHome, '.gemini', 'antigravity-cli', 'brain'),
    path.join(hostHome, '.gemini', 'antigravity', 'brain')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const directPath = path.join(root, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(directPath)) return directPath;
  }

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.includes(id)) continue;
        const candidate = path.join(root, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (_error) { /* ignore */ }
  }

  return '';
}

function resolveOpenCodeSessionPath(sessionId, hostHome = getRealHome()) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  const dbPath = getOpenCodeDbPath(hostHome);
  if (!dbPath || !fs.existsSync(dbPath)) return '';
  let db = null;
  try {
    db = openOpenCodeDb(hostHome, { readOnly: true });
    db.exec('PRAGMA query_only = ON;');
    const row = db.prepare('SELECT id FROM session WHERE id = ? LIMIT 1').get(id);
    return row && row.id ? dbPath : '';
  } catch (_error) {
    return '';
  } finally {
    if (db && typeof db.close === 'function') {
      try { db.close(); } catch (_closeError) {}
    }
  }
}

function getSessionFileCursor(provider, params = {}) {
  const filePath = resolveSessionFilePath(provider, params);
  if (!filePath || !fs.existsSync(filePath)) return 0;
  try {
    return Number(fs.statSync(filePath).size) || 0;
  } catch (_error) {
    return 0;
  }
}

function readCodexSessionEvents(sessionId, options = {}) {
  const hostHome = getRealHome();
  const sessionPath = resolveCodexSessionPath(sessionId, hostHome);
  const cursor = Math.max(0, Number(options.cursor) || 0);
  if (!sessionPath || !fs.existsSync(sessionPath)) {
    return { events: [], cursor: 0 };
  }

  const nextCursor = getSessionFileCursor('codex', { sessionId });
  if (cursor >= nextCursor) {
    return { events: [], cursor: nextCursor };
  }

  const events = [];
  const seenUserKeys = new Set();
  const seenReasoningKeys = new Set();
  let requiresSnapshot = false;
  let handledNoopEvent = false;
  const upsertUserEvent = (eventLike) => {
    const rawImages = mergeUniqueStrings([], eventLike && eventLike.images);
    const content = cleanCodexUserMessageContent(eventLike && eventLike.content, rawImages.length > 0);
    const timestamp = String(eventLike && eventLike.timestamp || '').trim();
    const messageKey = toCodexUserMessageKey(content);
    if (isSyntheticCodexUserContent(content)) {
      handledNoopEvent = true;
      return;
    }
    if (!content && rawImages.length === 0) return;

    const existingIndex = events.findLastIndex((existing) => {
      if (!existing || existing.type !== 'user_message') return false;
      if (!areCloseTimestamps(existing.timestamp, timestamp)) return false;
      return toCodexUserMessageKey(existing.content) === messageKey;
    });

    if (existingIndex >= 0) {
      const existing = events[existingIndex];
      events[existingIndex] = {
        ...existing,
        content: content.length > String(existing.content || '').length ? content : existing.content,
        images: mergeCodexUserImages(existing.images, rawImages)
      };
      return;
    }

    const dedupeKey = `${timestamp}::${messageKey}`;
    if (seenUserKeys.has(dedupeKey)) return;
    seenUserKeys.add(dedupeKey);
    events.push({
      type: 'user_message',
      timestamp,
      content,
      images: mergeCodexUserImages([], rawImages)
    });
  };

  forEachJsonlLineSyncFromOffset(sessionPath, cursor, (line) => {
    const record = safeParseJsonLine(line);
    if (!record) return;
    const payload = record.payload || {};

    if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const message = extractCodexUserResponseMessage(payload);
      if (!message.content && (!Array.isArray(message.images) || message.images.length === 0)) return;
      upsertUserEvent({
        timestamp: record.timestamp,
        content: message.content,
        images: message.images || []
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'user_message') {
      const images = mergeUniqueStrings(payload.images, payload.local_images).map(toRenderableCodexImageSource);
      upsertUserEvent({
        timestamp: record.timestamp,
        content: payload.message,
        images
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'turn_aborted') {
      handledNoopEvent = true;
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'agent_reasoning') {
      const text = extractCodexReasoningText(payload);
      const key = `${record.timestamp || ''}::${text}`;
      if (!text || seenReasoningKeys.has(key)) return;
      seenReasoningKeys.add(key);
      events.push({
        type: 'assistant_reasoning',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'reasoning') {
      const text = extractCodexReasoningText(payload);
      const key = `${record.timestamp || ''}::${text}`;
      if (!text || seenReasoningKeys.has(key)) return;
      seenReasoningKeys.add(key);
      events.push({
        type: 'assistant_reasoning',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.role === 'assistant') {
      const contentBlocks = Array.isArray(payload.content) ? payload.content : [];
      const text = contentBlocks
        .filter((item) => item && item.type === 'output_text' && item.text)
        .map((item) => String(item.text || ''))
        .join('\n')
        .trim();
      if (!text) return;
      events.push({
        type: 'assistant_text',
        timestamp: record.timestamp,
        text
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'function_call') {
      const normalized = normalizeCodexFunctionCall(payload, new Map());
      if (!normalized) return;
      events.push({
        type: 'assistant_tool_call',
        timestamp: record.timestamp,
        callId: payload.call_id,
        content: normalized.content
      });
      return;
    }

    if (record.type === 'event_msg' && payload.type === 'exec_command_end' && payload.call_id) {
      const resultInfo = buildCodexExecCommandResult(payload);
      const normalized = normalizeCodexFunctionCall({
        type: 'function_call',
        name: 'exec_command',
        call_id: payload.call_id,
        arguments: JSON.stringify({
          cmd: Array.isArray(payload.command) ? payload.command[payload.command.length - 1] || '' : '',
          workdir: payload.cwd || ''
        })
      }, new Map([[payload.call_id, resultInfo]]));
      if (!normalized) return;
      events.push({
        type: 'assistant_tool_result',
        timestamp: record.timestamp,
        callId: payload.call_id,
        content: normalized.content
      });
      return;
    }

    if (record.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id) {
      // 单独的 function_call_output 缺少足够的结构化上下文，直接增量拼接很容易破坏格式。
      // 遇到这种情况时让前端回退到 snapshot 重读，保证最终展示正确。
      requiresSnapshot = true;
    }
  });

  if (events.length === 0 && nextCursor > cursor && !handledNoopEvent) {
    requiresSnapshot = true;
  }

  return { events, cursor: nextCursor, requiresSnapshot };
}

function readSessionEvents(provider, params = {}, options = {}) {
  switch (provider) {
    case 'codex':
      return readCodexSessionEvents(params.sessionId, options);
    default:
      return {
        events: [],
        cursor: getSessionFileCursor(provider, params),
        requiresSnapshot: true
      };
  }
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
    case 'agy':
      return resolveAgySessionPath(sessionId);
    case 'opencode':
      return resolveOpenCodeSessionPath(sessionId);
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
    case 'agy':
      return readAgySessionMessages(sessionId);
    case 'opencode':
      return readOpenCodeSessionMessages(sessionId);
    default:
      return [];
  }
}

module.exports = {
  readAllProjectsFromHost,
  readProjectsFromHostByProviders,
  readCodexSessionProjectPath,
  readSessionMessages,
  readSessionEvents,
  resolveSessionFilePath,
  getSessionFileCursor,
  getRealHome,
  collectCodexWorkspaceRoots
};
