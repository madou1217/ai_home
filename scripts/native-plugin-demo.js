'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./process-runner');
const { createNativePluginManager } = require('../lib/native-resources/native-plugin-manager');
const { probeHostRuntime } = require('../lib/native-resources/host-runtime-discovery');
const { IMPORTED_HOSTS } = require('../lib/native-resources/provider-resource-doctor');
const { resolveProviderResourceRuntime } = require('../lib/native-resources/provider-native-runtime');
const SOURCE = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
const CLIENTS = [
  { provider: 'codex', binary: '/Users/model/.codex/packages/standalone/current/bin/codex.aih-original', list: ['plugin', 'list', '--json'], version: ['--version'], useDemo: 'native-plugin-use-demo.js', useProviderArgument: true },
  { provider: 'claude', binary: '/Users/model/.local/bin/claude', list: ['plugin', 'list', '--json'], version: ['--version'], useDemo: 'native-plugin-use-demo.js', useProviderArgument: true },
  { provider: 'opencode', binary: '/Users/model/Library/pnpm/bin/opencode', list: null, version: ['--version'], useDemo: 'opencode-plugin-native-demo.js' },
  { host: 'pi', demo: 'pi-plugin-native-demo.js', args: ['--managed'] },
  { host: 'deepseek', demo: 'deepseek-plugin-managed-demo.mjs', args: [] },
  { host: 'aih', demo: 'aih-portable-plugin-demo.js', args: [], localRuntime: true },
];
async function run(binary, args, env, cwd, timeoutMs = 30000) {
  const result = await runProcess(binary, args, { env, cwd, timeoutMs, maxOutput: 1024 * 1024 });
  return { status: result.status, signal: result.signal, stdout: result.stdout.slice(-65536), stderr: result.stderr.slice(-1500), timedOut: result.timedOut, error: result.error };
}
async function runNativePluginDemo() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aih-native-plugin-demo-')); const host=path.join(root,'host'); const opts={aiHomeDir:path.join(root,'aih'),hostHomeDir:host,nativeBinaries:Object.fromEntries(CLIENTS.filter(x=>x.provider).map(x=>[x.provider,x.binary]))}; const manager=createNativePluginManager(opts); const stages=[];
  for(const client of CLIENTS) {
    if (client.host) {
      const descriptor = IMPORTED_HOSTS.find(row => row.host === client.host);
      const resourceRuntime = client.resourceProvider && resolveProviderResourceRuntime(client.resourceProvider, { hostHomeDir: os.homedir() });
      const probe = resourceRuntime && await run(resourceRuntime.command, [...resourceRuntime.args, '--version'], { ...process.env, ...resourceRuntime.env }, root);
      const runtime = client.resourceProvider ? { available: probe?.status === 0, version: probe?.stdout.trim(), reason: 'native_resource_runtime_unavailable' } : client.localRuntime ? { available: true, version: process.versions.node } : probeHostRuntime(descriptor, { hostHomeDir: os.homedir() });
      if (!runtime.available) { stages.push({ host: client.host, state: 'runtime-unavailable', reason: runtime.reason }); continue; }
      const demo = await run(process.execPath, [path.join(__dirname, client.demo), ...(runtime.packageDir ? [runtime.packageDir] : []), ...client.args], process.env, root, client.timeoutMs || (client.localRuntime ? 180000 : 30000));
      try {
        const evidence = JSON.parse(demo.stdout);
        stages.push({ host: client.host, version: runtime.version, evidence, passed: demo.status === 0 && evidence.passed });
      } catch (_) { stages.push({ host: client.host, passed: false, error: 'native_host_demo_failed', status: demo.status }); }
      continue;
    }
    const codexHome = path.join(host, '.codex');
    const env={...process.env,HOME:host,USERPROFILE:host,CODEX_HOME:codexHome,CLAUDE_CONFIG_DIR:path.join(host,'.claude'),XDG_CONFIG_HOME:path.join(host,'.config'),XDG_DATA_HOME:path.join(host,'.local/share'),XDG_CACHE_HOME:path.join(host,'.cache'),NO_PROXY:'127.0.0.1,localhost'};
    if (client.provider === 'codex') {
      fs.mkdirSync(codexHome, { recursive: true });
      const configPath = path.join(codexHome, 'config.toml');
      const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
      if (!/^\[features\][\s\S]*?^remote_plugin\s*=/m.test(existing)) {
        fs.writeFileSync(configPath, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}[features]\nremote_plugin = false\n`);
      }
    }
    const capability=manager.capability(client.provider);
    const runtime=await run(client.binary,client.version,env,root); if(capability.state==='unsupported') { stages.push({provider:client.provider,state:'unsupported',reason:capability.reason||'provider_not_registered',runtime:runtime.status===0?'available':'unavailable'}); continue; }
    if(runtime.status===null&&runtime.signal===null&&runtime.stderr.includes('ENOENT')) { stages.push({provider:client.provider,state:'runtime-unavailable',reason:'native_cli_missing'}); continue; }
    try {
      const installed=manager.install(SOURCE,{provider:client.provider}); const enabled=client.list?await run(client.binary,client.list,env,root):client.provider==='opencode'?await run(client.binary,['--version'],env,root):{status:0,stdout:'projection-only'};
      const doctor=manager.doctor({provider:client.provider});
      let nativeListed=false; try { nativeListed=client.provider==='codex'?JSON.parse(enabled.stdout).installed.some(x=>x.pluginId==='aih-demo@aih-local'):client.provider==='claude'?JSON.parse(enabled.stdout).some(x=>x.id==='aih-demo@skills-dir'):client.provider==='opencode'?enabled.status===0&&fs.readFileSync(path.join(opts.hostHomeDir,'.config/opencode/opencode.json'),'utf8').includes(installed.target):false; } catch (_) {}
      manager.disable('aih-demo',{provider:client.provider}); const disabled=client.list?await run(client.binary,client.list,env,root):{status:0,stdout:'config projection removed'}; manager.remove('aih-demo',{provider:client.provider});
      let pluginUse;
      if (client.useDemo) {
        const demo = await run(process.execPath, [path.join(__dirname, client.useDemo), ...(client.useProviderArgument ? [client.provider] : []), client.binary], process.env, root);
        try { pluginUse = JSON.parse(demo.stdout); } catch (_) { pluginUse = { passed: false, status: demo.status, error: 'native_plugin_use_demo_failed' }; }
        if (demo.status !== 0) pluginUse.passed = false;
      }
      stages.push({provider:client.provider,version:runtime.stdout.trim(),projection:installed.target,nativeInstallStatus:enabled.status, nativeListed, disabledStatus:disabled.status, doctorHealthy:doctor.healthy, toolExecutionVerified:Boolean(pluginUse?.toolExecutionVerified), ...(pluginUse?{pluginUse,pluginUseVerified:pluginUse.passed}:{}), passed:enabled.status===0&&disabled.status===0&&doctor.healthy&&nativeListed&&(!client.useDemo||pluginUse.passed)});
    } catch(error) { stages.push({provider:client.provider,state:'error',error:error.code||error.message,passed:false}); }
  }
  fs.rmSync(root,{recursive:true,force:true}); return {fixture:'aih-demo',stages,passed:stages.every(x=>x.passed||x.state==='runtime-unavailable'||x.state==='unsupported')};
}
if(require.main===module) runNativePluginDemo().then(r=>{console.log(JSON.stringify(r,null,2));process.exitCode=r.passed?0:1;}).catch(e=>{console.error(JSON.stringify({error:e.code||e.message}));process.exitCode=1;});
module.exports={runNativePluginDemo};
