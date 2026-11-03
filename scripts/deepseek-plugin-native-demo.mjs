import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import discovery from '../lib/native-resources/host-runtime-discovery.js';
import doctors from '../lib/native-resources/provider-resource-doctor.js';

if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/deepseek-plugin-native-demo.mjs [installed-dsh-package-directory]');
  process.exit(0);
}
const runtimePackage = process.argv[2] || discovery.findRuntimePackage(doctors.IMPORTED_HOSTS.find(host => host.host === 'deepseek'), { hostHomeDir: os.homedir() })?.packageDir;
assert.ok(runtimePackage, 'Usage: node scripts/deepseek-plugin-native-demo.mjs <dsh-package-directory>');
const require = createRequire(path.join(runtimePackage, 'package.json'));
const base = createRequire(require.resolve('@deepseek-ai/dsh-base'));
const load = name => import(pathToFileURL(base.resolve(name)));
const { Context } = await load('@deepseek-ai/cordis');
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt');
const { default: Tools } = await load('@deepseek-ai/dsh-tools');
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../examples/native-plugins/aih-demo');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-dsh-plugin-'));
const ctx = new Context();
try {
  const dshHome = path.join(root, 'dsh');
  const profile = path.join(dshHome, 'profiles/demo');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'aih-demo-profile', private: true, version: '1.0.0', dsh: { profile: { bundles: [] } } }));
  fs.writeFileSync(path.join(profile, 'cordis.yml'), '[]\n');
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n');
  const launcher = path.join(root, 'run-dsh.mjs');
  fs.writeFileSync(launcher, `import { runCli } from ${JSON.stringify(pathToFileURL(path.join(runtimePackage, 'lib/bin.js')).href)};\nawait runCli();\n`);
  const run = args => {
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, DSH_HOME: dshHome },
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024
    });
    assert.equal(result.status, 0, result.error?.code || result.stderr || result.stdout);
    return result.stdout;
  };
  run(['plugin', '--profile', 'demo', 'add', source, '--offline']);
  const composed = run(['--profile', 'demo', '--dump-config']);
  assert.match(composed, /aih-demo-plugin\/deepseek/, 'native profile bundle projection');
  const plugin = await import(pathToFileURL(createRequire(path.join(profile, 'package.json')).resolve('aih-demo-plugin/deepseek')));
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await ctx.plugin(Tools, { mode: 'native' });
  const steps = [];
  let stale;
  for (const stage of ['enabled', 're-enabled']) {
    const fiber = ctx.plugin(plugin.default);
    await fiber;
    const tool = ctx.tools.get('aih_demo');
    assert.ok(tool, 'native DSH tools registration');
    const result = await ctx.tools.execute({ callId: `demo-${stage}`, name: 'aih_demo', arguments: { text: 'portable-input' }, signal: new AbortController().signal });
    assert.equal(result.value, 'AIH_PLUGIN_DEMO_OK:portable-input');
    stale = tool;
    await fiber.dispose();
    assert.equal(ctx.tools.get('aih_demo'), undefined, 'native Cordis contribution withdrawn');
    await assert.rejects(() => stale.execute({ text: 'stale' }, { signal: new AbortController().signal }), /portable_plugin_disposed/);
    steps.push({ stage, registered: true, called: true, withdrawn: true, cleanup: true, passed: true });
  }
  run(['plugin', '--profile', 'demo', 'remove', 'aih-demo-plugin']);
  assert.doesNotMatch(run(['--profile', 'demo', '--dump-config']), /aih-demo-plugin\/deepseek/, 'native profile package removal');
  console.log(JSON.stringify({ host: 'deepseek', version: JSON.parse(fs.readFileSync(path.join(runtimePackage, 'package.json'))).version, packageManager: 'native dsh plugin add/remove + dump-config', runtime: 'native DSH ToolRuntime + Cordis', inference: 'none', steps, passed: true }, null, 2));
} finally {
  await ctx.fiber.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
