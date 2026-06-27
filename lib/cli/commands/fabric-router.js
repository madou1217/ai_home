'use strict';

const {
  formatFabricTransportProbeReport,
  runFabricTransportProbe
} = require('../services/fabric/transport-probe');
const {
  formatFabricTransportEchoReport,
  runFabricTransportEcho,
  runFabricTransportEchoServer
} = require('../services/fabric/transport-echo');
const {
  formatFabricTransportTcpEchoReport,
  runFabricTransportTcpEcho,
  runFabricTransportTcpEchoServer
} = require('../services/fabric/transport-tcp-echo');
const {
  formatFabricRegistryPublishReport,
  runFabricRegistryPublish
} = require('../services/fabric/registry-publish');
const {
  formatFabricRegistryHeartbeatReport,
  runFabricRegistryHeartbeat
} = require('../services/fabric/registry-heartbeat');
const {
  formatFabricRegistryAgentEvent,
  formatFabricRegistryAgentReport,
  hasJsonFlag,
  runFabricRegistryAgent
} = require('../services/fabric/registry-agent');
const {
  runFabricRegistryAgentService
} = require('../services/fabric/registry-agent-service');
const {
  formatFabricBrokerConnectReport,
  runFabricBrokerConnect
} = require('../services/fabric/broker-connect');

function isHelp(value) {
  const text = String(value || '').trim();
  return !text || text === 'help' || text === '--help' || text === '-h';
}

function hasHelpArg(values = []) {
  return Array.isArray(values) && values.some((value) => isHelp(value));
}

function writeStdout(processObj, value) {
  if (processObj && processObj.stdout && typeof processObj.stdout.write === 'function') {
    processObj.stdout.write(value);
    return;
  }
  process.stdout.write(value);
}

function showFabricUsage(consoleImpl = console) {
  consoleImpl.log(`
\x1b[36mAIH Fabric\x1b[0m - Server/profile/node/relay fabric tooling

\x1b[33mUsage:\x1b[0m
  aih fabric transport probe <endpoint...> [--timeout-ms N] [--method HEAD|GET] [--json]
  aih fabric transport echo <ws-url> [--count N] [--payload-size BYTES] [--insecure] [--json]
  aih fabric transport echo-server [--host HOST] [--port PORT] [--path PATH] [--tls-key FILE --tls-cert FILE] [--json]
  aih fabric transport tcp-echo <tcp-url> [--count N] [--payload-size BYTES] [--json]
  aih fabric transport tcp-echo-server [--host HOST] [--port PORT] [--json]
  aih fabric registry publish <server-url> --token TOKEN [--node-id ID] [--name NAME] [--relay-node] [--project PATH] [--runtime codex:tui] [--from-server] [--json]
  aih fabric registry heartbeat <server-url> --token TOKEN --node-id ID [--status online] [--relay-status online] [--transport relay=online] [--json]
  aih fabric registry agent <server-url> --token TOKEN --node-id ID [--interval-ms 30000] [--transport relay=online] [--probe-transport relay=tcp://host:port] [--probe-count N] [--json]
  aih fabric registry agent service install <server-url> --node-id ID --token-file FILE [--probe-transport relay=tcp://host:port]
  aih fabric registry agent service status --node-id ID
  aih fabric registry agent service uninstall --node-id ID
  aih fabric broker connect <broker-url> --server-id ID --token TOKEN [--local-url http://127.0.0.1:9527] [--json]

\x1b[33mExamples:\x1b[0m
  aih fabric transport probe tcp://155.248.183.169:22 --json
  aih fabric transport probe https://server.example.com --timeout-ms 3000
  aih fabric transport probe wss://server.example.com/v0/relay/node
  aih fabric transport echo ws://127.0.0.1:8765/echo --count 20 --json
  aih fabric transport echo-server --host 0.0.0.0 --port 8765 --path /echo
  aih fabric transport tcp-echo tcp://127.0.0.1:8766 --count 20 --json
  aih fabric transport tcp-echo-server --host 0.0.0.0 --port 8766
  aih fabric registry publish https://server.example.com --token "$AIH_FABRIC_TOKEN" --node-id home-mac --relay-node --project . --runtime codex:tui --json
  aih fabric registry publish http://127.0.0.1:8317 --token "$AIH_FABRIC_TOKEN" --from-server --relay-node --json
  aih fabric registry heartbeat http://127.0.0.1:8317 --token "$AIH_FABRIC_TOKEN" --node-id home-mac --relay-status online --transport relay=online --json
  aih fabric registry agent http://127.0.0.1:8317 --token "$AIH_FABRIC_TOKEN" --node-id home-mac --relay-status online --transport relay=online
  aih fabric registry agent http://127.0.0.1:8317 --token "$AIH_FABRIC_TOKEN" --node-id relay-1 --probe-transport relay=tcp://127.0.0.1:8766 --count 2 --json
  aih fabric registry agent service install http://127.0.0.1:8317 --node-id relay-1 --token-file ~/.ai_home/fabric/relay-1.token --probe-transport relay=tcp://127.0.0.1:8766
  aih fabric broker connect https://broker.example.com --server-id home-server --token "$AIH_FABRIC_BROKER_TOKEN"

\x1b[33mNotes:\x1b[0m
  transport probe is read-only. It does not save profiles, start services, or mutate remotes.
  echo-server is a foreground lab tool. It does not install services or change remote config.
  tcp-echo distinguishes TCP connect success from application-data echo success.
  HTTP(S) endpoints use HEAD by default; ws/wss/tcp endpoints perform a TCP-level probe only.
  WebRTC and WebTransport probes are tracked in docs/fabric and will extend this command.
  registry publish sends one node snapshot. --from-server derives API runtimes from the target server's real management accounts.
  registry heartbeat updates node/relay/transport liveness without replacing projects or runtimes.
  registry agent is a foreground heartbeat loop. --probe-transport maps HTTP health, WS echo, or TCP echo results into transport health.
  registry agent tcp:// probes require a tcp-echo endpoint; use transport probe for raw TCP connect checks.
  registry agent service writes platform service files only when explicitly installing; use --token-file so raw tokens never enter argv or service files.
  registry publish does not store tokens, install services, or start a daemon.
  broker connect is a foreground outbound link from this AIH server to a reachable broker. The broker only forwards allowlisted Fabric/node session routes.
`);
}

function formatFabricRegistryAgentServiceReport(result = {}) {
  const status = result.status || {};
  const lines = [
    `[aih fabric] registry agent service ${result.action}: ${result.nodeId}`,
    `[aih fabric] service state: ${status.state || 'unknown'}`,
    `[aih fabric] service type: ${status.type || 'unknown'}`,
    `[aih fabric] service file: ${status.file || ''}`,
    `[aih fabric] installed: ${status.installed ? 'yes' : 'no'}`,
    `[aih fabric] loaded: ${status.loaded ? 'yes' : 'no'}`,
    `[aih fabric] running: ${status.running ? 'yes' : 'no'}`
  ];
  if (Array.isArray(status.issues) && status.issues.length > 0) {
    lines.push('[aih fabric] service issues:');
    status.issues.forEach((issue) => {
      lines.push(`  - ${issue.code || 'issue'}: ${issue.message || ''}`);
    });
  }
  if (Array.isArray(status.nextActions) && status.nextActions.length > 0) {
    lines.push('[aih fabric] next actions:');
    status.nextActions.forEach((action) => {
      lines.push(`  - ${action.label}: ${action.command}`);
    });
  }
  return lines.join('\n');
}

function printFabricRegistryAgentServiceResult(result, processObj) {
  if (result.json) {
    writeStdout(processObj, `${JSON.stringify({
      ok: true,
      action: result.action,
      nodeId: result.nodeId,
      status: result.status
    })}\n`);
    return;
  }
  writeStdout(processObj, `${formatFabricRegistryAgentServiceReport(result)}\n`);
}

function printFabricError(error, consoleImpl) {
  const code = String((error && error.code) || 'fabric_command_failed');
  if (code === 'unknown_option') {
    consoleImpl.error(`\x1b[31m[aih] fabric command failed: unsupported option ${String(error && error.flag || '').trim() || 'unknown'}.\x1b[0m`);
    return;
  }
  if (code === 'missing_option_value') {
    consoleImpl.error(`\x1b[31m[aih] fabric command failed: missing value for ${String(error && error.flag || '').trim() || 'option'}.\x1b[0m`);
    return;
  }
  if (code === 'missing_probe_target') {
    consoleImpl.error('\x1b[31m[aih] fabric transport probe failed: pass at least one endpoint.\x1b[0m');
    return;
  }
  if (code === 'missing_echo_target') {
    consoleImpl.error('\x1b[31m[aih] fabric transport echo failed: pass one ws:// or wss:// endpoint.\x1b[0m');
    return;
  }
  if (code === 'missing_tcp_echo_target') {
    consoleImpl.error('\x1b[31m[aih] fabric transport tcp-echo failed: pass one tcp:// endpoint.\x1b[0m');
    return;
  }
  if (code === 'too_many_echo_targets') {
    consoleImpl.error('\x1b[31m[aih] fabric transport echo failed: pass exactly one endpoint.\x1b[0m');
    return;
  }
  if (code === 'too_many_tcp_echo_targets') {
    consoleImpl.error('\x1b[31m[aih] fabric transport tcp-echo failed: pass exactly one endpoint.\x1b[0m');
    return;
  }
  if (code === 'invalid_echo_target' || code === 'invalid_echo_target_protocol') {
    consoleImpl.error(`\x1b[31m[aih] fabric transport echo failed: invalid endpoint ${String(error && error.target || '').trim() || 'target'}.\x1b[0m`);
    return;
  }
  if (code === 'invalid_tcp_echo_target' || code === 'invalid_tcp_echo_target_protocol') {
    consoleImpl.error(`\x1b[31m[aih] fabric transport tcp-echo failed: invalid endpoint ${String(error && error.target || '').trim() || 'target'}.\x1b[0m`);
    return;
  }
  if (code === 'incomplete_echo_tls_config') {
    consoleImpl.error('\x1b[31m[aih] fabric transport echo-server failed: pass both --tls-key and --tls-cert, or neither.\x1b[0m');
    return;
  }
  if (code === 'unsupported_http_method') {
    consoleImpl.error('\x1b[31m[aih] fabric transport probe failed: --method must be HEAD or GET.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_registry_endpoint') {
    consoleImpl.error('\x1b[31m[aih] fabric registry publish failed: pass a server URL.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_token') {
    consoleImpl.error('\x1b[31m[aih] fabric registry publish failed: pass --token or set AIH_FABRIC_TOKEN.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_broker_url') {
    consoleImpl.error('\x1b[31m[aih] fabric broker connect failed: pass a broker URL.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_broker_server_id') {
    consoleImpl.error('\x1b[31m[aih] fabric broker connect failed: pass --server-id.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_broker_token') {
    consoleImpl.error('\x1b[31m[aih] fabric broker connect failed: pass --token or set AIH_FABRIC_BROKER_TOKEN.\x1b[0m');
    return;
  }
  if (code === 'invalid_fabric_broker_url' || code === 'invalid_fabric_broker_local_url') {
    consoleImpl.error(`\x1b[31m[aih] fabric broker connect failed: invalid URL ${String(error && error.endpoint || '').trim() || 'endpoint'}.\x1b[0m`);
    return;
  }
  if (code === 'missing_fabric_token_file') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent service failed: pass --token-file pointing to a local device token file.\x1b[0m');
    return;
  }
  if (code === 'fabric_token_file_unreadable') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry agent failed: token file is unreadable ${String(error && error.file || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_agent_service_token_not_allowed') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent service failed: do not pass --token; use --token-file so raw tokens do not enter service files or argv.\x1b[0m');
    return;
  }
  if (code === 'fabric_agent_service_count_not_allowed') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry agent service failed: ${String(error && error.flag || 'that option')} is not valid for a persistent service.\x1b[0m`);
    return;
  }
  if (code === 'missing_fabric_agent_service_action' || code === 'unknown_fabric_agent_service_action') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent service failed: use install, status, or uninstall.\x1b[0m');
    return;
  }
  if (code === 'invalid_fabric_registry_endpoint') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry publish failed: invalid server URL ${String(error && error.endpoint || '').trim() || 'endpoint'}.\x1b[0m`);
    return;
  }
  if (code === 'invalid_fabric_role') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry publish failed: invalid role ${String(error && error.role || '').trim() || 'role'}.\x1b[0m`);
    return;
  }
  if (code === 'invalid_fabric_runtime') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry publish failed: invalid runtime ${String(error && error.runtime || '').trim() || 'runtime'}.\x1b[0m`);
    return;
  }
  if (code === 'invalid_fabric_transport') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry publish failed: invalid transport ${String(error && error.transport || '').trim() || 'transport'}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_from_server_accounts_failed') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry publish failed: could not read server management accounts (${String((error && error.message) || 'unknown_error')}).\x1b[0m`);
    return;
  }
  if (code === 'fabric_node_not_found') {
    consoleImpl.error('\x1b[31m[aih] fabric registry heartbeat failed: node is not registered yet.\x1b[0m');
    return;
  }
  if (code === 'forbidden_fabric_node_owner') {
    consoleImpl.error('\x1b[31m[aih] fabric registry heartbeat failed: device token does not own this node.\x1b[0m');
    return;
  }
  if (code.startsWith('invalid_probe_target')) {
    consoleImpl.error(`\x1b[31m[aih] fabric transport probe failed: invalid endpoint ${String(error && error.target || '').trim() || 'target'}.\x1b[0m`);
    return;
  }
  consoleImpl.error(`\x1b[31m[aih] fabric command failed: ${String((error && error.message) || code)}\x1b[0m`);
}

async function runFabricCommandRouter(args = [], deps = {}) {
  const processObj = deps.processObj || process;
  const consoleImpl = deps.consoleImpl || console;
  const action = String((Array.isArray(args) ? args[1] : '') || '').trim();

  if (isHelp(action)) {
    showFabricUsage(consoleImpl);
    processObj.exit(0);
    return 0;
  }

  if (action !== 'transport' && action !== 'registry' && action !== 'broker') {
    consoleImpl.error(`\x1b[31m[aih] unknown fabric command: ${action}\x1b[0m`);
    showFabricUsage(consoleImpl);
    processObj.exit(1);
    return 1;
  }

  if (action === 'broker') {
    const brokerArgs = Array.isArray(args) ? args.slice(2) : [];
    const subcommand = String(brokerArgs[0] || '').trim();
    if (isHelp(subcommand)) {
      showFabricUsage(consoleImpl);
      processObj.exit(brokerArgs.length === 0 ? 1 : 0);
      return brokerArgs.length === 0 ? 1 : 0;
    }
    if (subcommand !== 'connect') {
      consoleImpl.error(`\x1b[31m[aih] unknown fabric broker command: ${subcommand}\x1b[0m`);
      showFabricUsage(consoleImpl);
      processObj.exit(1);
      return 1;
    }
    const commandArgs = brokerArgs.slice(1);
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    try {
      const result = await (deps.runFabricBrokerConnect || runFabricBrokerConnect)(commandArgs, deps);
      if (result && result.json) {
        writeStdout(processObj, `${JSON.stringify({
          ok: Boolean(result.ok),
          serverId: result.serverId,
          brokerUrl: result.brokerUrl,
          localUrl: result.localUrl,
          sessionId: result.sessionId,
          mode: result.mode,
          reason: result.reason
        })}\n`);
      } else {
        writeStdout(processObj, `${formatFabricBrokerConnectReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'registry') {
    const registryArgs = Array.isArray(args) ? args.slice(2) : [];
    const subcommand = String(registryArgs[0] || '').trim();
    if (isHelp(subcommand)) {
      showFabricUsage(consoleImpl);
      processObj.exit(registryArgs.length === 0 ? 1 : 0);
      return registryArgs.length === 0 ? 1 : 0;
    }
    if (subcommand !== 'publish' && subcommand !== 'heartbeat' && subcommand !== 'agent') {
      consoleImpl.error(`\x1b[31m[aih] unknown fabric registry command: ${subcommand}\x1b[0m`);
      showFabricUsage(consoleImpl);
      processObj.exit(1);
      return 1;
    }
    const commandArgs = registryArgs.slice(1);
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    if (subcommand === 'agent') {
      if (commandArgs[0] === 'service') {
        try {
          const result = (deps.runFabricRegistryAgentService || runFabricRegistryAgentService)(commandArgs.slice(1), deps);
          printFabricRegistryAgentServiceResult(result, processObj);
          processObj.exit(result && result.ok ? 0 : 1);
          return result && result.ok ? 0 : 1;
        } catch (error) {
          printFabricError(error, consoleImpl);
          processObj.exit(1);
          return 1;
        }
      }
      try {
        const json = hasJsonFlag(commandArgs);
        const result = await (deps.runFabricRegistryAgent || runFabricRegistryAgent)(commandArgs, {
          ...deps,
          onEvent: deps.onEvent || (json ? null : (event) => {
            writeStdout(processObj, `${formatFabricRegistryAgentEvent(event)}\n`);
          })
        });
        if (result && result.json) {
          writeStdout(processObj, `${JSON.stringify({
            ok: Boolean(result.ok),
            endpoint: result.endpoint,
            nodeId: result.nodeId,
            status: result.status,
            relayStatus: result.relayStatus,
            transports: result.transports,
            intervalMs: result.intervalMs,
            count: result.count,
            attempts: result.attempts,
            failures: result.failures,
            probes: result.probes,
            lastResult: result.lastResult,
            lastError: result.lastError
          })}\n`);
        } else {
          writeStdout(processObj, `${formatFabricRegistryAgentReport(result)}\n`);
        }
        processObj.exit(result && result.ok ? 0 : 1);
        return result && result.ok ? 0 : 1;
      } catch (error) {
        printFabricError(error, consoleImpl);
        processObj.exit(1);
        return 1;
      }
    }
    if (subcommand === 'heartbeat') {
      try {
        const result = await (deps.runFabricRegistryHeartbeat || runFabricRegistryHeartbeat)(commandArgs, deps);
        if (result && result.json) {
          writeStdout(processObj, `${JSON.stringify({
            ok: Boolean(result.ok),
            endpoint: result.endpoint,
            nodeId: result.nodeId,
            status: result.status,
            relayStatus: result.relayStatus,
            transports: result.transports,
            result: result.result
          })}\n`);
        } else {
          writeStdout(processObj, `${formatFabricRegistryHeartbeatReport(result)}\n`);
        }
        processObj.exit(result && result.ok ? 0 : 1);
        return result && result.ok ? 0 : 1;
      } catch (error) {
        printFabricError(error, consoleImpl);
        processObj.exit(1);
        return 1;
      }
    }
    try {
      const result = await (deps.runFabricRegistryPublish || runFabricRegistryPublish)(commandArgs, deps);
      if (result && result.json) {
        writeStdout(processObj, `${JSON.stringify({
          ok: Boolean(result.ok),
          endpoint: result.endpoint,
          nodeId: result.nodeId,
          roles: result.roles,
          projects: result.projects,
          runtimes: result.runtimes,
          transports: result.transports,
          fromServer: result.fromServer,
          result: result.result
        })}\n`);
      } else {
        writeStdout(processObj, `${formatFabricRegistryPublishReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  const transportArgs = Array.isArray(args) ? args.slice(2) : [];
  const subcommand = String(transportArgs[0] || '').trim();
  if (isHelp(subcommand)) {
    showFabricUsage(consoleImpl);
    processObj.exit(transportArgs.length === 0 ? 1 : 0);
    return transportArgs.length === 0 ? 1 : 0;
  }
  if (
    subcommand !== 'probe'
    && subcommand !== 'echo'
    && subcommand !== 'echo-server'
    && subcommand !== 'tcp-echo'
    && subcommand !== 'tcp-echo-server'
  ) {
    consoleImpl.error(`\x1b[31m[aih] unknown fabric transport command: ${subcommand}\x1b[0m`);
    showFabricUsage(consoleImpl);
    processObj.exit(1);
    return 1;
  }

  const commandArgs = transportArgs.slice(1);
  if (hasHelpArg(commandArgs)) {
    showFabricUsage(consoleImpl);
    processObj.exit(0);
    return 0;
  }
  try {
    if (subcommand === 'echo-server' || subcommand === 'tcp-echo-server') {
      const runner = subcommand === 'tcp-echo-server'
        ? (deps.runFabricTransportTcpEchoServer || runFabricTransportTcpEchoServer)
        : (deps.runFabricTransportEchoServer || runFabricTransportEchoServer);
      const result = await runner(commandArgs, deps);
      const exitCode = result && result.ok === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    let runner = deps.runFabricTransportProbe || runFabricTransportProbe;
    if (subcommand === 'echo') runner = deps.runFabricTransportEcho || runFabricTransportEcho;
    if (subcommand === 'tcp-echo') runner = deps.runFabricTransportTcpEcho || runFabricTransportTcpEcho;
    const result = await runner(commandArgs, deps);
    if (result && result.json) {
      writeStdout(processObj, `${JSON.stringify({
        ok: Boolean(result.ok),
        generatedAt: result.generatedAt,
        command: result.command,
        timeoutMs: result.timeoutMs,
        httpMethod: result.httpMethod,
        target: result.target,
        count: result.count,
        payloadSize: result.payloadSize,
        durationMs: result.durationMs,
        successes: result.successes,
        failures: result.failures,
        rttMs: result.rttMs,
        probes: result.probes
      })}\n`);
    } else if (subcommand === 'echo') {
      writeStdout(processObj, `${formatFabricTransportEchoReport(result)}\n`);
    } else if (subcommand === 'tcp-echo') {
      writeStdout(processObj, `${formatFabricTransportTcpEchoReport(result)}\n`);
    } else {
      writeStdout(processObj, `${formatFabricTransportProbeReport(result)}\n`);
    }
    processObj.exit(result && result.ok ? 0 : 1);
    return result && result.ok ? 0 : 1;
  } catch (error) {
    printFabricError(error, consoleImpl);
    processObj.exit(1);
    return 1;
  }
}

module.exports = {
  runFabricCommandRouter,
  showFabricUsage
};
