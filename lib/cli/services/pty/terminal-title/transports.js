'use strict';

// transport 工厂（终端轴）——「什么样的终端，用什么方式写标题」。
//
// 今天所有终端都用 OSC 0（`ESC ] 0 ; <text> BEL`），差异只在**能不能写**：
// tmux 的 pane 会截获 pane 内进程写的 OSC 0，所以 aih 必须从 tmux 客户端的
// **外层**写 stdout；非 TTY（管道、重定向、headless）写了没人看，必须让位。
//
// 于是这里按「写哪里」分三个 transport，门面按 `supports` 选第一个可用的：
//
//   osc0        stdout 是 TTY（含 tmux 外层）→ 直接写 OSC 0
//   windows     Windows Terminal 的进度条（OSC 9;4）也走 stdout，但只认 WT_SESSION
//   null        没有可用通道 → 什么都不写（不是错误，是不适用）
//
// 新增终端（例如某家要 OSC 1337 SetUserVar）时：加一个工厂 + 在 listTransports
// 里登记，门面与来源都不动。

const { buildTitleSequence } = require('./composer');
const { validateTitleTransport } = require('./transport-contract');

function readText(value) {
  return String(value == null ? '' : value).trim();
}

function isTty(stream) {
  return Boolean(stream && stream.isTTY === true && typeof stream.write === 'function');
}

// ── OSC 0：唯一通用的标题通道 ───────────────────────────────────────────────
// 通道约定：只设置窗口 / 图标标题，不触碰屏幕缓冲区、光标、滚动区或 SGR，
// 因此对全屏 TUI 安全。
function createOsc0Transport() {
  return validateTitleTransport({
    id: 'osc0',
    create({ processObj } = {}) {
      const proc = processObj || process;
      return {
        id: 'osc0',
        supports: () => isTty(proc.stdout) || isTty(proc.stdin),
        writeTitle(text) {
          const sequence = buildTitleSequence(text);
          if (!sequence) return false;
          try {
            proc.stdout.write(sequence);
            return true;
          } catch (_error) {
            return false;
          }
        },
        clearTitle() {
          try {
            if (isTty(proc.stdout)) proc.stdout.write('\x1b]0;\x07');
          } catch (_error) {}
        }
      };
    }
  });
}

// ── 空 transport：明确的「不适用」，不是静默失败 ─────────────────────────────
// headless / 管道 / 重定向场景走这里。它让门面能区分「终端不支持」与「忘了接线」：
// 前者 supports=false 且 isApplicable=false，后者会在装配期就报错。
function createNullTransport() {
  return validateTitleTransport({
    id: 'null',
    create() {
      return {
        id: 'null',
        supports: () => false,
        writeTitle: () => false,
        clearTitle: () => false
      };
    }
  });
}

// 有序链：第一个 supports() 为真的被采用。null 永远垫底。
function listTransports() {
  return [createOsc0Transport(), createNullTransport()];
}

function resolveTitleTransport(options = {}) {
  for (const factory of listTransports()) {
    const transport = factory.create(options);
    if (transport && typeof transport.supports === 'function' && transport.supports()) return transport;
  }
  return createNullTransport().create(options);
}

module.exports = {
  listTransports,
  resolveTitleTransport,
  createOsc0Transport,
  createNullTransport
};
