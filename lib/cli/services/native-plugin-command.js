'use strict';
const { createNativePluginManager } = require('../../native-resources/native-plugin-manager');
const { requireMcp } = require('../../native-resources/mcp-errors');
const USAGE = [
  'Usage: aih native plugin <command> [options]', '',
  '  list [--provider <id>] [--json]',
  '  install <package-dir> --provider <id> [--json]',
  '  enable|disable|remove <pluginId> --provider <id> [--json]',
  '  doctor [--provider <id>] [--json]', '',
  'Canonical package.json agentPlugin metadata is projected into each native host.',
  'Codex uses a local marketplace; Claude uses skills-dir; OpenCode uses a local plugin path.',
  'Pi and DeepSeek are reported as explicit runtime gaps until their host is available.'
].join('\n');
const commands = new Set(['list','install','enable','disable','remove','doctor']);
function parse(args, command) { const out={positional:[]}; for(let i=0;i<args.length;i+=1){const x=args[i];if(x==='--json')out.json=true;else if(x==='--provider'){requireMcp(args[i+1]&&!args[i+1].startsWith('-'),'native_plugin_provider_required');out.provider=args[++i].toLowerCase();}else if(x.startsWith('-'))requireMcp(false,'native_plugin_option_unknown');else out.positional.push(x);} return out; }
async function runNativePluginCommand(rawArgs=[], context={}) { const args=rawArgs.slice(2).map(String); const command=args.shift(); const output=context.consoleImpl||console; if(!commands.has(command)||args.includes('--help')||args.includes('-h')){output.log(USAGE);return 0;} try{const o=parse(args,command); const manager=createNativePluginManager(context); requireMcp(o.positional.length===(['list','doctor'].includes(command)?0:1),'native_plugin_argument_required'); let result; if(command==='list'||command==='doctor') result=manager[command](o); else { requireMcp(o.provider,'native_plugin_provider_required'); const value=o.positional[0]; result={ok:true,results:[{ok:true,provider:o.provider,result:command==='install'?manager.install(value,{provider:o.provider}):manager[command](value,{provider:o.provider})}]}; } output.log(o.json?JSON.stringify(result):JSON.stringify(result,null,2)); return result.ok===false||result.healthy===false?1:0; }catch(e){output.error(args.includes('--json')?JSON.stringify({ok:false,error:e.code||'native_plugin_operation_failed'}):`[aih native plugin] ${e.code||e.message}`);return 1;} }
module.exports={runNativePluginCommand};
