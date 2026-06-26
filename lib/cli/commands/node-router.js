'use strict';

const { runNodeJoin } = require('../services/node/join');
const { runNodeDoctor, formatDoctorReport } = require('../services/node/doctor');
const { runNodeBootstrap, formatNodeBootstrapPlan } = require('../services/node/bootstrap');
const { runNodeBootstrapProbe, formatNodeBootstrapProbeReport } = require('../services/node/bootstrap-probe');
const { runNodeBootstrapApply, formatNodeBootstrapApplyReport } = require('../services/node/bootstrap-apply');
const { runNodeRelayConnect } = require('../services/node/relay-client');
const { runNodeRelayService } = require('../services/node/relay-service');

function isHelp(value) {
  const text = String(value || '').trim();
  return !text || text === 'help' || text === '--help' || text === '-h';
}

function hasHelpArg(values = []) {
  return Array.isArray(values) && values.some((value) => {
    const text = String(value || '').trim();
    return text === 'help' || text === '--help' || text === '-h';
  });
}

function exitWithNodeUsage(consoleImpl, processObj, exitCode) {
  showNodeUsage(consoleImpl);
  processObj.exit(exitCode);
  return exitCode;
}

function showNodeUsage(consoleImpl = console) {
  consoleImpl.log(`
\x1b[36mAI Home Node\x1b[0m - Remote node pairing commands

\x1b[33mUsage:\x1b[0m
  aih node join <invite-url> [--endpoint URL] [--transport KIND] [--name NAME] [--id ID]
  aih node join <invite-url> --json
  aih node doctor [--control-url URL] [--node-id ID] [--json]
  aih node bootstrap [--target linux|darwin|win32] [--control-url URL] [--invite-url URL] [--endpoint URL] [--repo-url URL] [--repo-subdir PATH] [--node-id ID] [--script-only] [--json]
  aih node bootstrap probe [--target linux|darwin|win32] [--ssh user@host] [--tcp host] [--ports 22,3389,445,5985,5986] [--control-url URL] [--invite-url URL] [--repo-url URL] [--repo-subdir PATH] [-j N] [--json]
  aih node bootstrap apply [probe options...] [--asset-mode script|local] [--node-dist-dir PATH] [--execute --yes] [--execute-concurrency N] [--json]
  aih node relay connect <control-url> --node-id ID [--once] [--json]
  aih node relay service install <control-url> --node-id ID
  aih node relay service status --node-id ID
  aih node relay service uninstall --node-id ID

\x1b[33mExamples:\x1b[0m
  # Current machine as Control Plane; other machines join through outbound relay.
  aih server config set --open-network
  aih server restart
  # Browser: http://<this-machine-lan-ip>:9527/ui/ -> Settings -> Remote Nodes -> Generate join command

  # Readonly multi-node probe from the Control Plane machine.
  aih node bootstrap probe --ssh model@192.168.3.8 --ssh model@192.168.3.22 --tcp 192.168.3.76 --control-url http://<this-machine-lan-ip>:9527 --invite-url '<join-url>' --repo-url https://github.com/madou1217/ai_home.git -j 3

  # Execute only SSH-ready Linux/mac targets; configure Windows SSH key auth before automatic Windows execution.
  aih node bootstrap apply --asset-mode local --execute --yes --ssh model@192.168.3.8 --ssh model@192.168.3.22 --control-url http://<this-machine-lan-ip>:9527 --invite-url '<join-url>' --repo-url https://github.com/madou1217/ai_home.git -j 2

  aih node join https://control.example.com/v0/node-rpc/join?code=abc  # defaults to relay, no public IP required
  aih node join https://control.example.com/v0/node-rpc/join?code=abc --endpoint http://100.64.0.20:9527 --transport tailscale
  aih node doctor --control-url https://control.example.com
  aih node bootstrap --target win32 --control-url https://control.example.com --repo-url <repo-url>
  aih node bootstrap --target linux --script-only > aih-node-bootstrap.sh
  aih node bootstrap probe --target win32 --ssh madou@192.168.3.76 --invite-url 'https://control.example.com/v0/node-rpc/join?code=abc' --repo-url <repo-url>
  aih node bootstrap apply --asset-mode local --ssh model@192.168.3.8 --ssh model@192.168.3.22 --tcp 192.168.3.76 -j 3
  aih node relay connect https://control.example.com --node-id nat-node
  aih node relay service install https://control.example.com --node-id nat-node

\x1b[33mTransport model:\x1b[0m
  relay is the default data-plane for no-public-IP machines; no endpoint or provider input is required.
  node id and display name default to the target machine identity and hostname; override only when needed.
  FRP/direct/Tailscale/ZeroTier/WireGuard/SSH tunnel require a reachable HTTP endpoint managed outside AIH.
  SSH probe/bootstrap can run in parallel across many nodes; SSH as transport still means an HTTP tunnel endpoint.
  --asset-mode local transfers the current source archive and local Node.js runtime archive over SSH for weak/no-public-network targets.
  OpenMPTCPRouter/MPTCP are underlay optimizers only; AIH records the reachable endpoint but does not manage them.
  Mobile/PWA/tablet clients pair with a Control Plane and can save/switch multiple servers.
`);
}

function writeStdout(processObj, value) {
  if (processObj && processObj.stdout && typeof processObj.stdout.write === 'function') {
    processObj.stdout.write(value);
    return;
  }
  process.stdout.write(value);
}

function formatJoinedNode(result) {
  const node = result.node || {};
  const name = String(node.name || node.id || 'remote node').trim();
  const id = String(node.id || '').trim();
  const suffix = id && id !== name ? ` (${id})` : '';
  return [
    `[aih] node joined: ${name}${suffix}`,
    `[aih] endpoint: ${result.endpoint}`,
    `[aih] transport: ${result.transportKind}`
  ].join('\n');
}

function printJoinResult(result, processObj) {
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: true,
      node: result.node,
      invite: result.invite,
      endpoint: result.endpoint,
      transportKind: result.transportKind
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatJoinedNode(result)}\n`);
}

function formatRelayConnectResult(result) {
  return [
    `[aih] relay connected: ${result.nodeId}`,
    `[aih] relay session: ${result.sessionId || 'unknown'}`,
    `[aih] relay transport: ${result.transportId || 'unknown'}`
  ].join('\n');
}

function printRelayConnectResult(result, processObj) {
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: true,
      nodeId: result.nodeId,
      relayUrl: result.relayUrl,
      sessionId: result.sessionId,
      transportId: result.transportId,
      attempts: result.attempts,
      once: result.once
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatRelayConnectResult(result)}\n`);
}

function formatRelayServiceResult(result) {
  const status = result.status || {};
  const lines = [
    `[aih] relay service ${result.action}: ${result.nodeId}`,
    `[aih] service state: ${status.state || 'unknown'}`,
    `[aih] service type: ${status.type || 'unknown'}`,
    `[aih] service file: ${status.file || ''}`,
    `[aih] installed: ${status.installed ? 'yes' : 'no'}`,
    `[aih] loaded: ${status.loaded ? 'yes' : 'no'}`,
    `[aih] running: ${status.running ? 'yes' : 'no'}`
  ];
  if (Array.isArray(status.issues) && status.issues.length) {
    lines.push('[aih] service issues:');
    status.issues.forEach((issue) => {
      lines.push(`  - ${issue.code || 'issue'}: ${issue.message || ''}`);
    });
  }
  if (Array.isArray(status.nextActions) && status.nextActions.length) {
    lines.push('[aih] next actions:');
    status.nextActions.forEach((action) => {
      lines.push(`  - ${action.label}: ${action.command}`);
    });
  }
  return lines.join('\n');
}

function printRelayServiceResult(result, processObj) {
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: true,
      action: result.action,
      nodeId: result.nodeId,
      status: result.status
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatRelayServiceResult(result)}\n`);
}

function printDoctorResult(result, processObj) {
  const report = result.report || {};
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: Boolean(report.ok),
      report
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatDoctorReport(report)}\n`);
}

function printBootstrapResult(result, processObj) {
  const plan = result.plan || {};
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: Boolean(plan.ok),
      plan
    })}\n`);
    return;
  }
  if (result.scriptOnly) {
    writeStdout(processObj, `${String(plan.script && plan.script.content || '').trimEnd()}\n`);
    return;
  }
  writeStdout(processObj, `${formatNodeBootstrapPlan(plan)}\n`);
}

function printBootstrapProbeResult(result, processObj) {
  const report = result.report || {};
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: Boolean(report.ok),
      report
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatNodeBootstrapProbeReport(report)}\n`);
}

function printBootstrapApplyResult(result, processObj) {
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: Boolean(result.ok),
      mode: result.mode,
      executeTimeoutMs: result.executeTimeoutMs,
      executeConcurrency: result.executeConcurrency,
      probe: result.probe,
      plan: result.plan
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatNodeBootstrapApplyReport(result)}\n`);
}

function printNodeError(error, consoleImpl) {
  const code = String((error && error.code) || 'node_command_failed');
  if (code === 'unknown_option') {
    consoleImpl.error(`\x1b[31m[aih] node command failed: unsupported option ${String(error && error.flag || '').trim() || 'unknown'}.\x1b[0m`);
    return;
  }
  if (code === 'missing_option_value') {
    consoleImpl.error(`\x1b[31m[aih] node command failed: missing value for ${String(error && error.flag || '').trim() || 'option'}.\x1b[0m`);
    return;
  }
  if (code === 'invalid_boolean_option') {
    consoleImpl.error(`\x1b[31m[aih] node command failed: ${String(error && error.flag || 'boolean option')} must be true or false.\x1b[0m`);
    return;
  }
  if (code === 'bootstrap_apply_confirmation_required') {
    consoleImpl.error('\x1b[31m[aih] node bootstrap apply refused to execute: pass --execute --yes after reviewing the dry-run plan.\x1b[0m');
    return;
  }
  if (code === 'bootstrap_apply_required_inputs_missing') {
    const requiredInputs = Array.isArray(error && error.requiredInputs)
      ? error.requiredInputs.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    const suffix = requiredInputs.length ? ` Missing: ${requiredInputs.join(', ')}.` : '';
    consoleImpl.error(`\x1b[31m[aih] node bootstrap apply refused to execute: complete bootstrap inputs before writing remote machines.${suffix}\x1b[0m`);
    return;
  }
  if (code === 'endpoint_required') {
    consoleImpl.error('\x1b[31m[aih] node join failed: local server is not reachable from this Control Plane. Pass --endpoint with a reachable direct/overlay/FRP/SSH tunnel URL.\x1b[0m');
    return;
  }
  if (code === 'management_key_required') {
    if (String(error && error.command || '') === 'relay-connect') {
      consoleImpl.error('\x1b[31m[aih] node relay connect failed: set server managementKey or pass --management-key matching the joined node secret.\x1b[0m');
      return;
    }
    if (String(error && error.command || '') === 'relay-service') {
      consoleImpl.error('\x1b[31m[aih] node relay service failed: set server managementKey first. The service reads it from server config and never stores it in startup files.\x1b[0m');
      return;
    }
    consoleImpl.error('\x1b[31m[aih] node join failed: non-loopback nodes must advertise a management key. Set server managementKey or pass --management-key matching the running server.\x1b[0m');
    return;
  }
  if (code === 'missing_invite' || code === 'invalid_invite_url' || code === 'missing_invite_code') {
    consoleImpl.error('\x1b[31m[aih] node join failed: pass the invite URL generated by the Control Plane.\x1b[0m');
    return;
  }
  if (code === 'invalid_endpoint') {
    consoleImpl.error('\x1b[31m[aih] node command failed: --endpoint must be an http(s) URL.\x1b[0m');
    return;
  }
  if (code === 'invalid_transport_kind') {
    consoleImpl.error('\x1b[31m[aih] node join failed: unsupported transport kind.\x1b[0m');
    return;
  }
  if (code === 'missing_relay_url' || code === 'invalid_relay_url') {
    consoleImpl.error('\x1b[31m[aih] node relay connect failed: pass the Control Plane URL, for example https://control.example.com.\x1b[0m');
    return;
  }
  if (code === 'invalid_control_url' || code === 'too_many_control_urls') {
    consoleImpl.error('\x1b[31m[aih] node command failed: pass one http(s) Control Plane URL, for example https://control.example.com.\x1b[0m');
    return;
  }
  if (code === 'invalid_invite_url') {
    consoleImpl.error('\x1b[31m[aih] node bootstrap failed: --invite-url must be an http(s) invite URL generated by the Control Plane.\x1b[0m');
    return;
  }
  if (code === 'unsupported_bootstrap_target') {
    consoleImpl.error('\x1b[31m[aih] node bootstrap failed: --target must be linux, darwin, or win32.\x1b[0m');
    return;
  }
  if (code === 'missing_relay_node_id') {
    consoleImpl.error('\x1b[31m[aih] node relay connect failed: pass --node-id matching the joined remote node id.\x1b[0m');
    return;
  }
  if (code === 'missing_relay_service_action' || code === 'unknown_relay_service_action') {
    consoleImpl.error('\x1b[31m[aih] node relay service failed: use install, status, or uninstall.\x1b[0m');
    return;
  }
  if (code === 'relay_service_management_key_not_allowed') {
    consoleImpl.error('\x1b[31m[aih] node relay service failed: do not pass --management-key to service install; set server managementKey so the running client can read it locally.\x1b[0m');
    return;
  }
  if (code === 'relay_service_option_not_allowed') {
    consoleImpl.error(`\x1b[31m[aih] node relay service failed: ${String(error && error.flag || 'that option')} is not valid for a persistent service.\x1b[0m`);
    return;
  }
  if (code === 'relay_upgrade_rejected') {
    consoleImpl.error(`\x1b[31m[aih] node relay connect failed: Control Plane rejected the WebSocket upgrade (${Number(error && error.statusCode) || 0}).\x1b[0m`);
    return;
  }
  if (code === 'relay_connect_timeout' || code === 'relay_hello_timeout' || code === 'relay_pong_timeout') {
    consoleImpl.error(`\x1b[31m[aih] node relay connect failed: ${code}.\x1b[0m`);
    return;
  }
  const message = String((error && error.message) || code);
  consoleImpl.error(`\x1b[31m[aih] node command failed: ${message}\x1b[0m`);
}

async function runNodeCommandRouter(args = [], deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const action = String((Array.isArray(args) ? args[1] : '') || '').trim();

  if (isHelp(action)) {
    return exitWithNodeUsage(consoleImpl, processObj, 0);
  }

  const relayAction = String((Array.isArray(args) ? args[2] : '') || '').trim();
  if (action !== 'join' && action !== 'doctor' && action !== 'bootstrap' && !(action === 'relay' && (relayAction === 'connect' || relayAction === 'service'))) {
    consoleImpl.error(`\x1b[31m[aih] unknown node command: ${action}\x1b[0m`);
    showNodeUsage(consoleImpl);
    processObj.exit(1);
    return 1;
  }

  if (action === 'doctor') {
    const doctorArgs = Array.isArray(args) ? args.slice(2) : [];
    if (hasHelpArg(doctorArgs)) {
      return exitWithNodeUsage(consoleImpl, processObj, 0);
    }
    try {
      const runner = deps.runNodeDoctor || runNodeDoctor;
      const result = await runner(doctorArgs, deps);
      printDoctorResult(result, processObj);
      processObj.exit(0);
      return 0;
    } catch (error) {
      printNodeError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'bootstrap') {
    const bootstrapArgs = Array.isArray(args) ? args.slice(2) : [];
    if (hasHelpArg(bootstrapArgs)) {
      return exitWithNodeUsage(consoleImpl, processObj, 0);
    }
    try {
      if (bootstrapArgs[0] === 'probe') {
        const runner = deps.runNodeBootstrapProbe || runNodeBootstrapProbe;
        const result = await runner(bootstrapArgs.slice(1), deps);
        printBootstrapProbeResult(result, processObj);
        processObj.exit(0);
        return 0;
      }
      if (bootstrapArgs[0] === 'apply' || bootstrapArgs[0] === 'run') {
        const runner = deps.runNodeBootstrapApply || runNodeBootstrapApply;
        const result = await runner(bootstrapArgs.slice(1), deps);
        printBootstrapApplyResult(result, processObj);
        const exitCode = result.ok ? 0 : 1;
        processObj.exit(exitCode);
        return exitCode;
      }
      const runner = deps.runNodeBootstrap || runNodeBootstrap;
      const result = await runner(bootstrapArgs, deps);
      printBootstrapResult(result, processObj);
      processObj.exit(0);
      return 0;
    } catch (error) {
      printNodeError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'relay') {
    const relayArgs = Array.isArray(args) ? args.slice(3) : [];
    if (relayArgs.length === 0 || isHelp(relayArgs[0])) {
      return exitWithNodeUsage(consoleImpl, processObj, relayArgs.length === 0 ? 1 : 0);
    }
    if (relayAction === 'service') {
      const serviceArgs = Array.isArray(args) ? args.slice(3) : [];
      if (serviceArgs.length === 0 || isHelp(serviceArgs[0])) {
        return exitWithNodeUsage(consoleImpl, processObj, serviceArgs.length === 0 ? 1 : 0);
      }
      try {
        const runner = deps.runNodeRelayService || runNodeRelayService;
        const result = await runner(serviceArgs, deps);
        printRelayServiceResult(result, processObj);
        processObj.exit(0);
        return 0;
      } catch (error) {
        printNodeError(error, consoleImpl);
        processObj.exit(1);
        return 1;
      }
    }
    try {
      const runner = deps.runNodeRelayConnect || runNodeRelayConnect;
      const result = await runner(relayArgs, deps);
      printRelayConnectResult(result, processObj);
      processObj.exit(0);
      return 0;
    } catch (error) {
      printNodeError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  const joinArgs = Array.isArray(args) ? args.slice(2) : [];
  if (joinArgs.length === 0 || isHelp(joinArgs[0])) {
    return exitWithNodeUsage(consoleImpl, processObj, joinArgs.length === 0 ? 1 : 0);
  }

  try {
    const result = await runNodeJoin(joinArgs, deps);
    printJoinResult(result, processObj);
    processObj.exit(0);
    return 0;
  } catch (error) {
    printNodeError(error, consoleImpl);
    processObj.exit(1);
    return 1;
  }
}

module.exports = {
  showNodeUsage,
  runNodeCommandRouter
};
