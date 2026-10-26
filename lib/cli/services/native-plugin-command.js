'use strict';
const { createNativePluginManager } = require('../../native-resources/native-plugin-manager');
const { inspectPortablePlugin, projectPortablePlugin } = require('../../native-resources/portable-plugin-conformance');
const { requireMcp } = require('../../native-resources/mcp-errors');
const USAGE = [
  'Usage: aih native plugin <command> [options]', '',
  '  list [--provider <id>|--host <id>] [--json]',
  '  install <package-dir> (--provider <id>|--host pi|deepseek) [--json]',
  '  enable|disable|remove <pluginId> (--provider <id>|--host pi|deepseek) [--json]',
  '  inspect <package-dir> [--host deepseek|opencode|pi|aih] [--json]',
  '  project <package-dir> --host <host> --out <dir> [--json]',
  '  doctor [--provider <id>|--host <id>] [--json]', '',
  'Canonical package.json agentPlugin metadata is projected into each native host.',
  'Codex uses a local marketplace; Claude uses skills-dir; OpenCode uses a local plugin path.',
  'inspect/project prove imported host shape; they do not claim runtime execution.'
].join('\n');
const commands = new Set(['list','install','enable','disable','remove','inspect','project','doctor']);
function parse(args) {
  const out={positional:[]};
  for(let i=0;i<args.length;i+=1){
    const x=args[i];
    if(x==='--json') out.json=true;
    else if(x==='--provider') { requireMcp(args[i+1]&&!args[i+1].startsWith('-'),'native_plugin_provider_required'); out.provider=args[++i].toLowerCase(); }
    else if(x==='--host') { requireMcp(args[i+1]&&!args[i+1].startsWith('-'),'native_plugin_host_required'); out.host=args[++i].toLowerCase(); }
    else if(x==='--out') { requireMcp(args[i+1]&&!args[i+1].startsWith('-'),'native_plugin_output_required'); out.out=args[++i]; }
    else if(x.startsWith('-')) requireMcp(false,'native_plugin_option_unknown');
    else out.positional.push(x);
  }
  return out;
}
async function runNativePluginCommand(rawArgs=[], context={}) {
  const args=rawArgs.slice(2).map(String); const command=args.shift(); const output=context.consoleImpl||console;
  if(!commands.has(command)||args.includes('--help')||args.includes('-h')) { output.log(USAGE); return 0; }
  try {
    const o=parse(args);
    requireMcp(!(o.provider&&o.host),'native_plugin_selector_conflict');
    let result;
    if(command==='inspect') { requireMcp(o.positional.length===1,'native_plugin_argument_required'); result=inspectPortablePlugin(o.positional[0]); }
    else if(command==='project') { requireMcp(o.positional.length===1&&o.host&&o.out,'native_plugin_projection_required'); result=projectPortablePlugin(o.positional[0],o.host,o.out); }
    else {
      const manager=createNativePluginManager(context); requireMcp(o.positional.length===(['list','doctor'].includes(command)?0:1),'native_plugin_argument_required');
      if(command==='list'||command==='doctor') result=manager[command](o);
      else { requireMcp(o.provider||o.host,'native_plugin_provider_required'); const value=o.positional[0]; const selection=o.host?{host:o.host}:{provider:o.provider}; result={ok:true,results:[{ok:true,...selection,result:command==='install'?manager.install(value,selection):manager[command](value,selection)}]}; }
    }
    output.log(o.json?JSON.stringify(result):JSON.stringify(result,null,2)); return result.ok===false||result.healthy===false?1:0;
  } catch(e) { output.error(args.includes('--json')?JSON.stringify({ok:false,error:e.code||'native_plugin_operation_failed'}):`[aih native plugin] ${e.code||e.message}`); return 1; }
}
module.exports={runNativePluginCommand};
