import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'yaml';
import discovery from '../lib/native-resources/host-runtime-discovery.js';
import doctors from '../lib/native-resources/provider-resource-doctor.js';
import harness from '../lib/harness/dsh.js';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/deepseek-plugin-managed-demo.mjs [installed-dsh-package-directory]');
  process.exit(0);
}
const runtimePackage = process.argv[2] || discovery.findRuntimePackage(doctors.IMPORTED_HOSTS.find(row => row.host === 'deepseek'), { hostHomeDir: os.homedir() })?.packageDir;
assert.ok(runtimePackage, 'native_dsh_runtime_package_required');
const require = createRequire(path.join(runtimePackage, 'package.json'));
const base = createRequire(require.resolve('@deepseek-ai/dsh-base'));
const { boot } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
const { default: SystemPrompt } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-system-prompt')));
const { default: Tools } = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-tools')));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dsh-managed-demo-'));
const home = path.join(root, 'home');
const aiHomeDir = path.join(root, 'aih');
const dshHome = path.join(root, 'dsh');
const profile = path.join(dshHome, 'profiles/demo');
const env = { ...process.env, HOME: home, USERPROFILE: home, AIH_HOME_DIR: aiHomeDir, DSH_HOME: dshHome };
const run = (args, extraEnv = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.code || result.stderr || result.stdout);
  return result.stdout;
};
try {
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'aih-dsh-managed-demo', private: true, version: '1.0.0', dsh: { profile: { bundles: [] } } }));
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const launcher = path.join(root, 'run-dsh.mjs');
  fs.writeFileSync(launcher, harness.buildDshWrapperSource(path.join(runtimePackage, 'lib/bin.js')));
  const steps = [];
  for (const stage of ['enabled', 'disabled', 're-enabled', 'removed']) {
    const command = { enabled: 'install', disabled: 'disable', 're-enabled': 'enable', removed: 'remove' }[stage];
    const result = JSON.parse(run([path.join(repo, 'bin/ai-home.js'), 'native', 'plugin', command, command === 'install' ? path.join(repo, 'examples/native-plugins/aih-demo') : 'aih-demo', '--host', 'deepseek', '--json']));
    assert.equal(result.ok, true);
    const expected = ['enabled', 're-enabled'].includes(stage);
    const listing = JSON.parse(run([path.join(repo, 'bin/ai-home.js'), 'native', 'plugin', 'list', '--host', 'deepseek', '--json']));
    assert.equal(listing.resources.length, stage === 'removed' ? 0 : 1);
    if (listing.resources.length) assert.equal(listing.resources[0].provider, undefined);
    assert.equal(JSON.parse(run([path.join(repo, 'bin/ai-home.js'), 'native', 'plugin', 'doctor', '--host', 'deepseek', '--json'])).healthy, true);
    const prepared = await harness.prepareDshHarness({
      aiHomeDir, hostHomeDir: home, accountRef: 'acct_demo', provider: 'codex', model: 'demo',
      gateway: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key' }, catalog: { models: [{ id: 'demo' }] },
      dshPath: path.join(runtimePackage, 'lib/bin.js')
    });
    const patchFiles = prepared.args.flatMap((arg, index, args) => arg === '--patch' ? [args[index + 1]] : []);
    assert.equal(patchFiles.length, expected ? 1 : 0);
    assert.notEqual(prepared.env.DSH_HOME, dshHome, 'account harness retains its own DSH_HOME');
    const accountComposed = run([...prepared.command.args, '--dump-config'], prepared.env);
    assert.equal(accountComposed.includes('id: aih-demo'), expected, 'actual account profile composition');
    const composed = run([launcher, '--profile', 'demo', ...patchFiles.flatMap(file => ['--patch', file]), '--dump-config']);
    assert.equal(composed.includes('id: aih-demo'), expected, 'native DSH profile composition');
    const patches = patchFiles.flatMap(file => yaml.parse(fs.readFileSync(file, 'utf8')));
    const ctx = await boot('dsh', path.join(profile, 'cordis.yml'), patches, async ctx => {
      await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
      await ctx.plugin(Tools, { mode: 'native' });
    }, pathToFileURL(path.join(runtimePackage, 'lib/bin.js')).href);
    let tool;
    try {
      tool = ctx.tools.get('aih_demo');
      assert.equal(Boolean(tool), expected, 'real native Loader contribution');
      if (tool) {
        assert.equal(tool.description, 'Portable core projected by DeepSeek Harness', 'native bundle configuration preserved');
        const value = await ctx.tools.execute({ callId: stage, name: 'aih_demo', arguments: { text: 'portable-input' }, signal: new AbortController().signal });
        assert.equal(value.value, 'AIH_PLUGIN_DEMO_OK:portable-input');
      }
    } finally { await ctx.fiber.dispose(); }
    if (tool) await assert.rejects(() => tool.execute({ text: 'stale' }, { signal: new AbortController().signal }), /portable_plugin_disposed/);
    steps.push({ stage, profileComposed: expected, nativeToolCalled: Boolean(tool), cleanup: Boolean(tool), accountHarnessVerified: true, passed: true });
  }
  console.log(JSON.stringify({ host: 'deepseek', version: JSON.parse(fs.readFileSync(path.join(runtimePackage, 'package.json'))).version, packageManager: 'AIH CLI + owned DSH patch', runtime: 'native DSH boot/Loader/ToolRuntime/Cordis', inference: 'none', steps, passed: true }, null, 2));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
