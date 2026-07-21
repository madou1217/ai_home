const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createInteractivePromptDetector,
  parseCodexPlanChoiceOptions,
  parseCodexPlanChoicePrompt
} = require('../lib/server/native-interactive-prompts');

test('codex plan choice options are parsed from active terminal prompt text', () => {
  const prompt = [
    'Implement this plan?',
    '1. Yes, implement this plan        Switch to Default and start coding.',
    '2. Yes, clear context and implement        Fresh thread. Context: 30% used.',
    '3. No, stay in Plan mode        Continue planning with the model.'
  ].join('\n');

  assert.deepEqual(parseCodexPlanChoiceOptions(prompt), [
    {
      value: '1',
      title: 'Yes, implement this plan',
      description: 'Switch to Default and start coding.'
    },
    {
      value: '2',
      title: 'Yes, clear context and implement',
      description: 'Fresh thread. Context: 30% used.'
    },
    {
      value: '3',
      title: 'No, stay in Plan mode',
      description: 'Continue planning with the model.'
    }
  ]);
});

test('codex plan choice prompt is not inferred from persisted proposed_plan artifacts', () => {
  const content = [
    '<proposed_plan>',
    '# Fix plan choice rendering',
    '',
    '- Move choices above the composer.',
    '- Keep numeric input out of visible chat history.',
    '</proposed_plan>'
  ].join('\n');

  assert.equal(parseCodexPlanChoicePrompt(content), null);
});

test('codex plan choice prompt requires real options from terminal output', () => {
  assert.equal(parseCodexPlanChoicePrompt('Implement this plan?'), null);
  assert.equal(parseCodexPlanChoicePrompt('Implement this plan?\n1. Yes'), null);
});

test('interactive prompt detector emits active prompt state once and clears it', () => {
  const detector = createInteractivePromptDetector('codex');
  const first = detector.appendOutput([
    'thinking...',
    'Implement this plan?',
    '1. Yes, implement this plan',
    '2. No, stay in Plan mode'
  ].join('\n'));

  assert.equal(first.type, 'interactive-prompt');
  assert.equal(first.prompt.kind, 'plan-choice');
  assert.equal(first.prompt.question, 'Implement this plan?');
  assert.deepEqual(first.prompt.options.map((item) => item.value), ['1', '2']);
  assert.equal(detector.appendOutput('\n'), null);

  const cleared = detector.clearActivePrompt('input-submitted');
  assert.equal(cleared.type, 'interactive-prompt-cleared');
  assert.equal(cleared.promptId, first.prompt.promptId);
  assert.equal(detector.getActivePrompt(), null);
});

test('interactive prompt detector ignores non-codex providers', () => {
  const detector = createInteractivePromptDetector('gemini');
  const event = detector.appendOutput('Implement this plan?\n1. Yes\n2. No');

  assert.equal(event, null);
  assert.equal(detector.getActivePrompt(), null);
});
