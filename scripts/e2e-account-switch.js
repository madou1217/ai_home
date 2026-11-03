'use strict';

// 真机 E2E：原生模式下「会话内换号」到底成不成立。
//
// 流程：真实 PTY 里跑 aih <provider> <from> → 完成一个极短回合（建立原生会话）
//      → 触发换号 → 断言四件事：
//        1. 换号动作发生（Auto-switch: from -> to）
//        2. 新账号续接同一段原生会话（resuming ... session <id>）
//        3. 标题里播报了「已自动换号」（OSC 0）
//        4. 换号后 TUI 里能看到上一回合的内容（会话真的续上了）
//
// 两种触发方式：
//   （默认）手动：往 PTY 里送 Ctrl-Alt-A，验证换号动作本身。
//   --auto   自动：用 AIH_RUNTIME_USAGE=auto_switch=1,auto_switch_remaining=100 打开
//            自动换号模式并把阈值调到「一有额度就换」，**不碰键盘**——验证的是
//            「模式开着时它自己会换」，而不是「按了快捷键能换」。
//
// 它会用**真实账号**跑一次极短回合（消耗一点额度）。所以必须显式 --yes。
//
// 用法：
//   node scripts/e2e-account-switch.js --provider codebuddy --from 1 --to 2 --yes
//   node scripts/e2e-account-switch.js --provider agy --from 1 --to 2 --auto --yes
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
const toId = readArg('to', '2');
const confirmed = process.argv.includes('--yes') || process.env.AIH_E2E_ACCOUNT_SWITCH === '1';
const autoMode = process.argv.includes('--auto');
// --remaining <pct>：把本会话的换号阈值钉到某个值（配合 --no-turn 就是「真实额度 +
// 阈值边界」的验证：不靠 100 这种恒真值，而是拿账号真实剩余去比）。
const remainingPct = readArg('remaining', '');
// --no-turn：不发送任何消息，只验证「启动后按额度自己换号」。
const noTurn = process.argv.includes('--no-turn');
// --expect no-switch：反向断言（阈值低于真实剩余时不许换）。
const expectNoSwitch = readArg('expect', 'switch') === 'no-switch';
const marker = readArg('marker', 'PINEAPPLE');
const prompt = readArg('prompt', '暗号是 ' + marker + '。只回复 ' + marker + ' 这个词，不要做别的事。');

if (!confirmed) {
  console.error('[e2e] 这会用真实账号跑一个极短回合（消耗少量额度）。确认后加 --yes。');
  process.exit(2);
}

const pty = require('node-pty');

// 固定工作目录：会话库里对应的项目名因此可预测，跑完能精确清掉自己造的那几段。
const WORK_DIR_NAME = 'aih-switch-e2e';
const workDir = path.join(os.tmpdir(), WORK_DIR_NAME);
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let out = '';
let exited = null;
let trustAnswered = false;

// 验证必须跑在**真实 HOME** 上：沙箱里的 HOME 可能是某个账号的投影目录，
// 那里没有用户真正的账号。os.userInfo() 读的是 passwd，不受 $HOME 影响。
const realHome = (() => {
  try { return os.userInfo().homedir; } catch (_error) { return os.homedir(); }
})();

const child = pty.spawn(process.execPath, [path.join(REPO, 'bin/ai-home.js'), provider, fromId], {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd: workDir,
  env: {
    ...process.env,
    HOME: realHome,
    TERM: 'xterm-256color',
    // 自动换号模式：会话内打开（不写用户配置）。阈值默认 100（恒真，用来验证链路）；
    // --remaining 给真实数值时验证的是「额度真的到线」。
    ...(autoMode
      ? { AIH_RUNTIME_USAGE: 'auto_switch=1' + (remainingPct ? `,auto_switch_remaining=${remainingPct}` : ',auto_switch_remaining=100') }
      : {})
  }
});

child.onData((data) => {
  out += data;
  // 新目录第一次进入会问「是否信任」：回车接受默认项。
  if (!trustAnswered && /Do you trust/i.test(out.slice(-4000))) {
    trustAnswered = true;
    child.write('\r');
  }
});
child.onExit(({ exitCode }) => { exited = exitCode; });

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(500);
  }
  console.error('[e2e] timeout waiting for ' + label);
  return false;
}

function lastTokens() {
  const matches = [...out.matchAll(/(\d[\d,]{0,6}) tokens/g)];
  if (matches.length === 0) return 0;
  return Number(matches[matches.length - 1][1].replace(/,/g, '')) || 0;
}

// 会话库里的测试会话：项目目录名由 cwd 派生（/tmp/x → private-tmp-x），只删
// 名字里带本次工作目录名的那几个目录——不会碰到用户自己的会话。
function cleanupSessionStore() {
  let hostHome = '';
  try { hostHome = os.userInfo().homedir; } catch (_error) { hostHome = os.homedir(); }
  // 四个 CodeBuddy 家族根都要清：国际站/国内站各一支 CLI 数据根 + 桌面端数据根。
  const roots = ['.codebuddy', '.codebuddy-cn', '.workbuddy', '.workbuddy-ai']
    .map((name) => path.join(hostHome, name, 'projects'));
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (_error) { continue; }
    for (const entry of entries) {
      if (!entry.includes(WORK_DIR_NAME)) continue;
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
}

// 只清理**这次**创建的持久会话（名字里带本次工作目录名）。
function cleanupPersistentSessions() {
  const socketDir = '/tmp/tmux-' + (typeof process.getuid === 'function' ? process.getuid() : '');
  let sockets = [];
  try { sockets = fs.readdirSync(socketDir).filter((name) => name.startsWith('aih-' + provider + '-')); } catch (_error) { return; }
  for (const socket of sockets) {
    const listed = spawnSync('tmux', ['-L', socket, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    if (!listed || listed.status !== 0) continue;
    for (const name of String(listed.stdout || '').split('\n')) {
      if (!name.includes(WORK_DIR_NAME)) continue;
      spawnSync('tmux', ['-L', socket, 'kill-session', '-t', name], { encoding: 'utf8' });
    }
  }
}

(async () => {
  try {
    await waitFor(() => out.length > 4000, 45000, 'tui boot');
    await sleep(3000);
    // 自动模式可能**在首轮之前**就换（账号本来就低于阈值——这正是产品要的行为），
    // 所以观察窗口从启动后立刻开始，而不是等这一轮结束。
    const beforeSwitch = out.length;
    let turnDone = null;
    let turnEndIndex = -1;
    if (!noTurn) {
      // 文本与回车必须分两次写：TUI 把「整段带换行的粘贴」当字面量，不会提交。
      child.write(prompt);
      await sleep(900);
      child.write('\r');
      turnDone = await waitFor(() => lastTokens() > 0, 120000, 'assistant turn');
      await sleep(2000);
      turnEndIndex = out.length;
    }
    if (autoMode) {
      if (expectNoSwitch) {
        // 反向用例：给足一个看门狗周期（启动 5s 首判 + 60s 节拍），确认它**不**换。
        await sleep(25000);
      } else {
        // 不碰键盘：等它自己换。上限 180s —— 用量快照 60s 一拍，过期会先补一次探测。
        const switched = await waitFor(
          () => /Auto-switch: \d+ -> \d+/.test(out.slice(beforeSwitch)),
          180000,
          'automatic account switch'
        );
        if (switched) await sleep(6000); // 等续接行 / 标题播报 / 会话回显落地
      }
    } else {
      child.write('\x1b\x01');
      await sleep(30000);
    }
    const switchMatch = /Auto-switch: \d+ -> \d+/.exec(out.slice(beforeSwitch));
    const switchIndex = switchMatch ? beforeSwitch + switchMatch.index : -1;
    const after = switchIndex >= 0 ? out.slice(switchIndex) : out.slice(beforeSwitch);
    // 换号发生在这一轮**之后**，「续接 / 会话回显」才有意义；发生在之前说明这段对话
    // 本来还没建立（账号在启动时就已低于阈值）。
    const switchAfterTurn = switchIndex >= 0 && turnEndIndex > 0 && switchIndex > turnEndIndex;
    // 实际换到的账号以日志行为准：自动模式选的是「剩余额度最多的可调度账号」，
    // 不一定是 --to 写的那个。
    const switchedIds = (after.match(/Auto-switch: (\d+) -> (\d+)/) || []);
    const report = {
      provider,
      mode: autoMode ? (noTurn ? 'auto-quota' : 'auto') : 'manual',
      remainingPct: remainingPct || (autoMode ? '100' : ''),
      expect: expectNoSwitch ? 'no-switch' : 'switch',
      from: switchedIds[1] || fromId,
      to: switchedIds[2] || toId,
      requestedTo: toId,
      turnDone,
      processAlive: exited === null,
      autoSwitch: /Auto-switch: \d+ -> \d+/.test(after),
      resumed: /resuming .* session .* on account/.test(after),
      titleNotice: /\x1b\]0;[^\x07]*已自动换号[^\x07]*\x07/.test(after),
      switchAfterTurn,
      // 换号之后屏幕上出现了上一段对话的内容（续接成功的直接证据）。没有先跑回合时
      // 它来自被续接的**旧**会话，所以单独记一个字段，不参与 switchAfterTurn 的判定。
      markerAfterSwitch: switchIndex >= 0 ? after.includes(marker) : false,
      transcriptRestored: switchAfterTurn ? after.includes(marker) : null,
      switchLine: (after.match(/Auto-switch: \d+ -> \d+/) || [''])[0],
      resumeLine: (after.match(/resuming [^\r\n]*/) || [''])[0],
      noticeLine: (after.match(/\x1b\]0;([^\x07]*已自动换号[^\x07]*)\x07/) || ['', ''])[1]
    };
    // --no-turn 时没有对话可续，「续接行 / 会话回显」这两项不适用；--expect no-switch
    // 时只要求「确实没换」且进程还活着。
    const ok = expectNoSwitch
      ? (!report.autoSwitch && report.processAlive)
      : report.autoSwitch && report.titleNotice && report.processAlive
        && (!report.switchAfterTurn || (report.resumed && report.transcriptRestored === true));
    console.log(JSON.stringify({ ok, ...report }, null, 2));
    try { child.write('/exit\r'); } catch (_error) {}
    await sleep(4000);
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('[e2e] failed: ' + (error && error.message));
    process.exitCode = 1;
  } finally {
    try { child.kill(); } catch (_error) {}
    cleanupPersistentSessions();
    cleanupSessionStore();
    fs.rmSync(workDir, { recursive: true, force: true });
    process.exit(process.exitCode || 0);
  }
})();
