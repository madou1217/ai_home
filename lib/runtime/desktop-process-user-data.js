'use strict';

// macOS Electron relaunch 可能丢弃 argv，但会继承官方 user-data 环境变量。
// 只探测 manifest 声明的无参数 App 主进程，原始环境不进入返回值或日志。
function macDesktopExecutable(commandLine) {
  const text = String(commandLine || '').trim();
  const marker = '.app/Contents/MacOS/';
  const index = text.indexOf(marker);
  if (!text.startsWith('/') || index < 0) return '';
  const executableName = text.slice(index + marker.length);
  return /^[^\s/]+$/.test(executableName) ? text : '';
}

function readEnvironmentValue(environment, key) {
  const pattern = new RegExp(`(?:^|\\s)${key}=([\\s\\S]*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`, 'g');
  const matches = [...environment.matchAll(pattern)];
  return matches.length === 1 ? matches[0][1].trim() : '';
}

function readMacDesktopUserDataDirs(processes, rules, execFileSync) {
  const identities = new Map();
  if (typeof execFileSync !== 'function') return identities;
  const candidates = new Map();
  for (const proc of processes) {
    if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) continue;
    const executable = macDesktopExecutable(proc.commandLine);
    if (!executable) continue;
    const keys = new Set(rules.filter(rule => (
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(rule.envKey)
      && rule.pathIncludes.some(fragment => fragment && executable.includes(fragment))
    )).map(rule => rule.envKey));
    if (keys.size === 1) candidates.set(proc.pid, { executable, envKey: [...keys][0] });
  }
  if (candidates.size === 0) return identities;
  let output;
  try {
    output = execFileSync('ps', ['eww', '-p', [...candidates.keys()].join(','), '-o', 'pid=,command='], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024
    });
  } catch (_error) {
    return identities;
  }
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const candidate = candidates.get(pid);
    if (!candidate || !match[2].startsWith(`${candidate.executable} `)) continue;
    const environment = match[2].slice(candidate.executable.length + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(environment)) continue;
    const userDataDir = readEnvironmentValue(environment, candidate.envKey);
    if (userDataDir.startsWith('/')) identities.set(pid, userDataDir);
  }
  return identities;
}

module.exports = { readMacDesktopUserDataDirs };
