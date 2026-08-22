'use strict';

// Codex config.toml 自愈（codex 启动时自动执行，所有写操作先落备份、幂等）。
//
// 一、MCP 路径自愈：WSL 与 Windows 共用一份 config.toml 时，`/mnt/c/...`
// 与 `C:\...` 指向同一个文件但互不认路径（2026-08-22 blender MCP os error 3
// 事故）。策略：
// 1) 跨端路径可无损转换且目标存在 → 改写为当前平台路径（两端都受益）；
// 2) 绝对路径（含转换后）确实不存在 → 移除该 mcp_servers 条目（含子表），
//    避免 codex 启动被坏条目打断（如 codex_apps 被连累未初始化）；
// 3) 相对命令（uvx/npx 等走 PATH）、~ 路径、含环境变量的路径不强求——留给
//    运行时解析，原样保留。
//
// 二、projects 信任路径自愈：WSL 与 Windows 两边跑 codex 会给同一个项目
// 写下两种形态的 `[projects.*]` 信任条目（`/mnt/c/...` 与 `C:\...` 并存），
// 且测试/临时目录会留下死条目。策略（环境判定 = process.platform，win32 为
// Windows 原生、linux 下以 /mnt 挂载存在与否区分 WSL 与真实 Linux）：
// 1) 跨端条目与当前平台条目指向同一目录 → 保留本平台条目、删外来形态；
// 2) 无本平台条目但转换目标目录存在 → 改写为本平台路径；
// 3) 两种形态目录都不存在 → 删除死条目；
// 4) `\\?\` verbatim 前缀是 codex 自己的规范形态，不属跨端混杂，原样保留。

const WSL_MOUNT_PATH_PATTERN = /^\/mnt\/([a-z])\/(.*)$/i;
const WINDOWS_DRIVE_PATH_PATTERN = /^([a-z]):[\\/](.*)$/i;

function convertWslPathToWindows(value) {
  const match = String(value || '').match(WSL_MOUNT_PATH_PATTERN);
  if (!match) return '';
  const rest = match[2].replace(/\//g, '\\');
  return `${match[1].toUpperCase()}:\\${rest}`;
}

function convertWindowsPathToWsl(value) {
  const match = String(value || '').match(WINDOWS_DRIVE_PATH_PATTERN);
  if (!match) return '';
  const rest = match[2].replace(/\\/g, '/');
  return `/mnt/${match[1].toLowerCase()}/${rest}`;
}

function isAbsolutePathLike(value) {
  const text = String(value || '').trim();
  return text.startsWith('/') || WINDOWS_DRIVE_PATH_PATTERN.test(text);
}

function fileExists(fs, candidate) {
  try {
    return Boolean(fs.existsSync(candidate));
  } catch (_error) {
    return false;
  }
}

// resolveMcpCommandTarget 返回 'keep'（原样）/ 'convert'（可转换且目标存在）/
// 'remove'（绝对路径在两种形态下都不存在）。command 是 TOML 引号字面量原文。
function resolveMcpCommandTarget(commandRaw, options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || require('node:fs');
  const command = String(commandRaw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!command || !isAbsolutePathLike(command)) return { action: 'keep' };
  if (fileExists(fs, command)) return { action: 'keep' };

  const crossPlatformPath = platform === 'win32'
    ? convertWslPathToWindows(command)
    : convertWindowsPathToWsl(command);
  if (crossPlatformPath && fileExists(fs, crossPlatformPath)) {
    return { action: 'convert', command: crossPlatformPath };
  }
  // 反向形态也确认不存在（例如 Windows 上另一套 /mnt 盘符），才判定死亡。
  const mirrored = platform === 'win32'
    ? convertWindowsPathToWsl(command)
    : convertWslPathToWindows(command);
  if (mirrored && fileExists(fs, mirrored)) return { action: 'keep' };
  return { action: 'remove' };
}

// parseTomlCommandValue 解析 command 行的值：单引号是 TOML 字面量串（不转义，
// 真实 codex 配置多用此形态）；双引号是基本串，需反转义 \\ 与 \"。
function parseTomlCommandValue(line) {
  const match = String(line || '').match(/^command\s*=\s*(.+)$/);
  if (!match) return '';
  let value = match[1].trim();
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\(.)/g, (full, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
  }
  return value.replace(/^['"]|['"]$/g, '');
}

function tomlQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

// healCodexMcpServers 对 config.toml 文本做行级手术：只动 [mcp_servers.*]
// 段的 command 行。返回 { config, converted, removed }；config 未变化时原样返回。
function healCodexMcpServers(configText, options = {}) {
  const lines = String(configText || '').split(/\r?\n/);
  const converted = [];
  const removed = [];
  let changed = false;

  let index = 0;
  while (index < lines.length) {
    const sectionMatch = lines[index].match(/^\[mcp_servers\.([^\]\s.]+)(\.[^\]]*)?\]\s*$/);
    if (!sectionMatch) {
      index += 1;
      continue;
    }
    const serverName = sectionMatch[1];
    // 收集该 server 的完整段范围（主表 + mcp_servers.<name>.env 等子表）
    const sectionStart = index;
    let sectionEnd = index + 1;
    while (sectionEnd < lines.length && !/^\[/.test(lines[sectionEnd].trim())) {
      sectionEnd += 1;
    }
    if (sectionMatch[2]) {
      index = sectionEnd;
      continue;
    }

    const commandLineIndex = lines
      .slice(sectionStart, sectionEnd)
      .findIndex((line) => /^command\s*=/.test(line.trim()));
    if (commandLineIndex < 0) {
      index = sectionEnd;
      continue;
    }
    const absoluteCommandIndex = sectionStart + commandLineIndex;
    const commandRaw = parseTomlCommandValue(lines[absoluteCommandIndex]);
    const target = resolveMcpCommandTarget(commandRaw, options);

    if (target.action === 'convert') {
      lines[absoluteCommandIndex] = `command = ${tomlQuote(target.command)}`;
      converted.push({ name: serverName, from: commandRaw, to: target.command });
      changed = true;
      index = sectionEnd;
      continue;
    }

    if (target.action === 'remove') {
      // 连同该 server 的子表一起移除：从主表起点删到下一个非本 server 段之前
      let removeEnd = sectionEnd;
      while (removeEnd < lines.length) {
        const nextSection = lines[removeEnd].match(/^\[(mcp_servers\.[^\]\s.]+)(\.[^\]]*)?\]\s*$/);
        if (!nextSection || nextSection[1] !== `mcp_servers.${serverName}`) break;
        removeEnd += 1;
        while (removeEnd < lines.length && !/^\[/.test(lines[removeEnd].trim())) {
          removeEnd += 1;
        }
      }
      lines.splice(sectionStart, removeEnd - sectionStart);
      removed.push({ name: serverName, command: commandRaw });
      changed = true;
      index = sectionStart;
      continue;
    }

    index = sectionEnd;
  }

  return changed
    ? { config: lines.join('\n'), converted, removed }
    : { config: String(configText || ''), converted, removed };
}

// healCodexMcpServersConfigFile 读取-自愈-备份-写回。任何失败都不抛出，
// 由调用方记录；自愈永远不能阻断启动。
function healCodexMcpServersConfigFile(configPath, options = {}) {
  const fs = options.fs || require('node:fs');
  const platform = options.platform || process.platform;
  const log = typeof options.log === 'function' ? options.log : null;
  const result = { path: String(configPath || ''), changed: false, converted: [], removed: [], backupPath: '' };
  try {
    if (!configPath || !fs.existsSync(configPath)) return result;
    const original = fs.readFileSync(configPath, 'utf8');
    const healed = healCodexMcpServers(original, { platform, fs });
    if (!healed.converted.length && !healed.removed.length) return result;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${configPath}.aih-bak-${stamp}`;
    fs.writeFileSync(backupPath, original, 'utf8');
    fs.writeFileSync(configPath, healed.config, 'utf8');
    result.changed = true;
    result.converted = healed.converted;
    result.removed = healed.removed;
    result.backupPath = backupPath;
    healed.converted.forEach((item) => {
      if (log) log(`[codex-mcp-heal] ${item.name}: ${item.from} -> ${item.to}`);
    });
    healed.removed.forEach((item) => {
      if (log) log(`[codex-mcp-heal] ${item.name}: removed dead entry (${item.command})`);
    });
  } catch (error) {
    if (log) log(`[codex-mcp-heal] skipped: ${String((error && error.message) || error)}`);
  }
  return result;
}

// --- projects 信任路径自愈 ---

function parseTomlProjectsHeader(line) {
  const match = String(line || '').match(/^\[projects\.('([^']*)'|"((?:[^"\\]|\\.)*)"|([^\]\s.]+))\]\s*$/);
  if (!match) return null;
  if (match[2] !== undefined) return { key: match[2], quote: 'single' };
  if (match[3] !== undefined) {
    return {
      key: match[3].replace(/\\(.)/g, (full, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch)),
      quote: 'double'
    };
  }
  return { key: match[4], quote: 'bare' };
}

function buildTomlProjectsHeader(key) {
  return `[projects.'${String(key).replace(/'/g, "''")}']`;
}

function isVerbatimWindowsPath(value) {
  return /^\\\\\?\\[a-z]:/i.test(String(value || ''));
}

// normalizeProjectsKey 把路径归一为可比形态：去掉 \\?\ verbatim 前缀、统一
// 斜杠、大小写折叠（Windows 文件系统大小写不敏感）。
function normalizeProjectsKey(value) {
  return String(value || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

function directoryExists(fs, candidate) {
  try {
    return Boolean(candidate) && fs.existsSync(candidate);
  } catch (_error) {
    return false;
  }
}

// healCodexProjectsSection 清理 [projects.*] 的跨端混杂与死条目。
// 返回 { config, converted, removed }；config 未变化时原样返回。
function healCodexProjectsSection(configText, options = {}) {
  const platform = options.platform || process.platform;
  const fs = options.fs || require('node:fs');
  const lines = String(configText || '').split(/\r?\n/);

  // 先收集全部 projects key（用于跨端重复判定）
  const headers = [];
  lines.forEach((line, index) => {
    const parsed = parseTomlProjectsHeader(line.trim());
    if (parsed) headers.push({ index, ...parsed });
  });

  const decisions = new Map(); // header index -> { action, key? }
  const converted = [];
  const removed = [];

  for (const header of headers) {
    const key = header.key;
    const crossPlatformKey = platform === 'win32'
      ? convertWslPathToWindows(key)
      : convertWindowsPathToWsl(key);
    const foreignForm = platform === 'win32'
      ? WSL_MOUNT_PATH_PATTERN.test(key)
      : WINDOWS_DRIVE_PATH_PATTERN.test(key) && !isVerbatimWindowsPath(key);

    if (foreignForm && crossPlatformKey) {
      const normalizedCross = normalizeProjectsKey(crossPlatformKey);
      const hasNativeDuplicate = headers.some((other) => other !== header
        && !decisions.has(other.index)
        && normalizeProjectsKey(other.key) === normalizedCross
        && (platform === 'win32'
          ? !WSL_MOUNT_PATH_PATTERN.test(other.key)
          : !WINDOWS_DRIVE_PATH_PATTERN.test(other.key) || isVerbatimWindowsPath(other.key)));
      if (hasNativeDuplicate) {
        decisions.set(header.index, { action: 'remove', reason: 'duplicate-foreign' });
        removed.push({ path: key, reason: 'duplicate' });
        continue;
      }
      if (directoryExists(fs, crossPlatformKey)) {
        decisions.set(header.index, { action: 'convert', key: crossPlatformKey });
        converted.push({ from: key, to: crossPlatformKey });
        continue;
      }
      decisions.set(header.index, { action: 'remove', reason: 'dead' });
      removed.push({ path: key, reason: 'dead' });
      continue;
    }

    // 本平台形态：目录不存在（含 verbatim 形态）即死条目
    if (platform === 'win32' && (WINDOWS_DRIVE_PATH_PATTERN.test(key) || isVerbatimWindowsPath(key))) {
      const candidates = isVerbatimWindowsPath(key)
        ? [key, key.replace(/^\\\\\?\\/, '')]
        : [key];
      if (!candidates.some((candidate) => directoryExists(fs, candidate))) {
        decisions.set(header.index, { action: 'remove', reason: 'dead' });
        removed.push({ path: key, reason: 'dead' });
      }
      continue;
    }
    if (platform !== 'win32' && WSL_MOUNT_PATH_PATTERN.test(key)) {
      if (!directoryExists(fs, key)) {
        decisions.set(header.index, { action: 'remove', reason: 'dead' });
        removed.push({ path: key, reason: 'dead' });
      }
    }
  }

  if (!decisions.size) {
    return { config: String(configText || ''), converted, removed };
  }

  const output = [];
  let index = 0;
  while (index < lines.length) {
    const decision = decisions.get(index);
    if (decision && decision.action === 'remove') {
      index += 1;
      while (index < lines.length && !/^\[/.test(lines[index].trim())) index += 1;
      continue;
    }
    if (decision && decision.action === 'convert') {
      output.push(buildTomlProjectsHeader(decision.key));
      index += 1;
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }

  return { config: output.join('\n'), converted, removed };
}

// --- hooks.state 信任缓存自愈 ---
// codex 以 `<hooks.json 路径>:<event>:<i>:<j>` 为键记录 hook 信任哈希；
// WSL 侧 codex 经 /mnt 挂载共用同一份 config 时会写入 /mnt 形态的键，
// 在 Windows 原生侧是永远匹配不上的陈旧缓存（反之亦然）。清掉即可——
// 另一平台的 codex 下次需要时会重新求信任。

const HOOKS_STATE_KEY_PATTERN = /^(.+hooks\.json):[a-z_]+:\d+:\d+$/i;

function parseHooksStateHeader(line) {
  const match = String(line || '').trim()
    .match(/^\[hooks\.state\.('([^']*)'|"((?:[^"\\]|\\.)*)")\]\s*$/);
  if (!match) return null;
  if (match[2] !== undefined) return match[2];
  return match[3].replace(/\\(.)/g, (full, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch));
}

function healCodexHooksStateSection(configText, options = {}) {
  const platform = options.platform || process.platform;
  const lines = String(configText || '').split(/\r?\n/);
  const removed = [];
  const removeAt = new Set();

  lines.forEach((line, index) => {
    const key = parseHooksStateHeader(line);
    if (!key) return;
    const keyMatch = key.match(HOOKS_STATE_KEY_PATTERN);
    if (!keyMatch) return;
    const hooksPath = keyMatch[1];
    const foreign = platform === 'win32'
      ? WSL_MOUNT_PATH_PATTERN.test(hooksPath)
      : WINDOWS_DRIVE_PATH_PATTERN.test(hooksPath) && !isVerbatimWindowsPath(hooksPath);
    if (foreign) {
      removeAt.add(index);
      removed.push({ key, path: hooksPath });
    }
  });

  if (!removeAt.size) {
    return { config: String(configText || ''), removed };
  }

  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (removeAt.has(index)) {
      index += 1;
      while (index < lines.length && !/^\[/.test(lines[index].trim())) index += 1;
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return { config: output.join('\n'), removed };
}

// healCodexConfigFile 组合入口：一次读取，MCP / projects / hooks.state 自愈后
// 一次写回（一份备份）。任何失败都不抛出，绝不阻断启动。
function healCodexConfigFile(configPath, options = {}) {
  const fs = options.fs || require('node:fs');
  const platform = options.platform || process.platform;
  const log = typeof options.log === 'function' ? options.log : null;
  const result = {
    path: String(configPath || ''),
    changed: false,
    mcp: { converted: [], removed: [] },
    projects: { converted: [], removed: [] },
    hooksState: { removed: [] },
    backupPath: ''
  };
  try {
    if (!configPath || !fs.existsSync(configPath)) return result;
    const original = fs.readFileSync(configPath, 'utf8');
    const mcp = healCodexMcpServers(original, { platform, fs });
    const projects = healCodexProjectsSection(mcp.config, { platform, fs });
    const hooksState = healCodexHooksStateSection(projects.config, { platform, fs });
    if (!mcp.converted.length && !mcp.removed.length
      && !projects.converted.length && !projects.removed.length
      && !hooksState.removed.length) {
      return result;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${configPath}.aih-bak-${stamp}`;
    fs.writeFileSync(backupPath, original, 'utf8');
    fs.writeFileSync(configPath, hooksState.config, 'utf8');
    result.changed = true;
    result.mcp = { converted: mcp.converted, removed: mcp.removed };
    result.projects = { converted: projects.converted, removed: projects.removed };
    result.hooksState = { removed: hooksState.removed };
    result.backupPath = backupPath;
    mcp.converted.forEach((item) => log && log(`[codex-heal] mcp ${item.name}: ${item.from} -> ${item.to}`));
    mcp.removed.forEach((item) => log && log(`[codex-heal] mcp ${item.name}: removed dead entry (${item.command})`));
    projects.converted.forEach((item) => log && log(`[codex-heal] projects: ${item.from} -> ${item.to}`));
    projects.removed.forEach((item) => log && log(`[codex-heal] projects: removed ${item.reason} entry (${item.path})`));
    hooksState.removed.forEach((item) => log && log(`[codex-heal] hooks.state: removed foreign entry (${item.key})`));
  } catch (error) {
    if (log) log(`[codex-heal] skipped: ${String((error && error.message) || error)}`);
  }
  return result;
}

module.exports = {
  convertWslPathToWindows,
  convertWindowsPathToWsl,
  healCodexMcpServers,
  healCodexMcpServersConfigFile,
  healCodexProjectsSection,
  healCodexHooksStateSection,
  healCodexConfigFile,
  resolveMcpCommandTarget
};
