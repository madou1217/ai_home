'use strict';
// Actual native CLI + isolated homes + deterministic local inference fixture.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSkillManager } = require('../lib/native-resources/skill-manager');
const { createPromptFixture, MARKER } = require('../examples/skills/prompt-fixture');
const SOURCE = path.resolve(__dirname, '../assets/provider-skills/aih-demo');
const ANSWERS = {
  claude: (event) => event.type === 'result' ? event.result : null,
  codex: (event) => event.type === 'item.completed' && event.item?.type === 'agent_message' ? event.item.text : null,
  opencode: (event) => event.type === 'text' ? event.part?.text : null
};
function finalAnswer(output, provider) {
  return output.split('\n').flatMap((line) => {
    try { const answer = ANSWERS[provider](JSON.parse(line)); return typeof answer === 'string' ? [answer] : []; } catch (_) { return []; }
  }).join('').trim();
}
const HOSTS = {
  claude({ host, url, prompt = '/aih-demo' }) {
    return { env: { CLAUDE_CONFIG_DIR: path.join(host, '.claude'), ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_BASE_URL: url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
      args: ['-p', prompt, '--model', 'claude-sonnet-4-5', '--output-format', 'json', '--no-session-persistence'] };
  },
  codex({ host, url, prompt = 'Use the $aih-demo skill. Reply only as instructed by that skill.' }) {
    const config = path.join(host, '.codex');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'config.toml'), `model = "fixture-model"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Local skill fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`);
    return { env: { CODEX_HOME: config }, args: ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--json', prompt] };
  },
  opencode({ host, url }) {
    const config = path.join(host, '.config', 'opencode');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'fixture/demo', provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Local skill fixture', options: { baseURL: `${url}/v1`, apiKey: 'fixture-key' }, models: { demo: { name: 'Skill demo' } } } } }));
    return { env: { XDG_CONFIG_HOME: path.join(host, '.config'), XDG_DATA_HOME: path.join(host, '.local/share'), XDG_CACHE_HOME: path.join(host, '.cache') }, args: ['run', '--format', 'json', '--model', 'fixture/demo', 'Run the aih-demo skill. Reply only as instructed by that skill.'] };
  }
};
function run(binary, args, options) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '';
    let timedOut = false;
    let stoppedEarly = false;
    let stopTimer = null;
    let settled = false;
    const terminateChild = (signal = 'SIGTERM') => {
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, signal);
      } catch (_) {
        try { child.kill(); } catch (_error) {}
      }
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer && !stoppedEarly) clearTimeout(stopTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }, 45000);
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-256000);
      if (!stoppedEarly && typeof options.stopWhen === 'function' && options.stopWhen(output)) {
        stoppedEarly = true;
        // The result event is already complete in this chunk. Terminate the
        // supervised process group before resolving so a native worker that
        // remains alive after a completed request cannot keep the probe (or an
        // aggregate closure run) open indefinitely.
        terminateChild();
        // The result event itself is the evidence boundary. Do not wait for a
        // host worker that intentionally remains alive after the result.
        finish({ exitCode: 0, timedOut: false, output, stoppedEarly });
      }
    });
    child.stderr.resume();
    child.on('error', (error) => { finish({ exitCode: stoppedEarly ? 0 : null, error: error.code, marker: false, stoppedEarly }); });
    child.on('close', (exitCode) => {
      finish({ exitCode: stoppedEarly ? 0 : exitCode, timedOut, output, stoppedEarly });
    });
  });
}
async function runSkillNativeDemo({ provider, binary = provider }) {
  const adapter = HOSTS[provider];
  if (!adapter) throw new Error('demo_provider_unsupported');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-skill-native-'));
  const host = path.join(root, 'host');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const fixture = await createPromptFixture();
  try {
    const manager = createSkillManager({ aiHomeDir: path.join(root, 'aih'), hostHomeDir: host });
    const launch = adapter({ host, url: fixture.url });
    const env = { PATH: process.env.PATH, HOME: host, USERPROFILE: host, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...launch.env };
    manager.install(SOURCE, { provider });
    const stages = [];
    for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
      if (stage === 'disabled') manager.disable('aih-demo', { provider });
      if (stage === 're-enabled') manager.enable('aih-demo', { provider });
      if (stage === 'removed') manager.remove('aih-demo', { provider });
      fixture.observations.length = 0;
      const { output = '', ...result } = await run(binary, launch.args, { cwd, env });
      result.marker = finalAnswer(output, provider) === MARKER;
      const observed = fixture.observations.some((item) => item.loaded);
      const expected = stage === 'enabled' || stage === 're-enabled';
      stages.push({ stage, ...result, requestCount: fixture.observations.length, skillBodyObserved: observed,
        passed: !result.error && !result.timedOut && result.exitCode === 0 && fixture.observations.length > 0 && observed === expected && result.marker === expected });
    }
    return { provider, inference: 'local-deterministic-fixture', nativeClient: binary, passed: stages.every((item) => item.passed), stages, doctorHealthy: manager.doctor().healthy };
  } finally { await fixture.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.includes('--provider')) {
    console.log('Usage: node scripts/skill-native-demo.js --provider claude|codex|opencode [--binary /path/to/native-cli]');
  } else {
    runSkillNativeDemo({ provider: args[args.indexOf('--provider') + 1], binary: args.includes('--binary') ? args[args.indexOf('--binary') + 1] : undefined })
      .then((result) => { console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1; })
      .catch((error) => { console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1; });
  }
}
module.exports = { runSkillNativeDemo, NATIVE_CLIENTS: HOSTS, runNativePrompt: run, finalAnswer };
