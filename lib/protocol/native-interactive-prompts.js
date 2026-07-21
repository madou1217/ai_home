'use strict';

const crypto = require('node:crypto');

const ANSI_ESCAPE_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const IMPLEMENT_PLAN_PROMPT_PATTERN = /\bImplement this plan\?/i;
const MAX_PROMPT_BUFFER_LENGTH = 16000;

// TUI 选择器的光标标记：claude=❯、codex=›/>、gemini/agy=●/▶。
// 通用编号选择必须至少有一行带光标，用于和「模型回答里的 markdown 编号列表」区分开
// （后者同样是 问题行+1./2. 结构，但永远不会带选择光标）。
const CHOICE_CURSOR_LINE_PATTERN = /^\s*[❯›>●▶•]\s*[1-9]\d*[.)]\s/;
// y/n 确认：行尾 (y/n) / [Y/n] / (yes/no) 等。
const CONFIRM_TAIL_PATTERN = /[([]\s*y(?:es)?\s*\/\s*no?\s*[)\]]\s*[:：?？]?\s*$/i;
// 按回车继续类。
const ACKNOWLEDGE_LINE_PATTERN = /(?:press\s+(?:enter|return)\b.*(?:continue|proceed|retry|confirm))|(?:按\s*(?:回车|enter)\s*(?:键)?\s*(?:继续|确认|重试))/i;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_ESCAPE_PATTERN, '');
}

function normalizeText(value) {
  return stripAnsi(value).replace(/\s+/g, ' ').trim();
}

// 纯装饰行：框线/分隔符/空输入框等，去掉字母数字后没有实际内容。
function isDecorativeLine(text) {
  return !/[\p{L}\p{N}]/u.test(String(text || ''));
}

// 操作提示行：不属于选项内容，允许出现在选项块尾部。
function isHintLine(text) {
  const clean = String(text || '');
  return /^(?:press\s+(?:enter|return)\b|esc\b|use\s+arrow|worked\s+for\b|tab\b|↑|↓|enter\s+to\b|space\s+to\b|ctrl\+)/i.test(clean)
    || /(?:to\s+cancel|to\s+select|to\s+confirm|to\s+navigate|to\s+exit)\s*\.?$/i.test(clean);
}

function findLastSignificantLine(content) {
  const lines = stripAnsi(String(content || '')).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const clean = normalizeText(lines[index]);
    if (!clean || isDecorativeLine(clean)) continue;
    return clean;
  }
  return '';
}

function findLatestImplementPlanPrompt(text) {
  const pattern = new RegExp(IMPLEMENT_PLAN_PROMPT_PATTERN.source, 'ig');
  let latestPrompt = null;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    latestPrompt = {
      question: normalizeText(match[0]),
      end: match.index + match[0].length
    };
  }
  return latestPrompt;
}

function parseChoiceLine(line) {
  const clean = stripAnsi(line)
    .replace(/^[\s›>❯●▶•]+/, '')
    .trim();
  const match = clean.match(/^([1-9]\d*)[.)]\s+(.+)$/);
  if (!match) return null;

  const copyParts = match[2]
    .split(/\s{2,}/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  if (copyParts.length === 0) return null;

  return {
    value: match[1],
    title: copyParts[0],
    description: copyParts.slice(1).join(' ') || undefined
  };
}

function appendChoiceDescription(option, line) {
  const description = normalizeText(line);
  if (!description) return option;
  return {
    ...option,
    description: [option.description, description].filter(Boolean).join(' ')
  };
}

function parseCodexPlanChoiceOptions(content) {
  const text = stripAnsi(String(content || ''));
  const prompt = findLatestImplementPlanPrompt(text);
  if (!prompt) return [];

  const options = [];
  let blankAfterOptions = false;
  const lines = text.slice(prompt.end).split('\n');
  for (const line of lines) {
    const option = parseChoiceLine(line);
    if (option) {
      options.push(option);
      blankAfterOptions = false;
      continue;
    }

    if (options.length === 0) continue;

    const clean = normalizeText(line);
    if (!clean) {
      blankAfterOptions = true;
      continue;
    }
    if (blankAfterOptions || /^Press\s+enter\b/i.test(clean) || /^Worked\s+for\b/i.test(clean)) {
      continue;
    }
    if (/^[A-Z][A-Za-z ]+:\s*$/.test(clean)) break;

    const lastIndex = options.length - 1;
    options[lastIndex] = appendChoiceDescription(options[lastIndex], clean);
  }

  return options;
}

function parseCodexPlanChoicePrompt(content) {
  const prompt = findLatestImplementPlanPrompt(stripAnsi(String(content || '')));
  if (!prompt) return null;
  const options = parseCodexPlanChoiceOptions(content);
  if (options.length < 2) return null;
  return {
    kind: 'plan-choice',
    question: prompt.question,
    options
  };
}

// 通用编号选择检测（claude 权限/信任弹窗、codex TUI 审批、agy/gemini 对话框等）：
//   问题行（以 ?/？ 结尾）+ ≥2 个编号选项 + 至少一行带选择光标（❯/›/>/●）。
// 光标要求是防误报的关键：模型回答里的「问题 + markdown 编号列表」不会带光标。
function parseNumberedChoicePrompt(content, promptOptions = {}) {
  const text = stripAnsi(String(content || ''));
  const lines = text.split('\n');

  let questionIndex = -1;
  let question = '';
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const clean = normalizeText(lines[index]);
    if (!clean || isDecorativeLine(clean)) continue;
    if (parseChoiceLine(lines[index])) continue;
    if (/[?？]$/.test(clean)) {
      questionIndex = index;
      question = clean;
      break;
    }
  }
  if (questionIndex < 0) return null;

  const options = [];
  let hasCursorOption = false;
  for (let index = questionIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const option = parseChoiceLine(rawLine);
    if (option) {
      options.push(option);
      if (CHOICE_CURSOR_LINE_PATTERN.test(stripAnsi(rawLine))) hasCursorOption = true;
      continue;
    }

    const clean = normalizeText(rawLine);
    if (!clean || isDecorativeLine(clean) || isHintLine(clean)) continue;
    if (options.length === 0) {
      // 问题行与首个选项之间出现实际内容 → 不是活跃选择器。
      return null;
    }
    // 选项换行 wrap：并入上一个选项的描述。
    options[options.length - 1] = appendChoiceDescription(options[options.length - 1], clean);
  }

  if (options.length < 2 || !hasCursorOption) return null;
  return {
    kind: 'choice',
    question,
    options,
    submit: promptOptions.submit === 'raw' ? 'raw' : 'enter'
  };
}

function parseTitledNumberedChoicePrompt(content, promptOptions = {}) {
  const text = stripAnsi(String(content || ''));
  const lines = text.split('\n');
  const optionBlocks = collectAdjacentOptionBlocks(lines);
  const activeBlock = optionBlocks.findLast((block) => (
    block.options.length >= 2 && block.hasCursorOption
  ));
  if (!activeBlock) return null;

  const firstOptionIndex = activeBlock.options[0].index;
  let question = '';
  for (let index = firstOptionIndex - 1; index >= 0; index -= 1) {
    const clean = normalizeText(lines[index]);
    if (!clean || isDecorativeLine(clean) || isHintLine(clean)) continue;
    question = clean;
    break;
  }
  if (!question) return null;

  return {
    kind: 'choice',
    question,
    options: activeBlock.options.map(({ option }) => option),
    submit: promptOptions.submit === 'raw' ? 'raw' : 'enter'
  };
}

function collectAdjacentOptionBlocks(lines) {
  const blocks = [];
  let current = null;
  let previousOptionIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const option = parseChoiceLine(lines[index]);
    if (!option) continue;

    const gap = previousOptionIndex < 0 ? [] : lines.slice(previousOptionIndex + 1, index);
    const beginsNewBlock = current && gap.some((line) => {
      const clean = normalizeText(line);
      return clean && !isDecorativeLine(clean) && !/^\s/.test(stripAnsi(line));
    });
    if (!current || beginsNewBlock) {
      current = { options: [], hasCursorOption: false };
      blocks.push(current);
    }
    current.options.push({ index, option });
    if (CHOICE_CURSOR_LINE_PATTERN.test(stripAnsi(lines[index]))) {
      current.hasCursorOption = true;
    }
    previousOptionIndex = index;
  }
  return blocks;
}

// y/n 确认：输出尾部（忽略装饰行）以 (y/n)/[Y/n]/(yes/no) 收尾。
function parseConfirmPrompt(content) {
  const lastLine = findLastSignificantLine(content);
  if (!lastLine || !CONFIRM_TAIL_PATTERN.test(lastLine)) return null;
  return {
    kind: 'confirm',
    question: lastLine,
    submit: 'enter',
    options: [
      { value: 'y', title: '是 (yes)', send: 'y' },
      { value: 'n', title: '否 (no)', send: 'n' }
    ]
  };
}

// Press Enter to continue / 按回车继续。
function parseAcknowledgePrompt(content) {
  const lastLine = findLastSignificantLine(content);
  if (!lastLine || !ACKNOWLEDGE_LINE_PATTERN.test(lastLine)) return null;
  return {
    kind: 'acknowledge',
    question: lastLine,
    // 只回车、不追加换行（send 本身就是 \r）。
    submit: 'raw',
    options: [
      { value: 'enter', title: '按回车继续', send: '\r' }
    ]
  };
}

function createPromptId(provider, prompt) {
  const fingerprint = JSON.stringify({
    provider,
    kind: prompt.kind,
    question: prompt.question,
    options: prompt.options
  });
  return `${provider}-${prompt.kind}-${crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 16)}`;
}

function createInteractivePromptDetector(provider) {
  const normalizedProvider = normalizeText(provider).toLowerCase();
  let buffer = '';
  let activePrompt = null;
  let activeFingerprint = '';
  let missingPromptFrames = 0;

  const parsePrompt = () => {
    // codex 专属的 Implement this plan? 优先（保持既有行为与 promptId 稳定）。
    if (normalizedProvider === 'codex') {
      const planPrompt = parseCodexPlanChoicePrompt(buffer);
      if (planPrompt) return planPrompt;
    }
    // claude 的 TUI 选择器按数字键即选（无需回车）；其余 provider 数字 + 回车确认。
    return parseNumberedChoicePrompt(buffer, {
      submit: normalizedProvider === 'claude' ? 'raw' : 'enter'
    })
      || (normalizedProvider === 'codex'
        ? parseTitledNumberedChoicePrompt(buffer, { submit: 'enter' })
        : null)
      || parseConfirmPrompt(buffer)
      || parseAcknowledgePrompt(buffer);
  };

  const detect = (prompt = parsePrompt()) => {
    if (!prompt) return null;
    missingPromptFrames = 0;

    const promptId = createPromptId(normalizedProvider, prompt);
    const fingerprint = JSON.stringify({ promptId, options: prompt.options });
    if (activeFingerprint === fingerprint) return null;

    activeFingerprint = fingerprint;
    activePrompt = {
      ...prompt,
      provider: normalizedProvider,
      promptId
    };
    return {
      type: 'interactive-prompt',
      prompt: activePrompt
    };
  };

  const clearActivePrompt = (reason = 'cleared') => {
    if (!activePrompt) return null;
    const promptId = activePrompt.promptId;
    activePrompt = null;
    activeFingerprint = '';
    missingPromptFrames = 0;
    buffer = '';
    return {
      type: 'interactive-prompt-cleared',
      promptId,
      reason
    };
  };

  return {
    appendOutput(text) {
      const clean = stripAnsi(String(text || ''));
      if (!clean) return null;
      buffer = `${buffer}${clean}`.slice(-MAX_PROMPT_BUFFER_LENGTH);
      return detect();
    },

    replaceOutput(text, options = {}) {
      buffer = stripAnsi(String(text || '')).slice(-MAX_PROMPT_BUFFER_LENGTH);
      const prompt = parsePrompt();
      if (prompt) return detect(prompt);
      if (!activePrompt || options.clearWhenMissing !== true) {
        missingPromptFrames = 0;
        return null;
      }
      missingPromptFrames += 1;
      return missingPromptFrames >= 2
        ? clearActivePrompt('prompt-missing')
        : null;
    },

    getActivePrompt() {
      return activePrompt;
    },

    clearActivePrompt(reason = 'cleared') {
      return clearActivePrompt(reason);
    }
  };
}

module.exports = {
  createInteractivePromptDetector,
  parseCodexPlanChoiceOptions,
  parseCodexPlanChoicePrompt,
  parseNumberedChoicePrompt,
  parseTitledNumberedChoicePrompt,
  parseConfirmPrompt,
  parseAcknowledgePrompt
};
