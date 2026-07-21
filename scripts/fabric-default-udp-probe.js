#!/usr/bin/env node
'use strict';

const path = require('node:path');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const {
  buildSshArgs,
  shQuote
} = require('./fabric-real-vps-deploy');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_PORT = 9527;
const DEFAULT_UDP_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_PACKET_CAPTURE_READY_TIMEOUT_MS = 2500;

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeHttpUrl(value, flag = '--endpoint') {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function trimOutput(value, maxLength = 4096) {
  const text = String(value || '').trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function shouldRunTargetCommandLocally(options = {}, deps = {}) {
  if (options.runTargetCommandLocally === true || deps.runTargetCommandLocally === true) return true;
  const remoteDir = path.resolve(options.remoteDir || DEFAULT_REMOTE_DIR);
  const cwd = path.resolve(deps.cwd || process.cwd());
  return cwd === remoteDir;
}

function getTargetCommandExecutionContext(options = {}, deps = {}) {
  const remoteDir = path.resolve(options.remoteDir || DEFAULT_REMOTE_DIR);
  const cwd = path.resolve(deps.cwd || process.cwd());
  const local = shouldRunTargetCommandLocally(options, deps);
  return {
    commandMode: local ? 'local' : 'ssh',
    proofScope: local ? 'target_local' : 'client_to_target',
    cwd,
    remoteDir
  };
}

function spawnTargetCommand(options = {}, deps = {}, command = '') {
  const spawnImpl = deps.spawn || spawn;
  const env = deps.env || process.env;
  if (getTargetCommandExecutionContext(options, deps).commandMode === 'local') {
    return spawnImpl('sh', ['-lc', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
  }
  return spawnImpl('ssh', [
    ...buildSshArgs(options),
    options.sshTarget,
    command
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env
  });
}

function isUdpProbeBusy(value) {
  return /\bEADDRINUSE\b|address already in use|bind .*:9527/i.test(String(value || ''));
}

function defaultUdpProbeFailureBlocker(ready, port = DEFAULT_PORT) {
  if (ready && ready.ready) return `turn_default_udp_${Number(port) || DEFAULT_PORT}_unreachable`;
  if (isUdpProbeBusy(ready && ready.error)) return 'turn_default_udp_probe_busy';
  return 'turn_default_udp_probe_failed';
}

function defaultUdpProbeBlockers(ready, local, executionContext, port = DEFAULT_PORT) {
  if (ready && ready.ready && local && local.ok && executionContext.proofScope === 'client_to_target') return [];
  if (ready && ready.ready && local && local.ok && executionContext.proofScope === 'target_local') {
    return ['turn_default_udp_target_local_only'];
  }
  return [defaultUdpProbeFailureBlocker(ready, port)];
}

function buildRemoteUdpEchoCommand(options = {}, token = '', holdMs = 10000) {
  const nodePath = path.posix.join(
    options.remoteDir || DEFAULT_REMOTE_DIR,
    '.node-runtime',
    'node-v22.16.0-linux-x64',
    'bin',
    'node'
  );
  const script = [
    "const d=require('node:dgram')",
    'const port=Number(process.argv[1])',
    'const token=String(process.argv[2]||\'\')',
    'const holdMs=Number(process.argv[3])||10000',
    "const socket=d.createSocket('udp4')",
    "let ready=false",
    "socket.on('message',(message,remote)=>{",
    "if(String(message)!==token)return",
    "socket.send(Buffer.from(token+':ok'),remote.port,remote.address)",
    '})',
    "socket.on('error',(error)=>{",
    "console.log(JSON.stringify({event:'error',message:String(error&&error.message||error)}))",
    'process.exit(1)',
    '})',
    "socket.bind(port,'0.0.0.0',()=>{",
    'ready=true',
    "console.log(JSON.stringify({event:'ready',port}))",
    '})',
    'setTimeout(()=>{',
    "if(!ready)process.exit(2)",
    'socket.close(()=>process.exit(0))',
    '},holdMs)'
  ].join(';');
  const prefix = [
    `cd ${shQuote(options.remoteDir || DEFAULT_REMOTE_DIR)}`,
    `NODE=${shQuote(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi'
  ].join(' && ');
  const command = [
    '"$NODE"',
    '-e',
    shQuote(script),
    shQuote(String(options.port || DEFAULT_PORT)),
    shQuote(token),
    shQuote(String(holdMs))
  ].join(' ');
  return `${prefix} && ${command}`;
}

function buildRemoteUdpPacketCaptureCommand(options = {}, holdMs = 7000) {
  const nodePath = path.posix.join(
    options.remoteDir || DEFAULT_REMOTE_DIR,
    '.node-runtime',
    'node-v22.16.0-linux-x64',
    'bin',
    'node'
  );
  const script = [
    "const {spawn}=require('node:child_process')",
    'const port=Number(process.argv[1])',
    'const holdMs=Number(process.argv[2])||7000',
    "const preferred=String(process.argv[3]||'')",
    'const startedAt=Date.now()',
    'const max=(value,n=2048)=>String(value||\'\').trim().slice(0,n)',
    'const emit=(payload)=>console.log(JSON.stringify(payload))',
    'const finish=(payload)=>emit(Object.assign({event:\'capture-result\',durationMs:Date.now()-startedAt},payload))',
    'const pickInterface=(done)=>{',
    'if(preferred){done(preferred);return}',
    "const child=spawn('sh',['-lc',\"ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i==\\\"dev\\\"){print $(i+1); exit}}'\"])",
    "let out=''",
    "child.stdout.on('data',(chunk)=>{out+=Buffer.from(chunk).toString('utf8')})",
    "child.on('close',()=>done(out.trim()||'any'))",
    "child.on('error',()=>done('any'))",
    '}',
    'pickInterface((iface)=>{',
    "const seconds=String(Math.max(2,Math.ceil(holdMs/1000)))",
    "const args=['-n','timeout',seconds,'tcpdump','-U','-l','-nn','-i',iface,'-c','1','udp','and','port',String(port)]",
    "const child=spawn('sudo',args)",
    "let stdout=''",
    "let stderr=''",
    'let ready=false',
    "const readyTimer=setTimeout(()=>{if(!ready)emit({event:'capture-ready',ready:false,available:false,reason:'tcpdump_ready_timeout',interface:iface,port})},1500)",
    "child.stdout.on('data',(chunk)=>{stdout+=Buffer.from(chunk).toString('utf8')})",
    "child.stderr.on('data',(chunk)=>{",
    "stderr+=Buffer.from(chunk).toString('utf8')",
    "if(!ready&&/listening on /.test(stderr)){ready=true;clearTimeout(readyTimer);emit({event:'capture-ready',ready:true,available:true,interface:iface,port})}",
    '})',
    "child.on('error',(error)=>{clearTimeout(readyTimer);emit({event:'capture-ready',ready:false,available:false,reason:'spawn_failed',interface:iface,port});finish({available:false,captured:false,interface:iface,port,error:max(error&&error.message||error,512)})})",
    "child.on('close',(status,signal)=>{",
    'clearTimeout(readyTimer)',
    "const packetLines=stdout.split(/\\r?\\n/).map((line)=>line.trim()).filter(Boolean)",
    "const unavailable=/not found|a password is required|sudo:|permission denied/i.test(stderr)&&packetLines.length===0",
    "finish({available:!unavailable,captured:packetLines.length>0,interface:iface,port,status,signal:signal||'',packets:packetLines.slice(0,3),stdout:max(stdout,2048),stderr:max(stderr,2048)})",
    '})',
    '})'
  ].join(';');
  const prefix = [
    `cd ${shQuote(options.remoteDir || DEFAULT_REMOTE_DIR)}`,
    `NODE=${shQuote(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi'
  ].join(' && ');
  const command = [
    '"$NODE"',
    '-e',
    shQuote(script),
    shQuote(String(options.port || DEFAULT_PORT)),
    shQuote(String(holdMs)),
    shQuote(String(options.udpPacketCaptureInterface || ''))
  ].join(' ');
  return `${prefix} && ${command}`;
}

function buildRemoteUdpEdgeSnapshotCommand(options = {}) {
  const nodePath = path.posix.join(
    options.remoteDir || DEFAULT_REMOTE_DIR,
    '.node-runtime',
    'node-v22.16.0-linux-x64',
    'bin',
    'node'
  );
  const script = [
    "const {spawnSync}=require('node:child_process')",
    'const port=Number(process.argv[1])',
    'const max=(value,n=4096)=>String(value||\'\').trim().slice(0,n)',
    'const run=(cmd,args=[],timeoutMs=3000)=>{',
    "const result=spawnSync(cmd,args,{encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024})",
    "return {status:typeof result.status==='number'?result.status:1,stdout:max(result.stdout),stderr:max(result.stderr)}",
    '}',
    "const sh=(command,timeoutMs=3000)=>run('sh',['-lc',command],timeoutMs)",
    "const route=sh('ip route get 1.1.1.1 2>/dev/null | head -1')",
    "const ifaceMatch=route.stdout.match(/\\bdev\\s+(\\S+)/)",
    "const srcMatch=route.stdout.match(/\\bsrc\\s+(\\S+)/)",
    "const iface=ifaceMatch?ifaceMatch[1]:''",
    "const addr=sh('ip -br addr show 2>/dev/null')",
    "const ufw=sh('sudo -n ufw status 2>/dev/null')",
    "const iptablesInput=sh('sudo -n iptables -S INPUT 2>/dev/null')",
    "const iptablesUdp=sh(`sudo -n iptables -S 2>/dev/null | grep -E \"udp|${port}\" || true`)",
    "const nft=sh(`sudo -n nft list ruleset 2>/dev/null | grep -Ei \"udp|${port}|drop|reject|policy\" | head -40 || true`)",
    "const imdsToken=sh('curl -sS --connect-timeout 1 -m 2 -X PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 60\" 2>/dev/null')",
    "const token=imdsToken.stdout",
    "const meta=(path)=>token?sh(`curl -sS --connect-timeout 1 -m 2 -H \"X-aws-ec2-metadata-token: ${token}\" \"http://169.254.169.254/latest/meta-data/${path}\" 2>/dev/null`):{status:1,stdout:'',stderr:'imds_token_missing'}",
    "const mac=meta('mac').stdout",
    "const imds={tokenAvailable:Boolean(token),instanceId:meta('instance-id').stdout,publicIpv4:meta('public-ipv4').stdout,securityGroups:meta('security-groups').stdout.split(/\\r?\\n/).filter(Boolean),mac,vpcId:mac?meta(`network/interfaces/macs/${mac}/vpc-id`).stdout:'',subnetId:mac?meta(`network/interfaces/macs/${mac}/subnet-id`).stdout:'',securityGroupIds:mac?meta(`network/interfaces/macs/${mac}/security-group-ids`).stdout.split(/\\r?\\n/).filter(Boolean):[]}",
    "const inputAccept=/(^|;)\\s*-P\\s+INPUT\\s+ACCEPT\\b/.test(iptablesInput.stdout.replace(/\\n/g,';'))",
    "const ufwInactive=/Status:\\s+inactive/i.test(ufw.stdout)",
    "const hostFirewallBlocksUdp=/DROP|REJECT|DENY/i.test([iptablesUdp.stdout,nft.stdout].join('\\n'))",
    'console.log(JSON.stringify({ran:true,route:route.stdout,interface:iface,sourceAddress:srcMatch?srcMatch[1]:"",addresses:addr.stdout,firewall:{ufw:ufw.stdout,iptablesInput:iptablesInput.stdout,iptablesUdp:iptablesUdp.stdout,nft:nft.stdout,inputPolicyAccept:inputAccept,ufwInactive,hostFirewallBlocksUdp},imds,summary:{interface:iface,privateAddress:srcMatch?srcMatch[1]:"",publicIpv4:imds.publicIpv4,securityGroups:imds.securityGroups,securityGroupIds:imds.securityGroupIds,hostFirewallBlocksUdp}}))'
  ].join(';');
  const prefix = [
    `cd ${shQuote(options.remoteDir || DEFAULT_REMOTE_DIR)}`,
    `NODE=${shQuote(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi'
  ].join(' && ');
  const command = [
    '"$NODE"',
    '-e',
    shQuote(script),
    shQuote(String(options.port || DEFAULT_PORT))
  ].join(' ');
  return `${prefix} && ${command}`;
}

function waitForRemoteUdpReady(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      finish({
        ready: false,
        error: 'remote_udp_echo_ready_timeout'
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        try {
          const payload = JSON.parse(line);
          if (payload && payload.event === 'ready') {
            finish({ ready: true, port: Number(payload.port) || 0 });
            return;
          }
          if (payload && payload.event === 'error') {
            finish({ ready: false, error: normalizeText(payload.message, 512) || 'remote_udp_echo_error' });
            return;
          }
        } catch (_error) {
          // Ignore non-JSON shell noise; SSH stderr is still captured below.
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', (error) => {
      finish({ ready: false, error: String(error && error.message || error || 'remote_udp_echo_spawn_failed') });
    });
    child.on('close', (status, signal) => {
      if (!settled) {
        finish({
          ready: false,
          status,
          signal,
          error: `remote_udp_echo_exited_${status == null ? 'signal' : status}`
        });
      }
    });
  });
}

async function runRemoteUdpEdgeSnapshot(options = {}, deps = {}) {
  const remoteCommand = buildRemoteUdpEdgeSnapshotCommand(options);
  return new Promise((resolve) => {
    const child = spawnTargetCommand(options, deps, remoteCommand);
    let stdout = '';
    let stderr = '';
    const startedAt = Date.now();
    const finish = (result) => {
      resolve({
        durationMs: Date.now() - startedAt,
        ...result
      });
    };
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', (error) => finish({
      ran: true,
      ok: false,
      error: normalizeText(error && error.message || error, 512),
      stderr: trimOutput(stderr, 2048)
    }));
    child.on('close', (status, signal) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        finish({
          ok: status === 0,
          status,
          signal,
          ...parsed,
          stderr: trimOutput(stderr, 2048)
        });
      } catch (error) {
        finish({
          ran: true,
          ok: false,
          status,
          signal,
          error: normalizeText(error && error.message || error, 512),
          stdout: trimOutput(stdout, 2048),
          stderr: trimOutput(stderr, 2048)
        });
      }
    });
  });
}

function startRemoteUdpPacketCapture(options = {}, deps = {}, holdMs = 7000) {
  const remoteCommand = buildRemoteUdpPacketCaptureCommand(options, holdMs);
  const child = spawnTargetCommand(options, deps, remoteCommand);
  let stdout = '';
  let stderr = '';
  let readySettled = false;
  let resultSettled = false;
  let latestReady = null;
  let latestResult = null;
  let lineBuffer = '';

  const ready = new Promise((resolve) => {
    const finishReady = (payload) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      latestReady = payload;
      resolve(payload);
    };
    const readyTimer = setTimeout(() => finishReady({
      ready: false,
      available: false,
      reason: 'packet_capture_ready_timeout'
    }), DEFAULT_PACKET_CAPTURE_READY_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = Buffer.from(chunk).toString('utf8');
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      lines.map((line) => line.trim()).filter(Boolean).forEach((line) => {
        try {
          const payload = JSON.parse(line);
          if (payload.event === 'capture-ready') finishReady(payload);
          if (payload.event === 'capture-result') latestResult = payload;
        } catch (_error) {
          // Ignore remote shell noise; raw stdout/stderr remain attached below.
        }
      });
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', (error) => finishReady({
      ready: false,
      available: false,
      reason: 'packet_capture_spawn_failed',
      error: normalizeText(error && error.message || error, 512)
    }));
    child.on('close', () => {
      if (lineBuffer.trim()) {
        try {
          const payload = JSON.parse(lineBuffer.trim());
          if (payload.event === 'capture-ready') finishReady(payload);
          if (payload.event === 'capture-result') latestResult = payload;
        } catch (_error) {
          // Ignore non-JSON tail output.
        }
      }
      finishReady(latestReady || {
        ready: false,
        available: false,
        reason: 'packet_capture_closed_before_ready'
      });
    });
  });

  const result = new Promise((resolve) => {
    const finishResult = () => {
      if (resultSettled) return;
      resultSettled = true;
      const resultHasStdout = latestResult && Object.prototype.hasOwnProperty.call(latestResult, 'stdout');
      const resultHasStderr = latestResult && Object.prototype.hasOwnProperty.call(latestResult, 'stderr');
      resolve({
        ran: true,
        ready: Boolean(latestReady && latestReady.ready),
        available: latestResult ? latestResult.available !== false : false,
        captured: Boolean(latestResult && latestResult.captured),
        interface: latestResult && latestResult.interface || latestReady && latestReady.interface || '',
        port: Number(latestResult && latestResult.port || latestReady && latestReady.port || options.port || DEFAULT_PORT),
        status: latestResult && Object.prototype.hasOwnProperty.call(latestResult, 'status') ? latestResult.status : null,
        signal: latestResult && latestResult.signal || '',
        packets: latestResult && Array.isArray(latestResult.packets) ? latestResult.packets : [],
        durationMs: Number(latestResult && latestResult.durationMs) || 0,
        reason: latestReady && latestReady.reason || '',
        error: normalizeText(latestResult && latestResult.error, 512),
        stdout: trimOutput(resultHasStdout ? latestResult.stdout : stdout, 2048),
        stderr: trimOutput(resultHasStderr ? latestResult.stderr : stderr, 2048)
      });
    };
    child.on('close', finishResult);
    child.on('error', finishResult);
  });

  return { child, ready, result };
}

function runLocalUdpEchoProbe({ host, port, token, timeoutMs, intervalMs = 400 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let sent = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interval);
      try {
        socket.close();
      } catch (_error) {
        // Socket may already be closed by an error event.
      }
      resolve({
        ...result,
        sent,
        durationMs: Date.now() - startedAt
      });
    };
    const sendProbe = () => {
      sent += 1;
      socket.send(Buffer.from(token), port, host, (error) => {
        if (error) finish({ ok: false, error: String(error && error.message || error) });
      });
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'udp_echo_timeout' }), timeoutMs);
    const interval = setInterval(sendProbe, intervalMs);
    socket.on('message', (message, remote) => {
      const text = String(message || '');
      if (text === `${token}:ok`) {
        finish({
          ok: true,
          replyBytes: Buffer.byteLength(message),
          remoteAddress: remote && remote.address || '',
          remotePort: remote && remote.port || 0
        });
      }
    });
    socket.on('error', (error) => finish({ ok: false, error: String(error && error.message || error) }));
    sendProbe();
  });
}

async function runDefaultPortUdpProbe(options = {}, deps = {}) {
  const endpoint = normalizeHttpUrl(options.endpoint || DEFAULT_ENDPOINT, '--endpoint');
  const parsed = new URL(endpoint);
  const host = parsed.hostname;
  const port = Number(options.port) || DEFAULT_PORT;
  const timeoutMs = Number(options.udpProbeTimeoutMs) || DEFAULT_UDP_PROBE_TIMEOUT_MS;
  const token = `aih-udp-${crypto.randomBytes(8).toString('hex')}`;
  const remoteHoldMs = Math.max(timeoutMs + 4000, 9000);
  const remoteCommand = buildRemoteUdpEchoCommand(options, token, remoteHoldMs);
  const startedAt = Date.now();
  const targetExecution = getTargetCommandExecutionContext(options, deps);
  const child = spawnTargetCommand(options, deps, remoteCommand);
  let closeStatus = null;
  let closeSignal = null;
  child.on('close', (status, signal) => {
    closeStatus = status;
    closeSignal = signal;
  });
  const ready = await waitForRemoteUdpReady(child, Math.min(timeoutMs, 5000));
  const edgeSnapshot = options.udpEdgeSnapshot === false
    ? Promise.resolve({ skipped: true, reason: 'udp_edge_snapshot_disabled' })
    : runRemoteUdpEdgeSnapshot(options, deps);
  let local = {
    ok: false,
    error: ready.error || 'remote_udp_echo_not_ready',
    sent: 0,
    durationMs: 0
  };
  let packetCapture = options.udpPacketCapture === false
    ? { skipped: true, reason: 'udp_packet_capture_disabled' }
    : { skipped: true, reason: ready.ready ? 'not_started' : 'remote_udp_echo_not_ready' };
  if (ready.ready) {
    const captureHandle = options.udpPacketCapture === false
      ? null
      : startRemoteUdpPacketCapture(options, deps, Math.max(timeoutMs + 1500, 4000));
    if (captureHandle) await captureHandle.ready;
    local = await runLocalUdpEchoProbe({
      host,
      port,
      token,
      timeoutMs
    });
    if (captureHandle) packetCapture = await captureHandle.result;
  }
  if (child && !child.killed && closeStatus === null) {
    try {
      child.kill('SIGTERM');
    } catch (_error) {
      // Best-effort cleanup for the temporary SSH-held UDP echo process.
    }
  }
  const blockers = defaultUdpProbeBlockers(ready, local, targetExecution, port);
  return {
    ran: true,
    host,
    port,
    timeoutMs,
    targetExecution,
    candidateReady: blockers.length === 0,
    promotionReady: false,
    remote: {
      ready: Boolean(ready.ready),
      port: Number(ready.port) || port,
      status: closeStatus,
      signal: closeSignal,
      error: normalizeText(ready.error, 512),
      stderr: trimOutput(ready.stderr, 2048),
      packetCapture,
      edge: await edgeSnapshot
    },
    local,
    durationMs: Date.now() - startedAt,
    blockers
  };
}

function classifyDefaultPortUdpProbe(report = null, error = null, skipped = false) {
  if (skipped) return { skipped: true, reason: 'skip_turn_udp_probe', blockers: [] };
  if (error) {
    return {
      ran: true,
      candidateReady: false,
      promotionReady: false,
      error: { message: String(error && error.message || error || 'turn_default_udp_probe_failed') },
      blockers: ['turn_default_udp_probe_failed']
    };
  }
  if (!report) return { skipped: true, reason: 'not_run', blockers: [] };
  return {
    ran: report.ran !== false,
    host: report.host || '',
    port: Number(report.port) || DEFAULT_PORT,
    timeoutMs: Number(report.timeoutMs) || 0,
    targetExecution: report.targetExecution || {},
    candidateReady: Boolean(report.candidateReady),
    promotionReady: false,
    remote: report.remote || {},
    local: report.local || {},
    durationMs: Number(report.durationMs) || 0,
    blockers: Array.isArray(report.blockers) ? report.blockers : []
  };
}

module.exports = {
  buildRemoteUdpEchoCommand,
  buildRemoteUdpEdgeSnapshotCommand,
  buildRemoteUdpPacketCaptureCommand,
  classifyDefaultPortUdpProbe,
  defaultUdpProbeBlockers,
  defaultUdpProbeFailureBlocker,
  getTargetCommandExecutionContext,
  isUdpProbeBusy,
  runRemoteUdpEdgeSnapshot,
  runDefaultPortUdpProbe,
  runLocalUdpEchoProbe,
  shouldRunTargetCommandLocally,
  spawnTargetCommand
};
