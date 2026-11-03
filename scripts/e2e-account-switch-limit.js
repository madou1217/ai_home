'use strict';

// 真机 E2E（合成输入）：429 + 恢复时刻 → **自动**换号。
//
// 为什么不用真上游：429 是额度窗口打满才出现的，没法按需制造。这里把 PATH 前面
// 放一个假的 `codebuddy`——它只做一件事：打印上游那句真实格式的 429（带恢复时刻），
// 然后待着不动。aih 的检测器认的就是这段文本，所以
//   PTY 输出 → 429 识别 → (账号,模型) 冷却 → 选目标（跳过冷却账号）→ switchToAccount
// 这条链路是端到端真跑的，只有「上游真的限流」这一段是合成的。
//
// 账号仍然是**真实账号**（凭据/投影都是真的），只是那个 CLI 不联网、不消耗额度。
// 依旧要求 --yes：它会动真实账号的投影目录与 tmux 会话。
//
// 用法：node scripts/e2e-account-switch-limit.js --provider codebuddy --from 1 --yes
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

function readArg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

const provider = readArg('provider', 'codebuddy');
const fromId = readArg('from', '1');
const confirmed = process.argv.includes('--yes') || process.env.AIH_E2E_ACCOUNT_SWITCH === '1';

if (!confirmed) {
  console.error('[e2e] 这会动真实账号的投影目录与 tmux 会话（不联网、不消耗额度）。确认后加 --yes。');
  process.exit(2);
}

const pty = require('node-pty');

const realHome = (() => {
  try { return os.userInfo().homedir; } catch (_error) { return os.homedir(); }
})();
const realAiHome = path.join(realHome, '.ai_home');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-limit-home-'));
// CLI 解析链的第一顺位是 <host home>/.local/bin（官方原生安装落点），比 PATH 和
// npm 全局 bin 都靠前。假 CLI 必须放在这里，否则会被用户真实的 codebuddy 顶掉。
const fakeBin = path.join(fakeHome, '.local', 'bin');
fs.mkdirSync(fakeBin, { recursive: true });
const fakeCli = path.join(fakeBin, 'codebuddy');

// 宿主 home 换成临时目录（这样 ~/.local/bin 里的真 CLI 不参与解析），但 provider
// 资源必须还在——启动前的 reconcile 会检查 projects / settings.json 等。用软链把
// 真实的数据根接过来：只读，且与正常启动时的行为一致。
for (const name of ['.codebuddy', '.codebuddy-cn', '.workbuddy', '.workbuddy-ai']) {
  const source = path.join(realHome, name);
  if (!fs.existsSync(source)) continue;
  try { fs.symlinkSync(source, path.join(fakeHome, name), 'dir'); } catch (_error) { /* 已存在/无权限 */ }
}

// 恢复时刻取 10 分钟后：超过「不足一分钟不值得换号」的门槛，又不会锁太久。
fs.writeFileSync(fakeCli, [
  '#!/bin/sh',
  "RESET=$(date -u -v+10M '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -u -d '+10 minutes' '+%Y-%m-%d %H:%M:%S')",
  "printf 'API Error: 429 usage exceeds frequency limit, please try again later. your usage will reset at %s UTC\\r\\n' \"$RESET\"",
  // 每 5 秒重放一次：真实 TUI 也会反复重绘错误帧；同时让「换号后新进程立刻打的
  // 那一句」即使落在 250ms 的换号窗口里被丢掉，也还有下一次机会。
  'while :; do',
  "  printf 'API Error: 429 usage exceeds frequency limit, please try again later. your usage will reset at %s UTC\\r\\n' \"$RESET\"",
  '  sleep 5',
  'done',
  ''
].join('\n'), { mode: 0o755 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let out = '';
let exited = null;

const child = pty.spawn(process.execPath, [path.join(REPO, 'bin/ai-home.js'), provider, fromId], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: fakeHome,
  env: {
    ...process.env,
    HOME: realHome,
    // 账号库仍是真实的；宿主 home 换成空的临时目录，让 ~/.local/bin 里的真 CLI
    // 不参与解析，PATH 上的假 CLI 才能被选中。
    AIH_HOME_DIR: realAiHome,
    AIH_HOST_HOME: fakeHome,
    PATH: fakeBin + path.delimiter + String(process.env.PATH || ''),
    // 自动换号按会话打开，不写用户配置。
    AIH_RUNTIME_USAGE: 'auto_switch=1',
    TERM: 'xterm-256color'
  }
});

child.onData((data) => { out += data; });
child.onExit(({ exitCode }) => { exited = exitCode; });

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(300);
  }
  console.error('[e2e] timeout waiting for ' + label);
  return false;
}

function cleanupPersistentSessions() {
  const socketDir = '/tmp/tmux-' + (typeof process.getuid === 'function' ? process.getuid() : '');
  let sockets = [];
  try { sockets = fs.readdirSync(socketDir).filter((name) => name.startsWith('aih-' + provider + '-')); } catch (_error) { return; }
  for (const socket of sockets) {
    const listed = spawnSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    if (!listed || listed.status !== 0) continue;
    for (const name of String(listed.stdout || '').split('\n')) {
      if (!name.includes(path.basename(fakeHome))) continue;
      spawnSync('tmux', ['-L', socket, 'kill-session', '-t', name], { encoding: 'utf8' });
    }
  }
}

(async () => {
  try {
    const firstSwitch = await waitFor(
      () => /Auto-switch: \d+ -> \d+/.test(out),
      90000,
      '429-triggered account switch'
    );
    const first = (out.match(/Auto-switch: (\d+) -> (\d+)/) || []);
    // 换号后的新进程会再打一次 429；第二次换号必须避开仍在冷却里的旧账号。
    const secondSwitch = await waitFor(
      () => (out.match(/Auto-switch: \d+ -> \d+/g) || []).length >= 2,
      60000,
      'second switch after cooldown'
    );
    const all = out.match(/Auto-switch: (\d+) -> (\d+)/g) || [];
    const targets = all.map((line) => (line.match(/-> (\d+)/) || [])[1]);
    const report = {
      provider,
      mode: '429-synthetic',
      from: first[1] || fromId,
      firstTarget: first[2] || '',
      firstSwitch,
      secondSwitch,
      switchCount: all.length,
      targets,
      coolingSkipped: all.length >= 2 ? targets[1] !== targets[0] : null,
      cooldownMentioned: /恢复/.test(out),
      titleNotice: /\x1b\]0;[^\x07]*已自动换号[^\x07]*\x07/.test(out),
      processAlive: exited === null
    };
    const ok = report.firstSwitch && report.titleNotice && report.processAlive
      && (report.switchCount < 2 || report.coolingSkipped === true);
    console.log(JSON.stringify({ ok, ...report }, null, 2));
    if (!ok) {
      // 只留人类可读的部分：标题帧（OSC）会把原始输出刷满。
      const plain = out.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x00/g, '');
      console.error('[e2e] --- last output ---\n' + plain.slice(-3000));
    }
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('[e2e] failed: ' + (error && error.message));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (_error) {}
    cleanupPersistentSessions();
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
