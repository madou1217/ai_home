'use strict';

// 「用户真的提交了一条模型消息」的输入侧判定。
//
// 为什么需要：限流识别看的是终端输出，而 TUI 会把**历史对话**（resume 回放）、
// slash 命令输出和用户输入回显都画进同一条输出流。上游 429 与旧会话里 429 的
// 文本完全同形，文本层面无法区分来源。唯一可靠的边界在输入侧：上游 429 只可能
// 发生在「本次进程提交过一次模型请求」之后；resume 回放发生在提交之前。
//
// 判定规则：
//   - 回车/换行结束一行；
//   - 空行不算提交（TUI 的会话选择器用空回车确认）；
//   - 以 `/` 或 `!` 开头的行是 TUI 命令 / 本地 shell 命令，不是模型请求；
//     这类命令还可能触发整段会话回放（`/resume`），必须解除已武装状态；
//   - 括号粘贴（ESC[200~…ESC[201~）里的换行是内容，不是提交；
//   - CSI/SS3（方向键、Home/End 等）不进入行内容，否则空回车会被误判成有内容。
//
// 只做字节级扫描，不解码中文：判定只需要「是否为空」「首字符是不是 / 或 !」。

const MAX_LINE_BYTES = 16 * 1024;

const RESULT_NONE = '';
const RESULT_PROMPT = 'prompt';
const RESULT_COMMAND = 'command';
const RESULT_EMPTY = 'empty';

function toLatin1(data) {
  if (Buffer.isBuffer(data)) return data.toString('latin1');
  return Buffer.from(String(data == null ? '' : data), 'utf8').toString('latin1');
}

/**
 * @returns {{ observe: Function, reset: Function }}
 *
 * observe(data) → 'prompt' | 'command' | 'empty' | ''
 *   'prompt'  这一块输入里提交了一条模型消息
 *   'command' 这一块输入里提交了一条 TUI/本地命令
 *   'empty'   只有空回车（选会话、确认等）
 *   ''        没有行结束
 */
function createPromptSubmitGate() {
  let line = '';
  let pasting = false;
  // '' | 'esc' | 'csi' | 'ss3'。跨 chunk 的按键序列不能被当成行内容。
  let escape = '';
  let csi = '';

  function clearLine() {
    line = '';
  }

  function finalizeLine() {
    const text = line.trim();
    clearLine();
    if (!text) return RESULT_EMPTY;
    const first = text[0];
    if (first === '/' || first === '!') return RESULT_COMMAND;
    return RESULT_PROMPT;
  }

  function append(text) {
    if (!text) return;
    // 只需要判空与首字符；16KB 足够覆盖一次很长的粘贴，超出部分不影响结论。
    if (line.length >= MAX_LINE_BYTES) return;
    line += text;
  }

  function observe(data) {
    const text = toLatin1(data);
    if (!text) return RESULT_NONE;
    let result = RESULT_NONE;
    let sawLineEnd = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      const code = char.charCodeAt(0);

      // 按键序列优先处理：终端会把方向键/粘贴标记砍成多个 chunk 送进来。
      if (escape === 'esc') {
        if (char === '[') {
          escape = 'csi';
          csi = '';
          continue;
        }
        if (char === 'O') {
          escape = 'ss3';
          continue;
        }
        // 单独的 Esc / Alt+key：ESC 本身不是正文，但当前字符要按普通输入继续
        // 处理——否则「Esc 后紧跟的 /」会被吞掉，/resume 被误判成模型消息。
        escape = '';
      }
      if (escape === 'csi') {
        csi += char;
        if (csi.length > 64) csi = csi.slice(-64);
        if (code >= 0x40 && code <= 0x7e) {
          if (csi === '200~') pasting = true;
          else if (csi === '201~') pasting = false;
          escape = '';
          csi = '';
        }
        continue;
      }
      if (escape === 'ss3') {
        escape = '';
        continue;
      }
      if (code === 0x1b) {
        escape = 'esc';
        csi = '';
        continue;
      }

      if (pasting) {
        // 粘贴内容里的回车不是提交；标成内容即可（是否为 / 命令由首字符决定）。
        if (code === 0x0d || code === 0x0a) {
          append(' ');
          continue;
        }
        if (code >= 0x20 && code !== 0x7f) append(char);
        continue;
      }

      if (code === 0x03) {
        // Ctrl+C：取消当前输入，不构成提交。
        clearLine();
        continue;
      }
      if (code === 0x0d || code === 0x0a) {
        sawLineEnd = true;
        const outcome = finalizeLine();
        // 同一 chunk 里可能有多行：最后一次非空提交决定这一块的结论。
        if (outcome !== RESULT_EMPTY) result = outcome;
        continue;
      }
      if (code === 0x7f || code === 0x08) {
        // 退格：中文按字节退格只会多留半个字符，不影响「是否为空」的判断。
        if (line.length > 0) line = line.slice(0, -1);
        continue;
      }
      if (code >= 0x20 && code !== 0x7f) append(char);
    }
    return result !== RESULT_NONE ? result : (sawLineEnd ? RESULT_EMPTY : RESULT_NONE);
  }

  function reset() {
    line = '';
    pasting = false;
    escape = '';
    csi = '';
  }

  return { observe, reset };
}

module.exports = {
  MAX_LINE_BYTES,
  RESULT_COMMAND,
  RESULT_EMPTY,
  RESULT_NONE,
  RESULT_PROMPT,
  createPromptSubmitGate
};
