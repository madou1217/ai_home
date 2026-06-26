'use strict';

const crypto = require('node:crypto');

const ANSI_ESCAPE_PATTERN = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
const IMPLEMENT_PLAN_PROMPT_PATTERN = /\bImplement this plan\?/i;
const MAX_PROMPT_BUFFER_LENGTH = 16000;

function stripAnsi(value) {
  return String(value || '').replace(ANSI_ESCAPE_PATTERN, '');
}

function normalizeText(value) {
  return stripAnsi(value).replace(/\s+/g, ' ').trim();
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
    .replace(/^[\s›>]+/, '')
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

  const parsePrompt = () => {
    if (normalizedProvider !== 'codex') return null;
    return parseCodexPlanChoicePrompt(buffer);
  };

  return {
    appendOutput(text) {
      const clean = stripAnsi(String(text || ''));
      if (!clean) return null;
      buffer = `${buffer}${clean}`.slice(-MAX_PROMPT_BUFFER_LENGTH);

      const prompt = parsePrompt();
      if (!prompt) return null;

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
    },

    getActivePrompt() {
      return activePrompt;
    },

    clearActivePrompt(reason = 'cleared') {
      if (!activePrompt) return null;
      const promptId = activePrompt.promptId;
      activePrompt = null;
      activeFingerprint = '';
      buffer = '';
      return {
        type: 'interactive-prompt-cleared',
        promptId,
        reason
      };
    }
  };
}

module.exports = {
  createInteractivePromptDetector,
  parseCodexPlanChoiceOptions,
  parseCodexPlanChoicePrompt
};
