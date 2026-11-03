'use strict';

// 会话内手动换号：Ctrl-Alt-A。
//
// 与 shell drawer 的 Ctrl-Alt-J 同一套识别口径（见 shell-drawer.js）：传统终端把
// Ctrl+Option+A 编码成 ESC + 0x01；支持 CSI-u / modifyOtherKeys 的终端给的是带
// 修饰键的整段序列，三种形态都要认。
//
// 为什么 phase 1 需要它：自动换号的判定（剩余 0% / 429 冷却）还没做，没有手动
// 入口时 agy / codebuddy 这类 provider 在会话里根本无法触发换号。它同时也是
// 自动换号的上游动作——phase 2 只是换一个调用者。
const SWITCH_SEQUENCES = Object.freeze(new Set([
  '\x1b\x01', // ESC + Ctrl-A（macOS Terminal / iTerm2 的 Ctrl+Option+A）
  '\x1b[97;7u', // CSI-u: Ctrl+Alt+a
  '\x1b[65;7u', // CSI-u: Ctrl+Alt+A
  '\x1b[27;7;97~', // modifyOtherKeys: Ctrl+Alt+a
  '\x1b[27;7;65~' // modifyOtherKeys: Ctrl+Alt+A
]));

function isAccountSwitchSequence(data) {
  const text = String(data == null ? '' : data);
  return text ? SWITCH_SEQUENCES.has(text) : false;
}

module.exports = {
  SWITCH_SEQUENCES,
  isAccountSwitchSequence
};
