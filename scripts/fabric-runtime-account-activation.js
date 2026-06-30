#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  buildSshArgs,
  shQuote
} = require('./fabric-real-vps-deploy');

const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_NODE_ID = 'aws-current-node';
const DEFAULT_PORT = 9527;
const DEFAULT_REMOTE_NODE_VERSION = 'node-v22.16.0-linux-x64';
const DEFAULT_PROVIDERS = ['codex', 'claude', 'agy', 'opencode'];
const KNOWN_PROVIDERS = new Set(['codex', 'claude', 'agy', 'opencode', 'gemini']);

function showHelp() {
  console.log(`AIH Fabric runtime account activation

Usage:
  node scripts/fabric-runtime-account-activation.js [options]

Options:
  --ssh <user@host>       SSH target, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>         SSH key, default ${DEFAULT_SSH_KEY}.
  --remote-dir <path>     AWS current dir, default ${DEFAULT_REMOTE_DIR}.
  --node-id <id>          Fabric node id, default ${DEFAULT_NODE_ID}.
  --port <n>              AIH server port, default ${DEFAULT_PORT}.
  --providers <list>      Comma-separated providers, default ${DEFAULT_PROVIDERS.join(',')}.
  --accounts <zip>        Use an existing standard AIH export zip instead of exporting locally.
  --remote-audit          Read AWS account/runtime blockers without exporting or transferring credentials.
  --remote-revalidate     Clear AWS runtime blockers, reload, publish, and run real session-start guards.
  --remote-dry-run        Copy the account zip to AWS and run remote "aih import --dry-run".
  --apply                 Run remote dry-run first, import into AWS profiles, then clear stale runtime blocks.
  --yes                   Required for --remote-revalidate and credential transfer/apply operations.
  --keep-remote-archive   Do not remove the uploaded /tmp account zip after the run.
  --json                  Print machine-readable summary.
  -h, --help              Show this help.

Default mode is local-only: it creates a temporary standard export zip, reports
provider/account counts, removes the local zip, and never transfers credentials.
`);
}

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function readOptionValue(argv, index, flag) {
  const token = String(argv[index] || '');
  const inlinePrefix = `${flag}=`;
  if (token.startsWith(inlinePrefix)) return { value: token.slice(inlinePrefix.length), consumed: 1 };
  const value = argv[index + 1];
  if (value === undefined || String(value).startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: String(value), consumed: 2 };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('--port must be a TCP port');
  }
  return port;
}

function parseProviders(value) {
  const providers = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (providers.length === 0) throw new Error('--providers cannot be empty');
  providers.forEach((provider) => {
    if (!KNOWN_PROVIDERS.has(provider)) throw new Error(`unsupported provider: ${provider}`);
  });
  return Array.from(new Set(providers));
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT,
    providers: DEFAULT_PROVIDERS.slice(),
    accountsZip: '',
    remoteAudit: false,
    remoteRevalidate: false,
    remoteDryRun: false,
    apply: false,
    yes: false,
    keepRemoteArchive: false
  };

  for (let index = 0; index < argv.length;) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--remote-dry-run') {
      options.remoteDryRun = true;
      index += 1;
      continue;
    }
    if (token === '--remote-audit') {
      options.remoteAudit = true;
      index += 1;
      continue;
    }
    if (token === '--remote-revalidate') {
      options.remoteRevalidate = true;
      index += 1;
      continue;
    }
    if (token === '--apply') {
      options.apply = true;
      options.remoteDryRun = true;
      index += 1;
      continue;
    }
    if (token === '--yes') {
      options.yes = true;
      index += 1;
      continue;
    }
    if (token === '--keep-remote-archive') {
      options.keepRemoteArchive = true;
      index += 1;
      continue;
    }
    if (token === '--ssh' || token.startsWith('--ssh=')) {
      const next = readOptionValue(argv, index, '--ssh');
      options.sshTarget = normalizeText(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--ssh-key' || token.startsWith('--ssh-key=')) {
      const next = readOptionValue(argv, index, '--ssh-key');
      options.sshKey = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--remote-dir' || token.startsWith('--remote-dir=')) {
      const next = readOptionValue(argv, index, '--remote-dir');
      options.remoteDir = normalizeText(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = normalizeText(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePort(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--providers' || token.startsWith('--providers=')) {
      const next = readOptionValue(argv, index, '--providers');
      options.providers = parseProviders(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--accounts' || token.startsWith('--accounts=')) {
      const next = readOptionValue(argv, index, '--accounts');
      options.accountsZip = path.resolve(next.value);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  if (!options.sshTarget) throw new Error('--ssh is required');
  if (!path.posix.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (!options.nodeId) throw new Error('--node-id is required');
  if (options.accountsZip && !fs.existsSync(options.accountsZip)) {
    throw new Error(`accounts zip not found: ${options.accountsZip}`);
  }
  if ((options.remoteDryRun || options.apply) && !options.yes) {
    throw new Error('--yes is required before transferring provider credentials to a remote machine');
  }
  if (options.remoteRevalidate && !options.yes) {
    throw new Error('--yes is required before clearing remote runtime blockers');
  }
  if (options.remoteRevalidate && (options.remoteAudit || options.remoteDryRun || options.apply)) {
    throw new Error('--remote-revalidate cannot be combined with --remote-audit, --remote-dry-run, or --apply');
  }
  if ((options.remoteAudit || options.remoteRevalidate || options.remoteDryRun || options.apply) && options.sshKey && !fs.existsSync(options.sshKey)) {
    throw new Error(`ssh key not found: ${options.sshKey}`);
  }
  return options;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function runCapture(command, args, runOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: runOptions.cwd,
      env: runOptions.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      const result = { status, signal, stdout, stderr };
      if (status === 0) {
        resolve(result);
        return;
      }
      const error = new Error(`${command} exited with ${status}${signal ? ` signal=${signal}` : ''}`);
      error.result = result;
      reject(error);
    });
  });
}

function buildLocalExportArgs(options, outPath) {
  return ['bin/ai-home.js', 'export', outPath, ...options.providers];
}

function parseAihExportSummary(stdout) {
  const text = stripAnsi(stdout);
  const match = text.match(/providers=([^\n]+?)\s+accounts=(\d+)\s+files=(\d+)(?:\s+skipped=(\d+))?/);
  if (!match) {
    return {
      providers: [],
      accounts: 0,
      files: 0,
      skipped: 0
    };
  }
  return {
    providers: match[1].split(',').map((item) => item.trim()).filter(Boolean),
    accounts: Number(match[2]) || 0,
    files: Number(match[3]) || 0,
    skipped: Number(match[4]) || 0
  };
}

function parseAihImportSummary(stdout) {
  const text = stripAnsi(stdout);
  const rows = [];
  const regex = /-\s+([^:]+):\s+source=.*?\s+imported=(\d+)\s+duplicates=(\d+)\s+invalid=(\d+)\s+failed=(\d+)/g;
  let match = regex.exec(text);
  while (match) {
    rows.push({
      type: match[1].trim(),
      imported: Number(match[2]) || 0,
      duplicates: Number(match[3]) || 0,
      invalid: Number(match[4]) || 0,
      failed: Number(match[5]) || 0
    });
    match = regex.exec(text);
  }
  return rows.reduce((summary, row) => {
    summary.sources += 1;
    summary.imported += row.imported;
    summary.duplicates += row.duplicates;
    summary.invalid += row.invalid;
    summary.failed += row.failed;
    return summary;
  }, {
    sources: 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function createAccountsZip(options) {
  if (options.accountsZip) {
    const stat = fs.statSync(options.accountsZip);
    return {
      path: options.accountsZip,
      generated: false,
      tempDir: '',
      bytes: stat.size,
      sha256: sha256File(options.accountsZip),
      exportSummary: null
    };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-runtime-accounts-'));
  const outPath = path.join(tempDir, 'accounts.zip');
  const result = await runCapture(process.execPath, buildLocalExportArgs(options, outPath), {
    cwd: process.cwd()
  });
  const stat = fs.statSync(outPath);
  return {
    path: outPath,
    generated: true,
    tempDir,
    bytes: stat.size,
    sha256: sha256File(outPath),
    exportSummary: parseAihExportSummary(result.stdout)
  };
}

function buildRemoteEnvCommand(options) {
  const hostHome = path.posix.join(options.remoteDir, '.aih-host-home');
  const nodeBin = path.posix.join(options.remoteDir, '.node-runtime', DEFAULT_REMOTE_NODE_VERSION, 'bin');
  const localBin = path.posix.join(options.remoteDir, 'node_modules', '.bin');
  return [
    `cd ${shQuote(options.remoteDir)}`,
    `mkdir -p ${shQuote(hostHome)}`,
    `export AIH_HOST_HOME=${shQuote(hostHome)}`,
    `export PATH=${shQuote(nodeBin)}:${shQuote(localBin)}:$PATH`
  ].join(' && ');
}

function buildRemoteNodeCommand(options, command) {
  return `${buildRemoteEnvCommand(options)} && ${command}`;
}

function buildRemoteImportCommand(options, remoteZip, importOptions = {}) {
  const tail = importOptions.dryRun ? ' --dry-run' : '';
  return buildRemoteNodeCommand(
    options,
    `node bin/ai-home.js import ${shQuote(remoteZip)}${tail}`
  );
}

function buildRemoteReadyzCommand(options) {
  return buildRemoteNodeCommand(
    options,
    `curl --noproxy '*' -fsS ${shQuote(`http://127.0.0.1:${options.port}/readyz`)}`
  );
}

function buildRemoteManagementReloadCommand(options) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    "const configPath=path.join(root,'.ai_home','server-config.json')",
    "let key=''",
    "try{key=String(JSON.parse(fs.readFileSync(configPath,'utf8')).managementKey||'').trim()}catch(_error){}",
    "if(!key){console.log(JSON.stringify({ok:false,http:0,error:'management_key_missing'}));process.exit(2)}",
    `const url=${JSON.stringify(`http://127.0.0.1:${options.port}/v0/management/reload`)}`,
    "fetch(url,{method:'POST',headers:{authorization:'Bearer '+key}}).then(async(response)=>{",
    "const payload=await response.json().catch(()=>({}))",
    "const ok=Boolean(response.ok&&payload&&payload.ok!==false)",
    "console.log(JSON.stringify({ok,http:response.status,reloaded:Number(payload.reloaded)||0,providers:payload.providers||{},error:String(payload.error||'')}))",
    "if(!ok)process.exitCode=1",
    "}).catch((error)=>{console.log(JSON.stringify({ok:false,http:0,error:String(error&&error.message||error)}));process.exitCode=1})"
  ].join('; ');
  return buildRemoteNodeCommand(
    options,
    `node -e ${shQuote(script)}`
  );
}

function buildRemoteRuntimeBlockClearCommand(options) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {createAccountStateIndex}=require('./lib/account/state-index')",
    "const {createAccountStateService}=require('./lib/account/state-service')",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    "const aiHomeDir=path.join(root,'.ai_home')",
    `const providers=${JSON.stringify(options.providers)}`,
    "const index=createAccountStateIndex({aiHomeDir,fs})",
    "const service=createAccountStateService({accountStateIndex:index})",
    "const cleared=[]",
    "const skipped=[]",
    "for(const provider of providers){",
    "const rows=typeof index.listStates==='function'?index.listStates(provider):[]",
    "for(const row of rows){",
    "const accountId=String(row.accountId||row.account_id||'').trim()",
    "const runtimeState=row.runtimeState||row.runtime_state",
    "if(!accountId)continue",
    "if(!runtimeState){skipped.push({provider,accountId,reason:'runtime_state_empty'});continue}",
    "const ok=service.clearRuntimeBlock(provider,accountId,{status:String(row.status||'up').trim()||'up',configured:row.configured!==false,apiKeyMode:Boolean(row.apiKeyMode||row.api_key_mode),authMode:String(row.authMode||row.auth_mode||'').trim(),displayName:String(row.displayName||row.display_name||'').trim(),evidence:'manual_admin_clear'})",
    "if(ok)cleared.push({provider,accountId,reason:'manual_admin_clear'})",
    "else skipped.push({provider,accountId,reason:'clear_rejected'})",
    "}",
    "}",
    "console.log(JSON.stringify({ok:true,cleared:cleared.length,skipped:skipped.length,providers,accounts:cleared,skippedAccounts:skipped}))"
  ].join('; ');
  return buildRemoteNodeCommand(
    options,
    `node -e ${shQuote(script)}`
  );
}

function buildRemoteRuntimeAuditCommand(options) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {DatabaseSync}=require('node:sqlite')",
    "const {deriveRuntimeStatus}=require('./lib/account/runtime-view')",
    "const remoteDir=process.cwd()",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    "const aiHomeDir=path.join(root,'.ai_home')",
    "const dbFile=path.join(aiHomeDir,'account_state.db')",
    `const providers=${JSON.stringify(options.providers)}`,
    "function readText(file){try{return String(fs.readFileSync(file,'utf8')).trim()}catch(_error){return ''}}",
    "function parseRuntimeState(value){try{return value?JSON.parse(String(value)):null}catch(_error){return null}}",
    "function numericDirs(dir){try{return fs.readdirSync(dir,{withFileTypes:true}).filter((entry)=>entry.isDirectory()&&/^\\d+$/.test(entry.name)).map((entry)=>entry.name).sort((a,b)=>Number(a)-Number(b))}catch(_error){return []}}",
    "function addCount(map,key){const k=String(key||'').trim()||'unknown';map.set(k,(map.get(k)||0)+1)}",
    "function toRows(map){return Array.from(map.entries()).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([reason,count])=>({reason,count}))}",
    "const report={ok:true,mode:'remote-runtime-audit',readOnly:true,target:{remoteDir,aiHomeDir,dbFile,deployedGitHead:readText(path.join(remoteDir,'DEPLOYED_GIT_HEAD'))},providers:[],summary:{providers:providers.length,profileCount:0,stateRows:0,configured:0,runtimeBlocked:0,clearableRuntimeBlocks:0,dbPresent:fs.existsSync(dbFile)}}",
    "let db=null",
    "let rows=[]",
    "if(fs.existsSync(dbFile)){db=new DatabaseSync(dbFile,{readOnly:true});const placeholders=providers.map(()=>'?').join(',');rows=providers.length>0?db.prepare(`SELECT provider, account_id, status, configured, api_key_mode, auth_mode, runtime_state, updated_at FROM account_state WHERE provider IN (${placeholders}) ORDER BY provider, CAST(account_id AS INTEGER), account_id`).all(...providers):[]}",
    "for(const provider of providers){",
    "const profileIds=numericDirs(path.join(aiHomeDir,'profiles',provider))",
    "const providerRows=rows.filter((row)=>String(row.provider||'')===provider)",
    "const profileIdSet=new Set(profileIds)",
    "const stateIdSet=new Set(providerRows.map((row)=>String(row.account_id||'')).filter(Boolean))",
    "const runtimeStatusCounts=new Map()",
    "const runtimeReasonCounts=new Map()",
    "const authModeCounts=new Map()",
    "const clearable=[]",
    "let configured=0",
    "let apiKeyMode=0",
    "let runtimeBlocked=0",
    "for(const row of providerRows){",
    "if(Number(row.configured)===1)configured+=1",
    "if(Number(row.api_key_mode)===1)apiKeyMode+=1",
    "addCount(authModeCounts,row.auth_mode||'unknown')",
    "const runtimeState=parseRuntimeState(row.runtime_state)",
    "const runtimeStatus=deriveRuntimeStatus({runtimeState})",
    "addCount(runtimeStatusCounts,runtimeStatus.status)",
    "const isBlocked=runtimeStatus.status&&runtimeStatus.status!=='healthy'&&runtimeStatus.status!=='unknown'",
    "if(isBlocked){runtimeBlocked+=1;const reason=`${runtimeStatus.status}${runtimeStatus.reason?':'+runtimeStatus.reason:''}`;addCount(runtimeReasonCounts,reason)}",
    "if(runtimeState)clearable.push(String(row.account_id||''))",
    "}",
    "const profileOnlyIds=profileIds.filter((id)=>!stateIdSet.has(id))",
    "const stateOnlyIds=Array.from(stateIdSet).filter((id)=>!profileIdSet.has(id)).sort((a,b)=>Number(a)-Number(b))",
    "report.providers.push({provider,profileCount:profileIds.length,stateRows:providerRows.length,configured,apiKeyMode,runtimeBlocked,clearableRuntimeBlocks:clearable.length,runtimeStatusCounts:toRows(runtimeStatusCounts),runtimeReasonCounts:toRows(runtimeReasonCounts),authModeCounts:toRows(authModeCounts),sampleClearableAccountIds:clearable.slice(0,5),profileOnlyIds:profileOnlyIds.slice(0,10),stateOnlyIds:stateOnlyIds.slice(0,10)})",
    "report.summary.profileCount+=profileIds.length;report.summary.stateRows+=providerRows.length;report.summary.configured+=configured;report.summary.runtimeBlocked+=runtimeBlocked;report.summary.clearableRuntimeBlocks+=clearable.length",
    "}",
    "if(db)db.close()",
    "console.log(JSON.stringify(report))"
  ].join('; ');
  return buildRemoteNodeCommand(
    options,
    `node -e ${shQuote(script)}`
  );
}

function buildRemoteRegistryPublishCommand(options) {
  const tokenPath = path.posix.join(
    options.remoteDir,
    '.aih-host-home',
    '.ai_home',
    'fabric',
    `${options.nodeId}.token`
  );
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {spawnSync}=require('node:child_process')",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    `const tokenPath=${JSON.stringify(tokenPath)}`,
    "const configPath=path.join(root,'.ai_home','server-config.json')",
    "const endpoint=process.env.AIH_FABRIC_ENDPOINT",
    "const nodeId=process.env.AIH_FABRIC_NODE_ID",
    "let token=''",
    "let managementKey=''",
    "try{token=String(fs.readFileSync(tokenPath,'utf8')).trim()}catch(_error){}",
    "try{managementKey=String(JSON.parse(fs.readFileSync(configPath,'utf8')).managementKey||'').trim()}catch(_error){}",
    "if(!token){console.log(JSON.stringify({ok:false,error:'fabric_token_missing'}));process.exit(2)}",
    "if(!managementKey){console.log(JSON.stringify({ok:false,error:'management_key_missing'}));process.exit(2)}",
    "const env={...process.env,AIH_FABRIC_TOKEN:token,AIH_MANAGEMENT_KEY:managementKey}",
    "const args=['bin/ai-home.js','fabric','registry','publish',endpoint,'--from-server','--node-id',nodeId,'--relay-node','--transport','relay','--transport','webrtc=webrtc://'+nodeId,'--json']",
    "const result=spawnSync(process.execPath,args,{cwd:process.cwd(),env,encoding:'utf8'})",
    "if(result.stderr)process.stderr.write(result.stderr)",
    "let parsed=null",
    "try{parsed=JSON.parse(String(result.stdout||'').trim())}catch(_error){}",
    "const ok=Boolean(result.status===0&&parsed&&parsed.ok!==false)",
    "const fromServer=parsed&&parsed.fromServer||{}",
    "console.log(JSON.stringify({ok,status:Number(result.status)||0,nodeId:parsed&&parsed.nodeId||nodeId,runtimes:Number(parsed&&parsed.runtimes)||0,transports:Number(parsed&&parsed.transports)||0,accounts:Number(fromServer.accounts)||0,providers:Array.isArray(fromServer.providers)?fromServer.providers:[],error:ok?'':String(parsed&&parsed.error||'publish_failed')}))",
    "if(!ok)process.exitCode=Number(result.status)||1"
  ].join('; ');
  return [
    buildRemoteEnvCommand(options),
    `export AIH_FABRIC_ENDPOINT=${shQuote(`http://127.0.0.1:${options.port}`)}`,
    `export AIH_FABRIC_NODE_ID=${shQuote(options.nodeId)}`,
    `node -e ${shQuote(script)}`
  ].join(' && ');
}

function buildRemoteCleanupCommand(remoteZip) {
  return `rm -f ${shQuote(remoteZip)}`;
}

function buildRemoteArchivePath(options, archive) {
  const digest = String(archive.sha256 || '').slice(0, 16) || String(Date.now());
  return path.posix.join('/tmp', `aih-runtime-accounts-${options.nodeId}-${digest}.zip`);
}

async function runRemote(options, command) {
  return runCapture('ssh', [
    ...buildSshArgs(options),
    options.sshTarget,
    command
  ]);
}

async function copyToRemote(options, localPath, remotePath) {
  return runCapture('scp', [
    ...buildSshArgs(options),
    localPath,
    `${options.sshTarget}:${remotePath}`
  ]);
}

function parseReadyz(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_error) {
    return null;
  }
}

function parseJsonObject(stdout) {
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

async function runCaptureStatus(command, args, runOptions = {}) {
  try {
    return await runCapture(command, args, runOptions);
  } catch (error) {
    if (error && error.result) return error.result;
    throw error;
  }
}

async function readFabricNode(options) {
  const result = await runCapture(process.execPath, [
    'bin/ai-home.js',
    'fabric',
    'nodes',
    options.nodeId,
    '--json'
  ], { cwd: process.cwd() });
  return JSON.parse(result.stdout);
}

function summarizeFabricNode(payload, nodeId) {
  const node = payload && (payload.targetNode || (Array.isArray(payload.nodes) ? payload.nodes.find((item) => item && item.id === nodeId) : null));
  const capabilities = node && node.capabilities || {};
  return {
    found: Boolean(node),
    runtimeHost: Boolean(capabilities.runtimeHost),
    runtimeProviders: Array.isArray(capabilities.runtimeProviders) ? capabilities.runtimeProviders.slice() : [],
    runtimeGaps: Array.isArray(node && node.runtimeGaps)
      ? node.runtimeGaps.map((gap) => ({
        provider: String(gap && gap.provider || ''),
        blocker: String(gap && gap.blocker || '')
      }))
      : []
  };
}

async function waitForRuntimeRegistry(options, waitOptions = {}) {
  const attempts = Math.max(1, Number(waitOptions.attempts) || 6);
  const delayMs = Math.max(500, Number(waitOptions.delayMs) || 5000);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const payload = await readFabricNode(options);
    last = summarizeFabricNode(payload, options.nodeId);
    const providers = new Set(last.runtimeProviders);
    const missing = options.providers.filter((provider) => !providers.has(provider));
    if (last.runtimeHost && missing.length === 0) {
      return { ok: true, attempts: attempt, node: last };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { ok: false, attempts, node: last };
}

function getRuntimeBlockedCount(audit) {
  return Number(audit && audit.summary && audit.summary.runtimeBlocked) || 0;
}

function getClearableRuntimeBlockCount(audit) {
  return Number(audit && audit.summary && audit.summary.clearableRuntimeBlocks) || 0;
}

function getProviderRuntimeReasons(audit) {
  return (Array.isArray(audit && audit.providers) ? audit.providers : []).map((item) => ({
    provider: String(item && item.provider || ''),
    runtimeBlocked: Number(item && item.runtimeBlocked) || 0,
    reasons: Array.isArray(item && item.runtimeReasonCounts) ? item.runtimeReasonCounts : []
  }));
}

function getProviderProfileCount(audit, provider) {
  const item = (Array.isArray(audit && audit.providers) ? audit.providers : [])
    .find((entry) => String(entry && entry.provider || '') === provider);
  return Number(item && item.profileCount) || 0;
}

function summarizeSessionStartResult(provider, marker, result) {
  const payload = parseJsonObject(stripAnsi(result && result.stdout));
  const parsed = payload && typeof payload === 'object';
  const bodyResult = parsed && payload.result && typeof payload.result === 'object' ? payload.result : {};
  const http = parsed && payload.http && typeof payload.http === 'object' ? payload.http : {};
  const transportDecision = parsed && payload.transportDecision && typeof payload.transportDecision === 'object'
    ? payload.transportDecision
    : {};
  const transport = parsed && payload.transport && typeof payload.transport === 'object' ? payload.transport : {};
  return {
    provider,
    marker,
    status: Number(result && result.status) || 0,
    parsed,
    ok: Boolean(parsed && payload.ok === true),
    blocked: Boolean(parsed && payload.blocked === true),
    blockers: parsed && Array.isArray(payload.blockers) ? payload.blockers.map((item) => String(item || '')).filter(Boolean) : [],
    http: {
      registryAuthorizedStatus: Number(http.registryAuthorizedStatus) || 0,
      sessionStartStatus: Number(http.sessionStartStatus) || 0
    },
    runId: String(bodyResult.runId || bodyResult.run_id || ''),
    sessionId: String(bodyResult.sessionId || bodyResult.session_id || ''),
    accountId: String(bodyResult.accountId || bodyResult.account_id || ''),
    transportKind: String(transportDecision.selectedTransportKind || transport.kind || ''),
    fallbackUsed: transportDecision.fallbackUsed === true,
    error: parsed ? String(payload.error || '') : 'session_start_json_parse_failed'
  };
}

function isRetryableSessionStartResult(summary) {
  if (!summary || summary.runId) return false;
  if (Number(summary.http && summary.http.sessionStartStatus) === 503) return true;
  return Array.isArray(summary.blockers) && summary.blockers.includes('remote_transport_unavailable');
}

function getSessionOutputEventText(events) {
  return events
    .map((event) => {
      if (!event || typeof event !== 'object') return '';
      if (event.type === 'delta') return String(event.delta || '');
      if (event.type === 'result' || event.type === 'done') return String(event.content || '');
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function summarizeSessionEventsResult(marker, result) {
  const payload = parseJsonObject(stripAnsi(result && result.stdout));
  const parsed = payload && typeof payload === 'object';
  const summary = parsed && payload.summary && typeof payload.summary === 'object' ? payload.summary : {};
  const resultBody = parsed && payload.result && typeof payload.result === 'object' ? payload.result : {};
  const events = Array.isArray(resultBody.events) ? resultBody.events : [];
  const outputText = getSessionOutputEventText(events);
  const runtimeBlocks = events
    .filter((event) => event && event.type === 'runtime-blocked')
    .map((event) => ({
      provider: String(event.provider || ''),
      accountId: String(event.accountId || ''),
      status: String(event.status || ''),
      reason: String(event.reason || '')
    }));
  return {
    status: Number(result && result.status) || 0,
    parsed,
    ok: Boolean(parsed && payload.ok === true),
    markerFound: Boolean(marker && outputText.includes(marker) && runtimeBlocks.length === 0),
    runtimeBlocked: runtimeBlocks.length > 0,
    runtimeBlocks,
    completed: Boolean(summary.completed || resultBody.completed || resultBody.status === 'completed'),
    cursor: Number(summary.cursor || resultBody.cursor) || 0,
    eventCount: Number(summary.eventCount) || events.length,
    eventTypes: summary.eventTypes || {},
    blockers: parsed && Array.isArray(payload.blockers) ? payload.blockers.map((item) => String(item || '')).filter(Boolean) : [],
    error: parsed ? String(payload.error || '') : 'session_events_json_parse_failed'
  };
}

async function runProviderSessionAttempt(options, provider, runLocalCliFn, deps = {}) {
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const marker = `AIH_RUNTIME_REVALIDATE_${provider.toUpperCase()}_${Date.now()}`;
  const startAttempts = [];
  let summary = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const startResult = await runLocalCliFn([
      'bin/ai-home.js',
      'fabric',
      'session',
      'start',
      options.nodeId,
      '--provider',
      provider,
      '--prompt',
      `Reply with ${marker} only.`,
      '--timeout-ms',
      '120000',
      '--json'
    ]);
    summary = summarizeSessionStartResult(provider, marker, startResult);
    summary.startAttempts = attempt;
    startAttempts.push({
      attempt,
      ok: summary.ok,
      status: summary.status,
      sessionStartStatus: summary.http.sessionStartStatus,
      runId: summary.runId,
      blockers: summary.blockers
    });
    if (!isRetryableSessionStartResult(summary)) break;
    if (attempt < 4) await sleep(5000);
  }
  summary.startHistory = startAttempts;
  if (!summary.runId) return summary;

  let latestEvents = null;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const eventsResult = await runLocalCliFn([
      'bin/ai-home.js',
      'fabric',
      'session',
      'events',
      options.nodeId,
      '--run-id',
      summary.runId,
      '--limit',
      '100',
      '--timeout-ms',
      '30000',
      '--json'
    ]);
    latestEvents = summarizeSessionEventsResult(marker, eventsResult);
    latestEvents.attempts = attempt;
    if (latestEvents.markerFound || latestEvents.completed) break;
    if (attempt < 6) await sleep(5000);
  }
  summary.events = latestEvents;
  if (latestEvents) {
    summary.markerFound = latestEvents.markerFound === true;
    if (latestEvents.runtimeBlocked === true) summary.blocked = true;
  }
  if (latestEvents && latestEvents.completed !== true) {
    const stopResult = await runLocalCliFn([
      'bin/ai-home.js',
      'fabric',
      'session',
      'stop',
      options.nodeId,
      '--run-id',
      summary.runId,
      '--timeout-ms',
      '30000',
      '--json'
    ]);
    summary.stop = {
      status: Number(stopResult && stopResult.status) || 0,
      parsed: Boolean(parseJsonObject(stripAnsi(stopResult && stopResult.stdout)))
    };
  }
  return summary;
}

function summarizeProviderAttempt(item) {
  const events = item && item.events && typeof item.events === 'object' ? item.events : {};
  return {
    sessionAttempt: Number(item && item.sessionAttempt) || 0,
    accountId: String(item && item.accountId || ''),
    runId: String(item && item.runId || ''),
    ok: Boolean(item && item.ok === true),
    blocked: Boolean(item && item.blocked === true),
    markerFound: Boolean(item && item.markerFound === true),
    startAttempts: Number(item && item.startAttempts) || 0,
    transportKind: String(item && item.transportKind || ''),
    fallbackUsed: Boolean(item && item.fallbackUsed === true),
    runtimeBlocks: Array.isArray(events.runtimeBlocks) ? events.runtimeBlocks : [],
    blockers: Array.isArray(item && item.blockers) ? item.blockers : []
  };
}

function hasRuntimeBlockEvidence(item) {
  if (!item || typeof item !== 'object') return false;
  if (Array.isArray(item.providerRuntimeBlocks) && item.providerRuntimeBlocks.length > 0) return true;
  const events = item.events && typeof item.events === 'object' ? item.events : {};
  if (Array.isArray(events.runtimeBlocks) && events.runtimeBlocks.length > 0) return true;
  return (Array.isArray(item.providerAttemptHistory) ? item.providerAttemptHistory : [])
    .some((attempt) => Array.isArray(attempt && attempt.runtimeBlocks) && attempt.runtimeBlocks.length > 0);
}

function uniqueProviders(items) {
  return Array.from(new Set(items
    .map((item) => String(item && item.provider || '').trim())
    .filter(Boolean)));
}

async function runProviderSessionStartGuard(options, provider, runLocalCliFn, deps = {}) {
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const maxSessionRuns = Math.max(1, Math.min(Number(deps.maxSessionRuns) || 1, 20));
  const attempts = [];

  for (let sessionAttempt = 1; sessionAttempt <= maxSessionRuns; sessionAttempt += 1) {
    const summary = await runProviderSessionAttempt(options, provider, runLocalCliFn, deps);
    summary.sessionAttempt = sessionAttempt;
    attempts.push(summary);

    if (summary.markerFound === true) break;
    if (summary.parsed !== true) break;
    if (summary.blocked !== true) break;
    if (!summary.runId) break;
    if (sessionAttempt < maxSessionRuns) await sleep(1000);
  }

  const finalSummary = attempts[attempts.length - 1] || {
    provider,
    parsed: false,
    ok: false,
    blocked: false,
    markerFound: false,
    error: 'session_guard_not_run'
  };
  finalSummary.providerAttemptCount = attempts.length;
  finalSummary.providerAttemptLimit = maxSessionRuns;
  finalSummary.providerAttemptHistory = attempts.map(summarizeProviderAttempt);
  finalSummary.providerRuntimeBlocks = attempts
    .flatMap((item) => item && item.events && Array.isArray(item.events.runtimeBlocks) ? item.events.runtimeBlocks : []);
  return finalSummary;
}

function buildRevalidationConclusion(report) {
  const starts = Array.isArray(report.sessionStarts) ? report.sessionStarts : [];
  const acceptedStarts = starts.filter((item) => item && item.ok === true);
  const validatedStarts = starts.filter((item) => item && item.markerFound === true && item.blocked !== true);
  const blockedStarts = starts.filter((item) => item && (item.blocked === true || hasRuntimeBlockEvidence(item)));
  const transportUnavailableStarts = starts.filter((item) => isRetryableSessionStartResult(item));
  const finalBlocked = getRuntimeBlockedCount(report.postSessionAudit || report.postClearAudit || report.remoteAudit);
  const finalReasons = getProviderRuntimeReasons(report.postSessionAudit || report.postClearAudit || report.remoteAudit);
  let status = 'revalidation_complete';
  if (acceptedStarts.length > 0) status = 'provider_session_started';
  if (validatedStarts.length > 0) status = 'provider_session_validated';
  if (validatedStarts.length === 0 && (finalBlocked > 0 || blockedStarts.length > 0)) status = 'credentials_still_invalid';
  if (validatedStarts.length === 0 && transportUnavailableStarts.length > 0) status = 'remote_transport_unavailable';
  if (starts.some((item) => !item || item.parsed !== true)) status = 'session_guard_parse_failed';
  return {
    status,
    providersAttempted: starts.length,
    providersStarted: uniqueProviders(acceptedStarts),
    providersValidated: uniqueProviders(validatedStarts),
    providersBlocked: uniqueProviders(blockedStarts),
    providersTransportUnavailable: uniqueProviders(transportUnavailableStarts),
    finalRuntimeBlocked: finalBlocked,
    finalRuntimeReasons: finalReasons
  };
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`[fabric-runtime-account-activation] mode=${report.mode} node=${report.target.nodeId}`);
  if (report.localArchive) {
    console.log(`[fabric-runtime-account-activation] accounts_zip bytes=${report.localArchive.bytes} sha256=${report.localArchive.sha256}`);
  } else {
    console.log('[fabric-runtime-account-activation] accounts_zip=not_created');
  }
  if (report.localArchive && report.localArchive.exportSummary) {
    const summary = report.localArchive.exportSummary;
    console.log(`[fabric-runtime-account-activation] local_export providers=${summary.providers.join(',')} accounts=${summary.accounts} files=${summary.files} skipped=${summary.skipped}`);
  }
  if (report.remoteAudit) {
    const summary = report.remoteAudit.summary || {};
    const target = report.remoteAudit.target || {};
    console.log(`[fabric-runtime-account-activation] remote_audit deployed=${target.deployedGitHead || ''} db_present=${Boolean(summary.dbPresent)} state_rows=${Number(summary.stateRows) || 0} profiles=${Number(summary.profileCount) || 0} runtime_blocked=${Number(summary.runtimeBlocked) || 0} clearable=${Number(summary.clearableRuntimeBlocks) || 0}`);
    (Array.isArray(report.remoteAudit.providers) ? report.remoteAudit.providers : []).forEach((item) => {
      const reasons = (Array.isArray(item.runtimeReasonCounts) ? item.runtimeReasonCounts : [])
        .map((row) => `${row.reason}=${row.count}`)
        .join(',');
      console.log(`[fabric-runtime-account-activation] remote_provider ${item.provider} profiles=${Number(item.profileCount) || 0} state_rows=${Number(item.stateRows) || 0} runtime_blocked=${Number(item.runtimeBlocked) || 0} clearable=${Number(item.clearableRuntimeBlocks) || 0}${reasons ? ` reasons=${reasons}` : ''}`);
    });
    console.log('[fabric-runtime-account-activation] remote_transfer=skipped');
    console.log('[fabric-runtime-account-activation] next=after credential-transfer confirmation, run --remote-dry-run --yes then --apply --yes');
    return;
  }
  if (report.mode === 'remote-revalidate') {
    const beforeBlocked = getRuntimeBlockedCount(report.remoteAudit);
    const afterClearBlocked = getRuntimeBlockedCount(report.postClearAudit);
    const afterSessionBlocked = getRuntimeBlockedCount(report.postSessionAudit);
    console.log(`[fabric-runtime-account-activation] revalidate before_runtime_blocked=${beforeBlocked} cleared=${Number(report.runtimeBlockClear && report.runtimeBlockClear.cleared) || 0} after_clear_blocked=${afterClearBlocked} after_session_blocked=${afterSessionBlocked}`);
    (Array.isArray(report.sessionStarts) ? report.sessionStarts : []).forEach((item) => {
      console.log(`[fabric-runtime-account-activation] session_guard ${item.provider} ok=${Boolean(item.ok)} blocked=${Boolean(item.blocked)} status=${Number(item.status) || 0} session_start=${item.http && item.http.sessionStartStatus || 0} blockers=${(item.blockers || []).join(',')}`);
    });
    console.log(`[fabric-runtime-account-activation] conclusion=${report.conclusion && report.conclusion.status || ''}`);
    return;
  }
  if (!report.remote) {
    console.log('[fabric-runtime-account-activation] remote_transfer=skipped');
    console.log('[fabric-runtime-account-activation] next=rerun with --remote-dry-run --yes, then --apply --yes after review');
    return;
  }
  console.log(`[fabric-runtime-account-activation] remote_archive=${report.remote.archivePath} cleaned=${report.remote.cleaned}`);
  console.log(`[fabric-runtime-account-activation] remote_dry_run imported=${report.remote.dryRun.imported} duplicates=${report.remote.dryRun.duplicates} invalid=${report.remote.dryRun.invalid} failed=${report.remote.dryRun.failed}`);
  if (report.remote.apply) {
    console.log(`[fabric-runtime-account-activation] remote_apply imported=${report.remote.apply.imported} duplicates=${report.remote.apply.duplicates} invalid=${report.remote.apply.invalid} failed=${report.remote.apply.failed}`);
    if (report.runtimeBlockClear) {
      console.log(`[fabric-runtime-account-activation] runtime_block_clear ok=${Boolean(report.runtimeBlockClear.ok)} cleared=${Number(report.runtimeBlockClear.cleared) || 0} skipped=${Number(report.runtimeBlockClear.skipped) || 0}`);
    }
    if (report.managementReload) {
      console.log(`[fabric-runtime-account-activation] management_reload ok=${Boolean(report.managementReload.ok)} reloaded=${Number(report.managementReload.reloaded) || 0}`);
    }
    if (report.registryPublish) {
      console.log(`[fabric-runtime-account-activation] registry_publish ok=${Boolean(report.registryPublish.ok)} runtimes=${Number(report.registryPublish.runtimes) || 0} providers=${(report.registryPublish.providers || []).join(',')}`);
    }
    console.log(`[fabric-runtime-account-activation] registry ok=${report.registry.ok} runtimeHost=${report.registry.node && report.registry.node.runtimeHost} providers=${(report.registry.node && report.registry.node.runtimeProviders || []).join(',')}`);
  }
}

async function runActivation(options, deps = {}) {
  const runRemoteFn = typeof deps.runRemote === 'function' ? deps.runRemote : runRemote;
  const copyToRemoteFn = typeof deps.copyToRemote === 'function' ? deps.copyToRemote : copyToRemote;
  const runLocalCliFn = typeof deps.runLocalCli === 'function'
    ? deps.runLocalCli
    : ((args) => runCaptureStatus(process.execPath, args, { cwd: process.cwd() }));
  const waitForRuntimeRegistryFn = typeof deps.waitForRuntimeRegistry === 'function'
    ? deps.waitForRuntimeRegistry
    : waitForRuntimeRegistry;
  const auditOnly = options.remoteAudit && !options.remoteDryRun && !options.apply;
  const revalidateOnly = options.remoteRevalidate && !options.remoteDryRun && !options.apply;
  const archive = (auditOnly || revalidateOnly) ? null : await createAccountsZip(options);
  const report = {
    ok: true,
    mode: options.apply ? 'apply' : (options.remoteDryRun ? 'remote-dry-run' : (revalidateOnly ? 'remote-revalidate' : (auditOnly ? 'remote-audit' : 'local-preflight'))),
    target: {
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      nodeId: options.nodeId,
      port: options.port,
      providers: options.providers
    },
    localArchive: archive ? {
      generated: archive.generated,
      bytes: archive.bytes,
      sha256: archive.sha256,
      exportSummary: archive.exportSummary
    } : null,
    remote: null,
    remoteAudit: null,
    postClearAudit: null,
    postSessionAudit: null,
    sessionStarts: [],
    conclusion: null,
    runtimeBlockClear: null,
    managementReload: null,
    registryPublish: null,
    readyz: null,
    registry: null
  };

  try {
    if (auditOnly) {
      const audited = await runRemoteFn(options, buildRemoteRuntimeAuditCommand(options));
      report.remoteAudit = parseJsonObject(audited.stdout);
      const readyz = await runRemoteFn(options, buildRemoteReadyzCommand(options));
      report.readyz = parseReadyz(readyz.stdout);
      if (!report.remoteAudit || report.remoteAudit.ok === false) report.ok = false;
      return report;
    }

    if (revalidateOnly) {
      const beforeAudit = await runRemoteFn(options, buildRemoteRuntimeAuditCommand(options));
      report.remoteAudit = parseJsonObject(beforeAudit.stdout);
      const clearableBefore = getClearableRuntimeBlockCount(report.remoteAudit);
      const cleared = await runRemoteFn(options, buildRemoteRuntimeBlockClearCommand(options));
      report.runtimeBlockClear = parseJsonObject(cleared.stdout);
      const reloaded = await runRemoteFn(options, buildRemoteManagementReloadCommand(options));
      report.managementReload = parseJsonObject(reloaded.stdout);
      const published = await runRemoteFn(options, buildRemoteRegistryPublishCommand(options));
      report.registryPublish = parseJsonObject(published.stdout);
      const readyz = await runRemoteFn(options, buildRemoteReadyzCommand(options));
      report.readyz = parseReadyz(readyz.stdout);
      report.registry = await waitForRuntimeRegistryFn(options, { attempts: 10, delayMs: 3000 });
      const afterClearAudit = await runRemoteFn(options, buildRemoteRuntimeAuditCommand(options));
      report.postClearAudit = parseJsonObject(afterClearAudit.stdout);
      for (const provider of options.providers) {
        const maxSessionRuns = getProviderProfileCount(report.postClearAudit, provider) || 1;
        report.sessionStarts.push(await runProviderSessionStartGuard(options, provider, runLocalCliFn, {
          ...deps,
          maxSessionRuns
        }));
      }
      const afterSessionAudit = await runRemoteFn(options, buildRemoteRuntimeAuditCommand(options));
      report.postSessionAudit = parseJsonObject(afterSessionAudit.stdout);
      report.conclusion = buildRevalidationConclusion(report);
      if (!report.remoteAudit || !report.postClearAudit || !report.postSessionAudit) report.ok = false;
      if (!report.runtimeBlockClear || report.runtimeBlockClear.ok === false) report.ok = false;
      if (Number(report.runtimeBlockClear && report.runtimeBlockClear.cleared) < clearableBefore) report.ok = false;
      if (!report.managementReload || report.managementReload.ok === false) report.ok = false;
      if (!report.registryPublish || report.registryPublish.ok === false) report.ok = false;
      if (!report.registry || report.registry.ok !== true) report.ok = false;
      if (report.sessionStarts.some((item) => !item || item.parsed !== true)) report.ok = false;
      return report;
    }

    if (!options.remoteDryRun && !options.apply) return report;

    const remoteZip = buildRemoteArchivePath(options, archive);
    await copyToRemoteFn(options, archive.path, remoteZip);
    const dryRun = await runRemoteFn(options, buildRemoteImportCommand(options, remoteZip, { dryRun: true }));
    report.remote = {
      archivePath: remoteZip,
      cleaned: false,
      dryRun: parseAihImportSummary(dryRun.stdout),
      apply: null
    };

    if (options.apply) {
      const applied = await runRemoteFn(options, buildRemoteImportCommand(options, remoteZip, { dryRun: false }));
      report.remote.apply = parseAihImportSummary(applied.stdout);
      const cleared = await runRemoteFn(options, buildRemoteRuntimeBlockClearCommand(options));
      report.runtimeBlockClear = parseJsonObject(cleared.stdout);
      const reloaded = await runRemoteFn(options, buildRemoteManagementReloadCommand(options));
      report.managementReload = parseJsonObject(reloaded.stdout);
      const published = await runRemoteFn(options, buildRemoteRegistryPublishCommand(options));
      report.registryPublish = parseJsonObject(published.stdout);
      const readyz = await runRemoteFn(options, buildRemoteReadyzCommand(options));
      report.readyz = parseReadyz(readyz.stdout);
      report.registry = await waitForRuntimeRegistryFn(options, { attempts: 10, delayMs: 3000 });
      if (!report.registry.ok) report.ok = false;
    }

    if (!options.keepRemoteArchive) {
      await runRemoteFn(options, buildRemoteCleanupCommand(remoteZip));
      report.remote.cleaned = true;
    }
    return report;
  } finally {
    if (archive && archive.generated && archive.tempDir) {
      fs.rmSync(archive.tempDir, { recursive: true, force: true });
    }
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runActivation(options);
  printReport(report, options.json);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-runtime-account-activation] ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_PROVIDERS,
  buildLocalExportArgs,
  buildRemoteCleanupCommand,
  buildRemoteEnvCommand,
  buildRemoteImportCommand,
  buildRemoteManagementReloadCommand,
  buildRemoteRuntimeAuditCommand,
  buildRemoteRuntimeBlockClearCommand,
  buildRemoteRegistryPublishCommand,
  buildRemoteReadyzCommand,
  parseAihExportSummary,
  parseAihImportSummary,
  parseArgs,
  parseProviders,
  runActivation,
  summarizeFabricNode
};
