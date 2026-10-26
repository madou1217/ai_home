'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { createSkillManager } = require('../lib/native-resources/skill-manager');
const executeFile = promisify(execFile);
function execute(binary, args, options) {
  const pending = executeFile(binary, args, { ...options, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  pending.child.stdin.end();
  return pending;
}
async function runGeminiResourceDemo(binary = 'gemini') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-gemini-resource-'));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const observations = [];
  const errors = [];
  let marker;
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; assert.ok(text.length <= 2 * 1024 * 1024); }
      const request = JSON.parse(text);
      const loaded = JSON.stringify({ contents: request.contents, systemInstruction: request.systemInstruction }).includes(marker);
      const tool = request.tools?.flatMap(row => row.functionDeclarations || []).find(row => row.name === 'activate_skill');
      const advertised = JSON.stringify(tool || {}).includes('aih-demo');
      observations.push({ loaded, advertised });
      assert.ok(observations.length <= 3, 'unexpected_extra_model_request');
      const parts = !loaded && advertised ? [{ functionCall: { name: 'activate_skill', args: { name: 'aih-demo' } } }] : [{ text: loaded ? marker : 'RESOURCE_NOT_LOADED' }];
      const result = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 } };
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify(result)}\n\n`);
    } catch (error) { errors.push(error.message); res.writeHead(400); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GEMINI_API_KEY: 'fixture-key', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${server.address().port}`, NO_PROXY: '127.0.0.1,localhost', TERM: 'dumb' };
  try {
    fs.mkdirSync(work, { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini/settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, privacy: { usageStatisticsEnabled: false }, general: { disableAutoUpdate: true } }));
    const options = { aiHomeDir: path.join(root, 'aih'), hostHomeDir: home, nativeBinaries: { gemini: binary } };
    const plugin = createNativePluginManager(options);
    const skill = createSkillManager(options);
    const resources = [
      { kind: 'plugin', manager: plugin, source: path.resolve(__dirname, '../examples/native-plugins/aih-demo'), marker: 'AIH_PLUGIN_DEMO_OK' },
      { kind: 'skill', manager: skill, source: path.resolve(__dirname, '../assets/provider-skills/aih-demo'), marker: 'AIH_SKILL_DEMO_OK' }
    ];
    const stages = [];
    for (const resource of resources) {
      marker = resource.marker;
      resource.manager.install(resource.source, { provider: 'gemini' });
      for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
        if (stage === 'disabled') resource.manager.disable('aih-demo', { provider: 'gemini' });
        if (stage === 're-enabled') resource.manager.enable('aih-demo', { provider: 'gemini' });
        if (stage === 'removed') resource.manager.remove('aih-demo', { provider: 'gemini' });
        observations.length = 0;
        const { stdout } = await execute(binary, ['--skip-trust', '-p', 'Use the aih-demo skill if available.', '-m', 'gemini-2.5-flash', '--output-format', 'stream-json', '--allowed-tools', 'activate_skill'], { env, cwd: work });
        const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch (_) { return []; } });
        const expected = stage === 'enabled' || stage === 're-enabled';
        const answer = events.filter(event => event.type === 'message' && event.role === 'assistant').map(event => event.content || '').join('').trim();
        const activation = events.find(event => event.type === 'tool_use' && event.tool_name === 'activate_skill' && event.parameters?.name === 'aih-demo');
        const activated = Boolean(activation && events.some(event => event.type === 'tool_result' && event.tool_id === activation.tool_id && event.status === 'success'));
        assert.equal(activated, expected, 'native skill activation event');
        assert.equal(events.findLast(event => event.type === 'result')?.status, 'success');
        assert.equal(observations.some(row => row.advertised), expected, 'native skill advertised');
        assert.deepEqual(errors, []);
        assert.equal(observations.some(row => row.loaded), expected, JSON.stringify({ resource: resource.kind, stage, observations, answer }));
        assert.equal(answer, expected ? marker : 'RESOURCE_NOT_LOADED');
        assert.equal(observations.length, expected ? 2 : 1);
        stages.push({ resource: resource.kind, stage, bodyObserved: expected, nativeActivation: activated, requests: observations.length, answer, passed: true });
      }
    }
    return { host: 'gemini', version: (await execute(binary, ['--version'], { env, cwd: work })).stdout.trim(), inference: 'local-deterministic-fixture', stages, passed: true };
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/gemini-resource-native-demo.js [native-cli-path]');
  else runGeminiResourceDemo(process.argv[2]).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => { console.error(error.message, error.stdout || '', error.stderr || ''); process.exitCode = 1; });
}
module.exports = { runGeminiResourceDemo };
