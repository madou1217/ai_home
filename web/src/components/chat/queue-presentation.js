export function getQueueModeLabel(mode, index) {
  if (mode === 'after_tool_call') {
    return index === 0 ? '工具后' : `工具后 ${index + 1}`;
  }
  return index === 0 ? '下一条' : `排队 ${index + 1}`;
}

export function getQueueModeDescription(mode) {
  if (mode === 'after_tool_call') {
    return '这条需求不会打断当前工作。对于 Codex，会在下一次工具调用边界后尽快注入；如果没遇到工具边界，则会在本轮结束后继续发送。';
  }
  return '这条需求不会打断当前工作，会在当前这一轮完成后自动发送。想立即介入，请先停止当前会话。';
}

export function getQueuePrimaryActionLabel(isRunning, index) {
  if (!isRunning) return '立即发送';
  return index === 0 ? '立即介入' : '提到最前';
}

export function getQueuePrimaryActionTitle(isRunning, index) {
  if (!isRunning) return '立即发送';
  return index === 0 ? '停止当前并立即介入' : '将这条需求提到队首并停止当前轮';
}
