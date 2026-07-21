#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  shQuote
} = require('./fabric-real-vps-deploy');
const {
  classifyDefaultPortUdpProbe,
  runDefaultPortUdpProbe,
  spawnTargetCommand
} = require('./fabric-default-udp-probe');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_PORT = 9527;
const DEFAULT_UDP_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_AWS_REGION = 'ap-northeast-1';
const DEFAULT_AWS_API_TIMEOUT_MS = 5000;

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
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

function parsePositiveInteger(value, flag, fallback, min = 1, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    port: DEFAULT_PORT,
    udpProbeTimeoutMs: DEFAULT_UDP_PROBE_TIMEOUT_MS,
    awsRegion: DEFAULT_AWS_REGION,
    awsInstanceId: '',
    awsApiTimeoutMs: DEFAULT_AWS_API_TIMEOUT_MS,
    skipUdpProbe: false,
    skipLocalAwsReadback: false,
    failOnBlocked: false
  };

  for (let index = 0; index < argv.length;) {
    const token = normalizeText(argv[index], 256);
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
    if (token === '--skip-udp-probe') {
      options.skipUdpProbe = true;
      index += 1;
      continue;
    }
    if (token === '--skip-local-aws-readback') {
      options.skipLocalAwsReadback = true;
      index += 1;
      continue;
    }
    if (token === '--fail-on-blocked') {
      options.failOnBlocked = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpUrl(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--ssh' || token.startsWith('--ssh=')) {
      const next = readOptionValue(argv, index, '--ssh');
      options.sshTarget = normalizeText(next.value, 512);
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
      options.remoteDir = normalizeText(next.value, 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePositiveInteger(next.value, '--port', DEFAULT_PORT, 1, 65535);
      index += next.consumed;
      continue;
    }
    if (token === '--udp-timeout-ms' || token.startsWith('--udp-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--udp-timeout-ms');
      options.udpProbeTimeoutMs = parsePositiveInteger(next.value, '--udp-timeout-ms', DEFAULT_UDP_PROBE_TIMEOUT_MS, 1000, 60000);
      index += next.consumed;
      continue;
    }
    if (token === '--aws-region' || token.startsWith('--aws-region=')) {
      const next = readOptionValue(argv, index, '--aws-region');
      options.awsRegion = normalizeText(next.value, 64);
      index += next.consumed;
      continue;
    }
    if (token === '--aws-instance-id' || token.startsWith('--aws-instance-id=')) {
      const next = readOptionValue(argv, index, '--aws-instance-id');
      options.awsInstanceId = normalizeText(next.value, 64);
      index += next.consumed;
      continue;
    }
    if (token === '--aws-api-timeout-ms' || token.startsWith('--aws-api-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--aws-api-timeout-ms');
      options.awsApiTimeoutMs = parsePositiveInteger(next.value, '--aws-api-timeout-ms', DEFAULT_AWS_API_TIMEOUT_MS, 1000, 60000);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.endpoint = normalizeHttpUrl(options.endpoint, '--endpoint');
  if (!path.posix.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (!options.sshTarget) throw new Error('--ssh is required');
  if (!options.awsRegion) throw new Error('--aws-region is required');
  return options;
}

function buildRemoteCloudApiSnapshotCommand(options = {}) {
  const nodePath = path.posix.join(
    options.remoteDir || DEFAULT_REMOTE_DIR,
    '.node-runtime',
    'node-v22.16.0-linux-x64',
    'bin',
    'node'
  );
  const script = [
    "const {spawnSync}=require('node:child_process')",
    'const max=(value,n=4096)=>String(value||\'\').trim().slice(0,n)',
    'const run=(cmd,args=[],timeoutMs=3000)=>{',
    "const result=spawnSync(cmd,args,{encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024})",
    "return {status:typeof result.status==='number'?result.status:1,stdout:max(result.stdout),stderr:max(result.stderr)}",
    '}',
    "const sh=(command,timeoutMs=3000)=>run('sh',['-lc',command],timeoutMs)",
    "const awsPath=sh('command -v aws 2>/dev/null || true')",
    "const awsVersion=awsPath.stdout?sh('aws --version 2>&1 || true'): {status:1,stdout:'',stderr:'aws_cli_missing'}",
    "const tokenResult=sh('curl -fsS --connect-timeout 1 -m 2 -X PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 60\" 2>/dev/null || true')",
    'const token=tokenResult.stdout',
    "const meta=(path)=>{",
    "if(!token)return {status:1,httpStatus:0,stdout:'',stderr:'imds_token_missing'}",
    "const result=sh(`curl -sS --connect-timeout 1 -m 2 -w \"\\\\n__HTTP_STATUS__:%{http_code}\" -H \"X-aws-ec2-metadata-token: ${token}\" \"http://169.254.169.254/latest/meta-data/${path}\" 2>/dev/null || true`)",
    "const marker='__HTTP_STATUS__:'",
    "const markerIndex=result.stdout.lastIndexOf(marker)",
    "if(markerIndex<0)return {...result,httpStatus:0}",
    "const body=result.stdout.slice(0,markerIndex).trim()",
    "const httpStatus=Number(result.stdout.slice(markerIndex+marker.length).trim())||0",
    "return {status:result.status,httpStatus,stdout:body,stderr:result.stderr}",
    "}",
    "const roleNamesRaw=meta('iam/security-credentials/')",
    "const roleNames=roleNamesRaw.httpStatus===200?roleNamesRaw.stdout.split(/\\r?\\n/).map((line)=>line.trim()).filter(Boolean):[]",
    "const iamRoleAvailable=roleNamesRaw.httpStatus===200&&roleNames.length>0",
    "const blockers=[]",
    "if(!awsPath.stdout)blockers.push('aws_cli_missing')",
    "if(!iamRoleAvailable)blockers.push('aws_iam_role_missing')",
    "console.log(JSON.stringify({ran:true,awsCli:{available:Boolean(awsPath.stdout),path:awsPath.stdout,version:awsVersion.stdout||awsVersion.stderr},imds:{tokenAvailable:Boolean(token),iamRoleAvailable,iamRoleNames:roleNames,iamRoleProbeStatus:roleNamesRaw.status,iamRoleProbeHttpStatus:roleNamesRaw.httpStatus||0,iamRoleProbeStderr:roleNamesRaw.stderr},apiReadback:{attempted:false,reason:'aws_api_readback_not_requested'},summary:{awsApiCredentialsReady:Boolean(awsPath.stdout)&&iamRoleAvailable},blockers}))"
  ].join(';');
  const prefix = [
    `cd ${shQuote(options.remoteDir || DEFAULT_REMOTE_DIR)}`,
    `NODE=${shQuote(nodePath)}`,
    'if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi'
  ].join(' && ');
  const command = [
    '"$NODE"',
    '-e',
    shQuote(script)
  ].join(' ');
  return `${prefix} && ${command}`;
}

async function runRemoteCloudApiSnapshot(options = {}, deps = {}) {
  const remoteCommand = buildRemoteCloudApiSnapshotCommand(options);
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
      stderr: normalizeText(stderr, 2048),
      blockers: ['aws_cloud_api_probe_failed']
    }));
    child.on('close', (status, signal) => {
      try {
        const parsed = JSON.parse(stdout.trim());
        finish({
          ok: status === 0,
          status,
          signal,
          ...parsed,
          stderr: normalizeText(stderr, 2048)
        });
      } catch (error) {
        finish({
          ran: true,
          ok: false,
          status,
          signal,
          error: normalizeText(error && error.message || error, 512),
          stdout: normalizeText(stdout, 2048),
          stderr: normalizeText(stderr, 2048),
          blockers: ['aws_cloud_api_probe_failed']
        });
      }
    });
  });
}

function redactSensitiveText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value)
    .replace(/\bA(?:KIA|SIA)[0-9A-Z]{16}\b/g, '[redacted-aws-access-key]')
    .replace(/\b(aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_session_token|AWS_SESSION_TOKEN)\s*[:=]\s*["']?[^"'\s]+/g, '$1=[redacted]')
    .replace(/\b(SecretAccessKey|SessionToken|AccessKeyId)["']?\s*[:=]\s*["']?[^"',\s}]+/g, '$1=[redacted]');
  return normalizeText(text, maxLength);
}

function collectSpawn(command, args = [], options = {}, deps = {}) {
  const spawnImpl = deps.spawn || spawn;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_AWS_API_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command,
        args,
        stdout: redactSensitiveText(stdout),
        stderr: redactSensitiveText(stderr),
        timedOut,
        ...result
      });
    };
    try {
      child = spawnImpl(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: deps.env || process.env
      });
    } catch (error) {
      finish({
        status: 1,
        signal: '',
        error: normalizeText(error && error.message || error, 512)
      });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      } catch (_error) {
        // Best-effort timeout cleanup; the result below is still explicit.
      }
      finish({ status: 124, signal: 'SIGTERM', error: 'command_timeout' });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', (error) => finish({
      status: 1,
      signal: '',
      error: normalizeText(error && error.message || error, 512)
    }));
    child.on('close', (status, signal) => finish({
      status: typeof status === 'number' ? status : 1,
      signal: signal || '',
      error: ''
    }));
  });
}

async function findLocalAwsCli(options = {}, deps = {}) {
  const pathResult = await collectSpawn('sh', ['-lc', 'command -v aws 2>/dev/null || true'], {
    timeoutMs: options.awsApiTimeoutMs
  }, deps);
  const awsPath = normalizeText(pathResult.stdout.split(/\r?\n/)[0], 512);
  if (!awsPath) {
    return {
      available: false,
      path: '',
      version: '',
      probe: pathResult
    };
  }
  const versionResult = await collectSpawn('aws', ['--version'], {
    timeoutMs: options.awsApiTimeoutMs
  }, deps);
  return {
    available: versionResult.status === 0,
    path: awsPath,
    version: normalizeText(versionResult.stdout || versionResult.stderr, 512),
    probe: pathResult,
    versionProbe: versionResult
  };
}

async function runAwsJson(args = [], options = {}, deps = {}) {
  const outputArgs = args.includes('--output') ? args : [...args, '--output', 'json'];
  const result = await collectSpawn('aws', outputArgs, {
    timeoutMs: options.awsApiTimeoutMs
  }, deps);
  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      signal: result.signal,
      error: result.error || normalizeText(result.stderr || result.stdout, 512) || 'aws_cli_command_failed',
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut
    };
  }
  try {
    return {
      ok: true,
      status: result.status,
      data: JSON.parse(result.stdout || '{}')
    };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      error: normalizeText(error && error.message || error, 512) || 'aws_cli_json_parse_failed',
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

function classifyLocalAwsFailure(result = {}) {
  const text = `${result.error || ''}\n${result.stderr || ''}\n${result.stdout || ''}`;
  if (/unable to locate credentials|no credentials|could not be found|missing credentials|credential/i.test(text)) {
    return 'aws_local_credentials_missing';
  }
  return 'aws_local_api_readback_failed';
}

function summarizeAwsIdentity(identity = {}) {
  const account = normalizeText(identity.Account, 64);
  const arn = normalizeText(identity.Arn, 512);
  const arnParts = arn.split(':');
  const resource = arnParts.slice(5).join(':');
  return {
    available: Boolean(account || arn),
    accountSuffix: account ? account.slice(-4) : '',
    arnService: normalizeText(arnParts[2], 64),
    principalType: normalizeText((resource.split('/')[0] || resource.split(':')[0] || ''), 128)
  };
}

function uniqueArray(values = []) {
  return Array.from(new Set(values.map((value) => normalizeText(value, 256)).filter(Boolean)));
}

function extractAwsReadbackTarget(options = {}, context = {}) {
  const udp = context.udp || {};
  const edge = udp.remote && udp.remote.edge || {};
  const edgeSummary = edge.summary || {};
  const imds = edge.imds || {};
  return {
    region: normalizeText(options.awsRegion, 64) || DEFAULT_AWS_REGION,
    instanceId: normalizeText(options.awsInstanceId, 64) || normalizeText(imds.instanceId, 64),
    subnetId: normalizeText(imds.subnetId, 128),
    securityGroupIds: uniqueArray([
      ...(Array.isArray(edgeSummary.securityGroupIds) ? edgeSummary.securityGroupIds : []),
      ...(Array.isArray(imds.securityGroupIds) ? imds.securityGroupIds : [])
    ])
  };
}

function summarizeInstance(instance = {}) {
  const groups = Array.isArray(instance.SecurityGroups) ? instance.SecurityGroups : [];
  return {
    instanceId: normalizeText(instance.InstanceId, 64),
    state: normalizeText(instance.State && instance.State.Name, 64),
    vpcId: normalizeText(instance.VpcId, 128),
    subnetId: normalizeText(instance.SubnetId, 128),
    privateIpAddress: normalizeText(instance.PrivateIpAddress, 128),
    publicIpAddress: normalizeText(instance.PublicIpAddress, 128),
    securityGroupIds: uniqueArray(groups.map((group) => group.GroupId))
  };
}

function firstInstanceFromDescribe(payload = {}) {
  const reservations = Array.isArray(payload.Reservations) ? payload.Reservations : [];
  for (const reservation of reservations) {
    const instances = Array.isArray(reservation.Instances) ? reservation.Instances : [];
    if (instances.length > 0) return instances[0];
  }
  return null;
}

function securityGroupRuleCoversUdpPort(rule = {}, port = DEFAULT_PORT) {
  const protocol = normalizeText(rule.IpProtocol, 32).toLowerCase();
  if (protocol === '-1') return true;
  if (protocol !== 'udp') return false;
  const from = Number(rule.FromPort);
  const to = Number(rule.ToPort);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return from <= port && port <= to;
}

function collectSecurityGroupSources(rule = {}) {
  const ipv4 = Array.isArray(rule.IpRanges) ? rule.IpRanges.map((item) => item.CidrIp) : [];
  const ipv6 = Array.isArray(rule.Ipv6Ranges) ? rule.Ipv6Ranges.map((item) => item.CidrIpv6) : [];
  const groups = Array.isArray(rule.UserIdGroupPairs) ? rule.UserIdGroupPairs.map((item) => item.GroupId) : [];
  const prefixLists = Array.isArray(rule.PrefixListIds) ? rule.PrefixListIds.map((item) => item.PrefixListId) : [];
  return uniqueArray([...ipv4, ...ipv6, ...groups, ...prefixLists]);
}

function summarizeSecurityGroups(payload = {}, port = DEFAULT_PORT) {
  const groups = Array.isArray(payload.SecurityGroups) ? payload.SecurityGroups : [];
  return groups.map((group) => {
    const ingress = Array.isArray(group.IpPermissions) ? group.IpPermissions : [];
    const egress = Array.isArray(group.IpPermissionsEgress) ? group.IpPermissionsEgress : [];
    const matchingIngress = ingress.filter((rule) => securityGroupRuleCoversUdpPort(rule, port));
    return {
      groupId: normalizeText(group.GroupId, 128),
      groupName: normalizeText(group.GroupName, 256),
      vpcId: normalizeText(group.VpcId, 128),
      ingressRuleCount: ingress.length,
      egressRuleCount: egress.length,
      udpDefaultPortIngressRuleCount: matchingIngress.length,
      udpDefaultPortIngressSources: uniqueArray(matchingIngress.flatMap(collectSecurityGroupSources))
    };
  });
}

function networkAclRuleCoversUdpPort(entry = {}, port = DEFAULT_PORT) {
  const protocol = normalizeText(entry.Protocol, 32).toLowerCase();
  if (protocol === '-1') return true;
  if (protocol !== '17' && protocol !== 'udp') return false;
  const range = entry.PortRange || {};
  const from = Number(range.From);
  const to = Number(range.To);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return from <= port && port <= to;
}

function summarizeNetworkAcls(payload = {}, port = DEFAULT_PORT) {
  const acls = Array.isArray(payload.NetworkAcls) ? payload.NetworkAcls : [];
  return acls.map((acl) => {
    const entries = Array.isArray(acl.Entries) ? acl.Entries : [];
    const associations = Array.isArray(acl.Associations) ? acl.Associations : [];
    const inboundMatches = entries.filter((entry) => !entry.Egress && networkAclRuleCoversUdpPort(entry, port));
    const outboundMatches = entries.filter((entry) => entry.Egress && networkAclRuleCoversUdpPort(entry, port));
    return {
      networkAclId: normalizeText(acl.NetworkAclId, 128),
      vpcId: normalizeText(acl.VpcId, 128),
      isDefault: acl.IsDefault === true,
      subnetIds: uniqueArray(associations.map((item) => item.SubnetId)),
      inboundUdpDefaultPortActions: inboundMatches.map((entry) => normalizeText(entry.RuleAction, 32)),
      outboundUdpDefaultPortActions: outboundMatches.map((entry) => normalizeText(entry.RuleAction, 32)),
      entryCount: entries.length
    };
  });
}

async function runLocalAwsApiReadback(options = {}, context = {}, deps = {}) {
  const startedAt = Date.now();
  if (options.skipLocalAwsReadback) {
    return {
      skipped: true,
      reason: 'local_aws_readback_skipped',
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: false
      },
      blockers: []
    };
  }

  const awsCli = await findLocalAwsCli(options, deps);
  if (!awsCli.available) {
    return {
      ran: true,
      ok: true,
      durationMs: Date.now() - startedAt,
      awsCli: {
        available: false,
        path: awsCli.path,
        version: awsCli.version
      },
      apiReadback: {
        attempted: false,
        reason: 'aws_local_cli_missing'
      },
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: false
      },
      blockers: ['aws_local_cli_missing']
    };
  }

  const identityResult = await runAwsJson(['sts', 'get-caller-identity'], options, deps);
  if (!identityResult.ok) {
    const blocker = classifyLocalAwsFailure(identityResult);
    return {
      ran: true,
      ok: true,
      durationMs: Date.now() - startedAt,
      awsCli: {
        available: true,
        path: awsCli.path,
        version: awsCli.version
      },
      identity: {
        available: false,
        error: normalizeText(identityResult.error, 512),
        stderr: redactSensitiveText(identityResult.stderr, 1024)
      },
      apiReadback: {
        attempted: false,
        reason: blocker
      },
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: false
      },
      blockers: [blocker]
    };
  }

  const target = extractAwsReadbackTarget(options, context);
  if (!target.instanceId) {
    return {
      ran: true,
      ok: true,
      durationMs: Date.now() - startedAt,
      awsCli: {
        available: true,
        path: awsCli.path,
        version: awsCli.version
      },
      identity: summarizeAwsIdentity(identityResult.data),
      target,
      apiReadback: {
        attempted: false,
        reason: 'aws_instance_id_missing'
      },
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: true
      },
      blockers: ['aws_local_api_readback_failed']
    };
  }

  const instanceResult = await runAwsJson([
    'ec2',
    'describe-instances',
    '--region',
    target.region,
    '--instance-ids',
    target.instanceId
  ], options, deps);
  if (!instanceResult.ok) {
    return {
      ran: true,
      ok: true,
      durationMs: Date.now() - startedAt,
      awsCli: {
        available: true,
        path: awsCli.path,
        version: awsCli.version
      },
      identity: summarizeAwsIdentity(identityResult.data),
      target,
      apiReadback: {
        attempted: true,
        instanceRead: false,
        reason: 'describe_instances_failed',
        stderr: redactSensitiveText(instanceResult.stderr, 1024)
      },
      summary: {
        awsApiReadbackReady: false,
        awsApiCredentialsReady: true
      },
      blockers: ['aws_local_api_readback_failed']
    };
  }

  const instance = summarizeInstance(firstInstanceFromDescribe(instanceResult.data) || {});
  const securityGroupIds = uniqueArray([...target.securityGroupIds, ...instance.securityGroupIds]);
  const subnetId = target.subnetId || instance.subnetId;
  const refreshedTarget = {
    ...target,
    subnetId,
    securityGroupIds
  };
  const securityGroupResult = securityGroupIds.length > 0
    ? await runAwsJson([
      'ec2',
      'describe-security-groups',
      '--region',
      target.region,
      '--group-ids',
      ...securityGroupIds
    ], options, deps)
    : { ok: false, error: 'security_group_ids_missing', stderr: '' };
  const networkAclResult = subnetId
    ? await runAwsJson([
      'ec2',
      'describe-network-acls',
      '--region',
      target.region,
      '--filters',
      `Name=association.subnet-id,Values=${subnetId}`
    ], options, deps)
    : { ok: false, error: 'subnet_id_missing', stderr: '' };
  const blockers = [];
  if (!securityGroupResult.ok || !networkAclResult.ok) appendUnique(blockers, ['aws_local_api_readback_failed']);
  const readbackReady = blockers.length === 0;

  return {
    ran: true,
    ok: true,
    durationMs: Date.now() - startedAt,
    awsCli: {
      available: true,
      path: awsCli.path,
      version: awsCli.version
    },
    identity: summarizeAwsIdentity(identityResult.data),
    target: refreshedTarget,
    apiReadback: {
      attempted: true,
      instanceRead: true,
      securityGroupsRead: securityGroupResult.ok,
      networkAclsRead: networkAclResult.ok,
      securityGroupError: securityGroupResult.ok ? '' : normalizeText(securityGroupResult.error || securityGroupResult.stderr, 512),
      networkAclError: networkAclResult.ok ? '' : normalizeText(networkAclResult.error || networkAclResult.stderr, 512)
    },
    ec2: {
      instance,
      securityGroups: securityGroupResult.ok ? summarizeSecurityGroups(securityGroupResult.data, Number(options.port) || DEFAULT_PORT) : [],
      networkAcls: networkAclResult.ok ? summarizeNetworkAcls(networkAclResult.data, Number(options.port) || DEFAULT_PORT) : []
    },
    summary: {
      awsApiReadbackReady: readbackReady,
      awsApiCredentialsReady: true,
      instanceId: instance.instanceId,
      subnetId,
      securityGroupIds
    },
    blockers
  };
}

function combineCloudApiSnapshots(remoteCloudApi = {}, localAwsApi = {}) {
  const remoteReady = Boolean(remoteCloudApi.summary && remoteCloudApi.summary.awsApiCredentialsReady);
  const localReady = Boolean(localAwsApi.summary && localAwsApi.summary.awsApiReadbackReady);
  const blockers = [];
  if (!remoteReady && !localReady) {
    appendUnique(blockers, remoteCloudApi.blockers || []);
    appendUnique(blockers, localAwsApi.blockers || []);
  }
  return {
    ...remoteCloudApi,
    remote: remoteCloudApi,
    local: localAwsApi,
    summary: {
      ...(remoteCloudApi.summary || {}),
      awsApiCredentialsReady: remoteReady || localReady,
      remoteAwsApiCredentialsReady: remoteReady,
      localAwsApiReadbackReady: localReady,
      localAwsApiCredentialsReady: Boolean(localAwsApi.summary && localAwsApi.summary.awsApiCredentialsReady),
      localAwsApiInstanceId: normalizeText(localAwsApi.summary && localAwsApi.summary.instanceId, 64),
      localAwsApiSubnetId: normalizeText(localAwsApi.summary && localAwsApi.summary.subnetId, 128)
    },
    blockers
  };
}

function appendUnique(items, values) {
  values.forEach((value) => {
    const text = normalizeText(value, 256);
    if (text && !items.includes(text)) items.push(text);
  });
  return items;
}

function buildNextActions({ udp = {}, cloudApi = {}, hostFirewallBlocksUdp = false, packetArrivalCaptured = null } = {}) {
  const actions = [];
  const edge = udp.remote && udp.remote.edge || {};
  const edgeSummary = edge.summary || {};
  const securityGroupIds = Array.isArray(edgeSummary.securityGroupIds) ? edgeSummary.securityGroupIds : [];
  const udpBlockers = Array.isArray(udp.blockers) ? udp.blockers : [];
  if (udpBlockers.includes('turn_default_udp_probe_busy')) {
    actions.push('Run only one default UDP transport diagnostic at a time; another probe is already binding UDP 9527.');
  }
  if (udpBlockers.includes('turn_default_udp_target_local_only')) {
    actions.push('Run cloud-edge from the client side; target-local UDP success does not prove public cloud edge reachability.');
  }
  if (hostFirewallBlocksUdp) {
    actions.push('Inspect instance-local firewall rules for UDP 9527 drops before changing cloud edge policy.');
  }
  if (packetArrivalCaptured === false && !hostFirewallBlocksUdp && !udpBlockers.includes('turn_default_udp_target_local_only')) {
    actions.push(`Verify AWS Security Group inbound UDP ${Number(udp.port) || DEFAULT_PORT} for ${securityGroupIds.join(',') || 'the attached security groups'}.`);
    actions.push('Verify subnet Network ACL inbound UDP and outbound ephemeral return rules for the same path.');
  }
  const cloudSummary = cloudApi.summary || {};
  if (!cloudSummary.awsApiCredentialsReady) {
    actions.push('Attach a read-only EC2 IAM role or configure local AWS CLI read-only credentials, then inspect SG/NACL rules; this command does not mutate cloud policy.');
  }
  return actions;
}

function buildSummary({ udp = {}, cloudApi = {} } = {}) {
  const edge = udp.remote && udp.remote.edge || {};
  const edgeSummary = edge.summary || {};
  const packetCapture = udp.remote && udp.remote.packetCapture || {};
  const hostFirewallBlocksUdp = Boolean(
    edgeSummary.hostFirewallBlocksUdp
    || edge.firewall && edge.firewall.hostFirewallBlocksUdp
  );
  const packetArrivalCaptured = packetCapture && packetCapture.available
    ? Boolean(packetCapture.captured)
    : null;
  const blockers = [];
  if (udp && udp.ran && !udp.candidateReady) appendUnique(blockers, udp.blockers || []);
  if (hostFirewallBlocksUdp) appendUnique(blockers, [`host_firewall_blocks_udp_${Number(udp.port) || DEFAULT_PORT}`]);
  const udpBlockers = Array.isArray(udp.blockers) ? udp.blockers : [];
  if (packetArrivalCaptured === false && !hostFirewallBlocksUdp && !udpBlockers.includes('turn_default_udp_target_local_only')) {
    appendUnique(blockers, ['aws_public_udp_path_blocked']);
  }
  appendUnique(blockers, cloudApi.blockers || []);
  const cloudSummary = cloudApi.summary || {};
  const cloudApiCredentialsReady = Boolean(cloudSummary.awsApiCredentialsReady);
  const cloudEdgeReady = Boolean(udp.candidateReady && cloudApiCredentialsReady && blockers.length === 0);
  return {
    cloudEdgeReady,
    udpReachable: Boolean(udp.candidateReady),
    packetArrivalCaptured,
    hostFirewallBlocksUdp,
    cloudApiCredentialsReady,
    remoteAwsApiCredentialsReady: cloudSummary.remoteAwsApiCredentialsReady === true,
    localAwsApiReadbackReady: cloudSummary.localAwsApiReadbackReady === true,
    localAwsApiCredentialsReady: cloudSummary.localAwsApiCredentialsReady === true,
    localAwsApiInstanceId: normalizeText(cloudSummary.localAwsApiInstanceId, 64),
    localAwsApiSubnetId: normalizeText(cloudSummary.localAwsApiSubnetId, 128),
    publicIpv4: edgeSummary.publicIpv4 || '',
    privateAddress: edgeSummary.privateAddress || '',
    interface: edgeSummary.interface || '',
    securityGroupIds: Array.isArray(edgeSummary.securityGroupIds) ? edgeSummary.securityGroupIds : [],
    blockers,
    nextActions: buildNextActions({ udp, cloudApi, hostFirewallBlocksUdp, packetArrivalCaptured })
  };
}

async function runCloudEdgePreflight(options = {}, deps = {}) {
  options = {
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    port: DEFAULT_PORT,
    udpProbeTimeoutMs: DEFAULT_UDP_PROBE_TIMEOUT_MS,
    awsRegion: DEFAULT_AWS_REGION,
    awsInstanceId: '',
    awsApiTimeoutMs: DEFAULT_AWS_API_TIMEOUT_MS,
    skipUdpProbe: false,
    skipLocalAwsReadback: false,
    ...options
  };
  options.endpoint = normalizeHttpUrl(options.endpoint, '--endpoint');
  const startedAt = Date.now();
  let udpReport = null;
  let udpError = null;
  if (!options.skipUdpProbe) {
    try {
      udpReport = await (deps.runDefaultPortUdpProbe || runDefaultPortUdpProbe)(options, deps);
    } catch (error) {
      udpError = error;
    }
  }
  const udp = classifyDefaultPortUdpProbe(udpReport, udpError, Boolean(options.skipUdpProbe));
  const remoteCloudApi = await (deps.runRemoteCloudApiSnapshot || runRemoteCloudApiSnapshot)(options, deps);
  const localAwsApi = await (deps.runLocalAwsApiReadback || runLocalAwsApiReadback)(options, {
    udp,
    remoteCloudApi
  }, deps);
  const cloudApi = combineCloudApiSnapshots(remoteCloudApi, localAwsApi);
  const summary = buildSummary({ udp, cloudApi });
  return {
    ok: true,
    mode: 'fabric-cloud-edge-preflight',
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    target: {
      endpoint: options.endpoint,
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      port: options.port
    },
    udp,
    cloudApi,
    summary
  };
}

function formatReport(report = {}) {
  const summary = report.summary || {};
  const lines = [];
  lines.push('AIH Fabric cloud edge preflight');
  lines.push(`  endpoint: ${report.target && report.target.endpoint || ''}`);
  lines.push(`  cloud_edge_ready: ${summary.cloudEdgeReady ? 'yes' : 'no'}`);
  lines.push(`  udp_reachable: ${summary.udpReachable ? 'yes' : 'no'}`);
  lines.push(`  packet_arrival_captured: ${summary.packetArrivalCaptured === null ? 'unknown' : (summary.packetArrivalCaptured ? 'yes' : 'no')}`);
  lines.push(`  host_firewall_blocks_udp: ${summary.hostFirewallBlocksUdp ? 'yes' : 'no'}`);
  lines.push(`  aws_api_credentials_ready: ${summary.cloudApiCredentialsReady ? 'yes' : 'no'}`);
  lines.push(`  remote_aws_api_credentials_ready: ${summary.remoteAwsApiCredentialsReady ? 'yes' : 'no'}`);
  lines.push(`  local_aws_api_readback_ready: ${summary.localAwsApiReadbackReady ? 'yes' : 'no'}`);
  lines.push(`  interface: ${summary.interface || ''}`);
  lines.push(`  private_address: ${summary.privateAddress || ''}`);
  lines.push(`  public_ipv4: ${summary.publicIpv4 || ''}`);
  if (summary.localAwsApiInstanceId) lines.push(`  local_aws_api_instance_id: ${summary.localAwsApiInstanceId}`);
  if (summary.localAwsApiSubnetId) lines.push(`  local_aws_api_subnet_id: ${summary.localAwsApiSubnetId}`);
  lines.push(`  security_group_ids: ${(summary.securityGroupIds || []).join(', ') || 'unknown'}`);
  if (Array.isArray(summary.blockers) && summary.blockers.length > 0) {
    lines.push('  blockers:');
    summary.blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  if (Array.isArray(summary.nextActions) && summary.nextActions.length > 0) {
    lines.push('  next_actions:');
    summary.nextActions.forEach((action) => lines.push(`    - ${action}`));
  }
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`AIH Fabric cloud edge preflight

Usage:
  node scripts/fabric-cloud-edge-preflight.js [options]

Options:
  --endpoint <url>          AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --ssh <user@host>         SSH target, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>           SSH key, default ${DEFAULT_SSH_KEY}.
  --remote-dir <path>       AWS current dir, default ${DEFAULT_REMOTE_DIR}.
  --port <n>                UDP/default transport port, default ${DEFAULT_PORT}.
  --udp-timeout-ms <n>      UDP probe timeout, default ${DEFAULT_UDP_PROBE_TIMEOUT_MS}.
  --aws-region <region>     Local AWS API readback region, default ${DEFAULT_AWS_REGION}.
  --aws-instance-id <id>    Override instance id when UDP/IMDS evidence is unavailable.
  --aws-api-timeout-ms <n>  Timeout per local AWS CLI readback command, default ${DEFAULT_AWS_API_TIMEOUT_MS}.
  --skip-udp-probe          Only check cloud API prerequisites.
  --skip-local-aws-readback Skip local AWS CLI readback.
  --fail-on-blocked         Exit non-zero when cloud edge is not ready.
  --json                    Print JSON only.
  -h, --help                Show this help.
`);
    return;
  }
  const report = await runCloudEdgePreflight(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  if (options.failOnBlocked && !(report.summary && report.summary.cloudEdgeReady)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-cloud-edge-preflight] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  combineCloudApiSnapshots,
  buildRemoteCloudApiSnapshotCommand,
  buildSummary,
  formatReport,
  parseArgs,
  runCloudEdgePreflight,
  runLocalAwsApiReadback,
  runRemoteCloudApiSnapshot
};
