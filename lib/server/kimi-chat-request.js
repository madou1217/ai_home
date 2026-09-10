'use strict';

const { createModelsDevReader } = require('./models-dev-metadata');

// Kimi's native Chat contract uses thinking.effort and max_completion_tokens.
// Translate generic OpenAI options only at the provider boundary; native fields win.
function adaptKimiChatRequestBuffer(buffer) {
  let source;
  try { source = JSON.parse(Buffer.from(buffer).toString('utf8')); } catch { return buffer; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return buffer;
  const hasEffort = Object.hasOwn(source, 'reasoning_effort');
  const hasBudget = Object.hasOwn(source, 'max_tokens');
  const hasNativeBudget = Object.hasOwn(source, 'max_completion_tokens');
  const defaultBudget = !hasBudget && !hasNativeBudget
    ? createModelsDevReader().resolveEntry({ id: source.model, provider: 'kimi' })?.limits?.output : undefined;
  if (!hasEffort && !hasBudget && !defaultBudget) return buffer;
  const { reasoning_effort: effort, max_tokens: budget, ...result } = source;
  if (hasEffort && !Object.hasOwn(result, 'thinking') && typeof effort === 'string' && effort.trim()) {
    result.thinking = effort === 'none' || effort === 'off'
      ? { type: 'disabled' } : { type: 'enabled', effort };
  }
  if (hasBudget && !Object.hasOwn(result, 'max_completion_tokens')) result.max_completion_tokens = budget;
  if (defaultBudget) result.max_completion_tokens = defaultBudget;
  return Buffer.from(JSON.stringify(result));
}

module.exports = { adaptKimiChatRequestBuffer };
