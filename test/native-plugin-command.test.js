'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runNativePluginCommand } = require('../lib/cli/services/native-plugin-command');
const fixture = path.resolve(__dirname, '../examples/native-plugins/aih-demo');
function ctx(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aih-native-cli-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); const out=[]; return {out, context:{aiHomeDir:path.join(dir,'aih'),hostHomeDir:path.join(dir,'host'),consoleImpl:{log:x=>out.push(String(x)),error:x=>out.push(String(x))},nativeBinaries:{}}}; }
test('native plugin CLI performs local projection lifecycle and help', async (t) => {
 const f=ctx(t); for(const command of ['list','install','enable','disable','remove','doctor']) { assert.equal(await runNativePluginCommand(['native','plugin',command,'--help'],f.context),0); assert.match(f.out.at(-1),/Usage: aih native plugin/); }
 assert.equal(await runNativePluginCommand(['native','plugin','install',fixture,'--provider','claude','--json'],f.context),0);
 assert.equal(JSON.parse(f.out.at(-1)).results[0].result.pluginId,'aih-demo');
 for(const command of ['list','doctor','disable','enable','remove']) { const args=['native','plugin',command,...(command==='list'||command==='doctor'?[]:['aih-demo']),'--provider','claude','--json']; assert.equal(await runNativePluginCommand(args,f.context),0); }
});
test('native plugin CLI rejects unsupported import and unknown options', async (t) => { const f=ctx(t); for(const args of [['install',fixture,'--provider','deepseek'],['install',fixture,'--provider','claude','--bad'],['list','--provider']]) assert.equal(await runNativePluginCommand(['native','plugin',...args,'--json'],f.context),1); });
test('native plugin inspect/project reports DeepSeek and Pi projections without runtime claims', async (t) => {
  const f=ctx(t); const outDir=path.join(f.context.aiHomeDir,'projected-deepseek');
  assert.equal(await runNativePluginCommand(['native','plugin','inspect',fixture,'--host','deepseek','--json'],f.context),0);
  const inspect=JSON.parse(f.out.at(-1)); assert.equal(inspect.hosts.deepseek.state,'projection-ready');
  assert.equal(await runNativePluginCommand(['native','plugin','project',fixture,'--host','deepseek','--out',outDir,'--json'],f.context),0);
  const result=JSON.parse(f.out.at(-1)); assert.equal(result.state,'projection-ready'); assert.equal(fs.existsSync(path.join(outDir,'host-projection.json')),true);
});
