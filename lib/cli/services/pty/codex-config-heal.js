'use strict';

// Codex MCP 配置自愈：WSL 与 Windows 共用一份 config.toml 时，`/mnt/c/...`
// 与 `C:\...` 指向同一个文件但互不认路径（2026-08-22 blender MCP os error 3
// 事故：WSL 下配置的 /mnt/c 路径在 Windows 原生 codex 里找不到）。策略：
// 1) 跨端路径可无损转换且目标存在 → 启动时改写为当前平台路径（两端都受益）；
// 2) 绝对路径（含转换后）确实不存在 → 移除该 mcp_servers 条目（含子表），
//    避免 codex 启动被坏条目打断（如 codex_apps 被连累未初始化）；
// 3) 相对命令（uvx/npx 等走 PATH）、~ 路径、含环境变量的路径不强求——留给
//    运行时解析，原样保留。
// 所有写操作先落备份，幂等可重入。

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

module.exports = {
  convertWslPathToWindows,
  convertWindowsPathToWsl,
  healCodexMcpServers,
  healCodexMcpServersConfigFile,
  resolveMcpCommandTarget
};
