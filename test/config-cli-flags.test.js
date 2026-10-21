'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildFieldCliEquivalents,
  candidateFlags,
  collectHelpFlags,
  readCliHelp,
  resetCliHelpCache
} = require('../lib/providers/config-cli-flags');

const CODEX_HELP = [
  'Usage: codex [OPTIONS] [PROMPT]',
  '',
  'Options:',
  '  -m, --model <MODEL>            Model to use',
  '  -s, --sandbox <MODE>           Sandbox policy',
  '  -a, --ask-for-approval <POLICY>  Approval policy',
  '      --full-auto                Low-friction sandboxed execution',
  '  -C, --cd <DIR>                 Working directory'
].join('\n');

test('collectHelpFlags only returns long flags that actually appear in help output', () => {
  const flags = collectHelpFlags(CODEX_HELP);
  assert.ok(flags.has('--model'));
  assert.ok(flags.has('--ask-for-approval'));
  assert.ok(flags.has('--full-auto'));
  assert.equal(flags.has('--not-a-real-flag'), false);
});

test('candidateFlags maps config keys to plausible CLI flags', () => {
  assert.deepEqual(candidateFlags('codex', 'model'), ['--model']);
  assert.deepEqual(candidateFlags('codex', 'sandbox_mode'), ['--sandbox']);
  assert.deepEqual(candidateFlags('codex', 'approval_policy'), ['--ask-for-approval']);
  assert.deepEqual(candidateFlags('claude', 'permissions.defaultMode'), ['--permission-mode']);
});

test('buildFieldCliEquivalents keeps only fields whose flag is verified by help', () => {
  const fields = [
    { path: 'model' },
    { path: 'sandbox_mode' },
    { path: 'approval_policy' },
    { path: 'model_providers.aih.name' }
  ];
  const equivalents = buildFieldCliEquivalents('codex', fields, CODEX_HELP, 'codex');
  assert.deepEqual(Object.keys(equivalents).sort(), ['approval_policy', 'model', 'sandbox_mode']);
  assert.deepEqual(equivalents.model, { flag: '--model', sample: 'codex --model <model>' });
  assert.deepEqual(equivalents.sandbox_mode, { flag: '--sandbox', sample: 'codex --sandbox <sandbox-mode>' });
  assert.deepEqual(equivalents.approval_policy, {
    flag: '--ask-for-approval',
    sample: 'codex --ask-for-approval <approval-policy>'
  });
});

test('buildFieldCliEquivalents never guesses a flag missing from help output', () => {
  const fields = [{ path: 'model' }, { path: 'sandbox_mode' }];
  const equivalents = buildFieldCliEquivalents('codex', fields, 'Usage: codex\n  --cd <DIR>', 'codex');
  assert.deepEqual(equivalents, {});
});

test('readCliHelp returns an empty result when the CLI is not installed', () => {
  resetCliHelpCache();
  const help = readCliHelp('codex', { resolveBinary: () => '' });
  assert.deepEqual(help, { text: '', command: '' });
});

test('readCliHelp derives the command name from the binary path and never exposes it', () => {
  resetCliHelpCache();
  const help = readCliHelp('qoder', {
    resolveBinary: () => '/opt/homebrew/bin/qodercli',
    spawnSync: () => ({ stdout: 'Usage: qodercli\n  --print\n', stderr: '' })
  });
  assert.equal(help.command, 'qodercli');
  assert.equal(help.text.includes('--print'), true);
  assert.equal(help.text.includes('/opt/homebrew/bin'), false);
});
