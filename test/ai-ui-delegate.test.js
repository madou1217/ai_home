const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudePrompt,
  buildRuns,
  extractJson,
  parseArgs,
  stripAnsi
} = require('../scripts/ai-ui-delegate');

test('parseArgs defaults to claude delegate without context beta', () => {
  const options = parseArgs([]);

  assert.equal(options.provider, 'claude');
  assert.equal(options.claudeModel, 'claude-opus-4.6-thinking');
  assert.equal(options.agyAccount, '1');
  assert.equal(options.agyPrintTimeout, '3m');
});

test('buildRuns creates direct aih claude command without 1m beta', () => {
  const runs = buildRuns(parseArgs(['--provider', 'claude', '--scope', 'Accounts']));

  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, 'aih');
  assert.deepEqual(runs[0].args.slice(0, 3), ['claude', '-p', runs[0].args[2]]);
  assert.equal(runs[0].args.includes('--betas'), false);
  assert.equal(runs[0].args.includes('context-1m-2025-08-07'), false);
});

test('buildClaudePrompt includes frontend framework and component specification constraints', () => {
  const prompt = buildClaudePrompt('DesignSystem');

  assert.equal(prompt.includes('Tailwind CSS v4'), true);
  assert.equal(prompt.includes('animate.css'), true);
  assert.equal(prompt.includes('按钮、输入框、选择器'), true);
  assert.equal(prompt.includes('配色方案'), true);
});

test('buildRuns creates agy account print command', () => {
  const runs = buildRuns(parseArgs(['--provider', 'agy', '--agy-account', '6']));

  assert.deepEqual(runs[0].args.slice(0, 4), ['agy', '6', '-p', runs[0].args[3]]);
  assert.deepEqual(runs[0].args.slice(4), ['--print-timeout', '3m']);
});

test('buildRuns can keep agy conversation context with continue flag', () => {
  const runs = buildRuns(parseArgs(['--provider', 'agy', '--agy-account', '1', '--agy-continue']));

  assert.deepEqual(runs[0].args.slice(0, 5), ['agy', '1', '--continue', '-p', runs[0].args[4]]);
  assert.deepEqual(runs[0].args.slice(5), ['--print-timeout', '3m']);
});

test('buildRuns can resume a specific agy conversation id', () => {
  const runs = buildRuns(parseArgs([
    '--provider',
    'agy',
    '--agy-account',
    '1',
    '--agy-conversation',
    'conv-1',
    '--agy-print-timeout',
    '45s'
  ]));

  assert.deepEqual(runs[0].args.slice(0, 6), ['agy', '1', '--conversation', 'conv-1', '-p', runs[0].args[5]]);
  assert.deepEqual(runs[0].args.slice(6), ['--print-timeout', '45s']);
});

test('extractJson strips aih terminal noise and parses JSON object', () => {
  const parsed = extractJson('\u001b[36m[aih]\u001b[0m Waiting\n{"ok":true,"items":[1]}\u001b[?25h');

  assert.deepEqual(parsed, { ok: true, items: [1] });
});

test('stripAnsi removes common escape sequences', () => {
  assert.equal(stripAnsi('\u001b[36mblue\u001b[0m'), 'blue');
});
