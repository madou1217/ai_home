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
  formatFabricTransportReadinessClientReport,
  runFabricTransportReadinessClientCommand
} = require('../services/fabric/transport-readiness-client');
const {
  formatFabricTransportPrerequisitesReport,
  runFabricTransportPrerequisitesCommand
} = require('../services/fabric/transport-prerequisites');
const {
  formatFabricTransportPromotionGateReport,
  runFabricTransportPromotionGateCommand
} = require('../services/fabric/transport-promotion-gate');
const {
  formatFabricTransportConfigReport,
  runFabricTransportConfigCommand
} = require('../services/fabric/transport-config');
const {
  formatFabricTransportRelayDurabilityReport,
  runFabricTransportRelayDurabilityCommand
} = require('../services/fabric/transport-relay-durability');
const {
  formatFabricTransportWebTransportReport,
  runFabricTransportWebTransportCommand
} = require('../services/fabric/transport-webtransport');
const {
  formatFabricTransportTurnRelayReport,
  runFabricTransportTurnRelayCommand
} = require('../services/fabric/transport-turn-relay');
const {
  formatFabricTransportCloudEdgeReport,
  runFabricTransportCloudEdgeCommand
} = require('../services/fabric/transport-cloud-edge');
const {
  formatFabricTransportStatusReport,
  runFabricTransportStatusCommand
} = require('../services/fabric/transport-status');
const {
  formatFabricNodesClientReport,
  runFabricNodesClientCommand
} = require('../services/fabric/nodes-client');
const {
  formatFabricSessionStartClientReport,
  runFabricSessionStartClientCommand
} = require('../services/fabric/session-start-client');
const {
  formatFabricSessionControlClientReport,
  runFabricSessionControlClientCommand
} = require('../services/fabric/session-control-client');
const {
  formatFabricClosureAuditReport,
  formatFabricClosureStatusReport,
  formatFabricClosureVerifyReport,
  runFabricClosureAuditCommand,
  runFabricClosureStatusCommand,
  runFabricClosureVerifyCommand
} = require('../services/fabric/closure-audit');
const {
  formatFabricClosureResumeCheckReport,
  runFabricClosureResumeCheckCommand
} = require('../services/fabric/closure-resume-check');
const {
  formatFabricProviderAccountsReport,
  runFabricProviderAccountsCommand
} = require('../services/fabric/provider-accounts');
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
  const stdout = processObj && processObj.stdout && typeof processObj.stdout.write === 'function'
    ? processObj.stdout
    : process.stdout;
  if (stdout !== process.stdout) {
    stdout.write(value);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    stdout.write(value, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function showFabricUsage(consoleImpl = console) {
  consoleImpl.log(`
\x1b[36mAIH Fabric\x1b[0m - Server/profile/node/relay fabric tooling

\x1b[33mUsage:\x1b[0m
  aih fabric transport probe <endpoint...> [--timeout-ms N] [--method HEAD|GET] [--json]
  AIH_MANAGEMENT_KEY=<key> aih fabric transport echo <ws-url> [--count N] [--payload-size BYTES] [--insecure] [--json]
  aih fabric transport echo-server [--host HOST] [--port PORT] [--path PATH] [--tls-key FILE --tls-cert FILE] [--json]
  aih fabric transport tcp-echo <tcp-url> [--count N] [--payload-size BYTES] [--json]
  aih fabric transport tcp-echo-server [--host HOST] [--port PORT] [--json]
  aih fabric transport readiness [--endpoint URL] [--profile-id ID] [--node-id ID] [--json]
  aih fabric transport status [--endpoint URL] [--profile-id ID] [--node-id ID] [--json]
  aih fabric transport prerequisites [--endpoint URL] [--ssh USER@HOST] [--ssh-key FILE] [--turn-ice-server URL] [--json]
  aih fabric transport promotion-gate [--endpoint URL] [--ssh USER@HOST] [--ssh-key FILE] [--node-id ID] [--publish-promotion] [--turn-ice-server URL] [--json]
  aih fabric transport cloud-edge [--endpoint URL] [--ssh USER@HOST] [--ssh-key FILE] [--json]
  aih fabric transport turn-relay [--endpoint URL] [--turn-ice-server URL] [--turn-username USER] [--json]
  aih fabric transport webtransport [--endpoint URL] [--webtransport-url URL] [--json]
  aih fabric transport relay-durability [--endpoint URL] [--rounds N] [--count-per-round N] [--json]
  aih fabric transport config show|set|clear [--json]
  aih fabric closure status [--node-id ID] [--provider opencode] [--json]
  aih fabric closure audit [--node-id ID] [--provider opencode] [--skip-session] [--skip-cloud-edge] [--fail-on-incomplete] [--json]
  aih fabric closure verify [--node-id ID] [--provider opencode] [--diagnostics-file FILE] [--handoff-file FILE] [--json]
  aih fabric closure resume-check --handoff-file FILE [--skip-cloud-api-check] [--json]
  aih fabric provider accounts audit [--endpoint URL] [--profile-id ID] [--providers codex,claude,agy,opencode] [--json]
  aih fabric provider accounts revalidate --yes [--endpoint URL] [--profile-id ID] [--providers codex,claude,agy,opencode] [--json]
  aih fabric provider accounts reauth --provider PROVIDER --account-ref REF [--endpoint URL] [--profile-id ID] [--wait-auth-url-ms N] [--json]
  aih fabric provider accounts auth-job get|cancel|callback --job-id ID [--callback-url URL|--code CODE] [--endpoint URL] [--profile-id ID] [--json]
  aih fabric nodes [node-id] [--endpoint URL] [--profile-id ID] [--json]
  aih fabric session start <node-id> --provider PROVIDER --prompt TEXT [--account-ref REF] [--project-id ID] [--project-path PATH] [--json]
  aih fabric session attach <node-id> --run-id RUN [--cursor N] [--json]
  aih fabric session events <node-id> --run-id RUN [--cursor N] [--limit N] [--json]
  aih fabric session message <node-id> --run-id RUN --text TEXT [--json]
  aih fabric session slash <node-id> --run-id RUN --command /status [--json]
  aih fabric session stop <node-id> --run-id RUN [--json]
  aih fabric registry publish <server-url> --management-key KEY [--node-id ID] [--name NAME] [--relay-node] [--project PATH] [--runtime codex:tui] [--from-server] [--json]
  aih fabric registry heartbeat <server-url> --management-key KEY --node-id ID [--status online] [--relay-status online] [--transport relay=online] [--json]
  aih fabric registry agent <server-url> --management-key KEY --node-id ID [--interval-ms 30000] [--transport relay=online] [--probe-transport relay=tcp://host:port] [--probe-count N] [--json]
  aih fabric registry agent service install <server-url> --node-id ID [--management-key-file FILE] [--probe-transport relay=tcp://host:port]
  aih fabric registry agent service status --node-id ID
  aih fabric registry agent service uninstall --node-id ID
  aih fabric broker connect <broker-url> --server-id ID --token TOKEN [--local-url http://127.0.0.1:9527] [--reconnect-delay-ms 3000] [--max-attempts 0] [--json]

\x1b[33mExamples:\x1b[0m
  aih fabric transport probe tcp://155.248.183.169:22 --json
  aih fabric transport probe https://server.example.com --timeout-ms 3000
  aih fabric transport probe wss://server.example.com/v0/relay/node
  aih fabric transport echo ws://127.0.0.1:8765/echo --count 20 --json
  aih fabric transport echo-server --host 0.0.0.0 --port 8765 --path /echo
  aih fabric transport tcp-echo tcp://127.0.0.1:8766 --count 20 --json
  aih fabric transport tcp-echo-server --host 0.0.0.0 --port 8766
  aih fabric transport readiness --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --node-id aws-current-node --json
  aih fabric transport status --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport promotion-gate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport turn-relay --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport webtransport --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json
  aih fabric transport relay-durability --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --rounds 6 --count-per-round 20
  aih fabric transport config set --turn-ice-server turn:turn.example.com:3478 --turn-username user --turn-credential secret
  aih fabric closure status --node-id aws-current-node --provider opencode --json
  aih fabric closure audit --node-id aws-current-node --provider opencode --json
  aih fabric closure verify --node-id aws-current-node --provider opencode --diagnostics-file /tmp/aih-fabric-closure-verify.json --handoff-file /tmp/aih-fabric-closure-handoff.json --json
  aih fabric closure resume-check --handoff-file /tmp/aih-fabric-closure-handoff.json --json
  aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex,claude,agy,opencode --json
  aih fabric provider accounts revalidate --yes --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers opencode --json
  aih fabric provider accounts reauth --provider codex --account-ref acct_0123456789abcdef0123 --json
  aih fabric provider accounts auth-job cancel --job-id "$JOB_ID" --json
  aih fabric nodes aws-current-node --json
  aih fabric session start local-mac-remote-node --provider codex --prompt "hello" --json
  aih fabric session events local-mac-remote-node --run-id "$RUN_ID" --json
  aih fabric session message local-mac-remote-node --run-id "$RUN_ID" --text "hello" --json
  aih fabric session slash local-mac-remote-node --run-id "$RUN_ID" --command /status --json
  aih fabric session stop local-mac-remote-node --run-id "$RUN_ID" --json
  aih fabric registry publish https://server.example.com --management-key "$AIH_MANAGEMENT_KEY" --node-id home-mac --relay-node --project . --runtime codex:tui --json
  aih fabric registry publish http://127.0.0.1:8317 --management-key "$AIH_MANAGEMENT_KEY" --from-server --relay-node --json
  aih fabric registry heartbeat http://127.0.0.1:8317 --management-key "$AIH_MANAGEMENT_KEY" --node-id home-mac --relay-status online --transport relay=online --json
  aih fabric registry agent http://127.0.0.1:8317 --management-key "$AIH_MANAGEMENT_KEY" --node-id home-mac --relay-status online --transport relay=online
  aih fabric registry agent http://127.0.0.1:8317 --management-key "$AIH_MANAGEMENT_KEY" --node-id relay-1 --probe-transport relay=tcp://127.0.0.1:8766 --count 2 --json
  aih fabric registry agent service install http://127.0.0.1:8317 --node-id relay-1 --management-key-file /tmp/management-key --probe-transport relay=tcp://127.0.0.1:8766
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
  transport readiness reads a Server profile and never prints its Management Key.
  transport status aggregates readiness and cloud-edge preflight into one current closure report.
  transport prerequisites runs the real M6 external prerequisite audit for TURN/WebTransport/multipath promotion.
  transport promotion-gate runs the real aggregate M6 gate and keeps advanced promotion separate from relay fallback. --publish-promotion writes a passing WebRTC promotion through the remote Server Management Key over SSH.
  transport cloud-edge runs a read-only AWS edge preflight for UDP arrival, host firewall state, and cloud API credential readiness.
  transport turn-relay checks TURN relay-only WebRTC readiness and never prints raw TURN credentials.
  transport webtransport runs the real browser WebTransport probe and reports H3/WebTransport blockers.
  transport relay-durability runs a repeatable real echo durability gate for the current default relay.
  transport config stores external transport probe inputs; it never marks a transport ready.
  closure status is the cheap product entry for "where are we now"; it reads node/transport/provider gates and skips session proof plus cloud-edge deep diagnostics.
  closure audit aggregates the selected Server registry, node capabilities, transport status, provider account gates, and an optional real session marker proof.
  closure verify is the product workflow entry for business closure, stream proof, failure ledger, and repeat-prevention output; it reuses closure audit without duplicating logic.
  closure resume-check reads a closure handoff plus current transport/cloud API/provider inputs and reports whether re-running closure proof is justified.
  Server profiles are managed by aih server add|ls|use|remove with Server URL + Management Key.
  provider accounts audit is read-only; --endpoint/--profile-id selects a Server profile, derives the node SSH binding, and never uploads local credentials. provider accounts revalidate requires --yes and clears remote runtime blockers before real session guards.
  provider accounts reauth starts a real remote OAuth job on the selected Server and returns the job/auth URL; auth-job get/cancel/callback continues that same remote job through the Management Key and never copies local credentials.
  nodes reads the selected Server registry and explains each node's server/relay/project/runtime/ssh capabilities.
  session start first checks the node inventory action gate, then calls the protected device-node-session-start API.
  session attach/events/message/slash/stop reuse the selected Server profile and protected session routes.
  registry agent service imports --management-key-file into app-state.db once; service files and runtime argv contain only nodeId.
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
  if (code === 'missing_management_key') {
    consoleImpl.error('\x1b[31m[aih] fabric registry request failed: pass --management-key or set AIH_MANAGEMENT_KEY.\x1b[0m');
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
  if (code === 'missing_management_key_file') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent service failed: import the Server Management Key with --management-key-file; later installs reuse app-state.db.\x1b[0m');
    return;
  }
  if (code === 'management_key_file_unreadable') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry agent failed: Management Key file is unreadable ${String(error && error.file || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_agent_service_management_key_not_allowed') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent service failed: do not pass --management-key; use --management-key-file for one-time DB import.\x1b[0m');
    return;
  }
  if (code === 'fabric_agent_management_key_file_not_allowed') {
    consoleImpl.error('\x1b[31m[aih] fabric registry agent failed: runtime key files are disabled; use the Management Key stored in app-state.db or AIH_MANAGEMENT_KEY for a foreground run.\x1b[0m');
    return;
  }
  if (code === 'fabric_agent_service_count_not_allowed') {
    consoleImpl.error(`\x1b[31m[aih] fabric registry agent service failed: ${String(error && error.flag || 'that option')} is not valid for a persistent service.\x1b[0m`);
    return;
  }
  if (code === 'ready_server_profile_missing') {
    consoleImpl.error('\x1b[31m[aih] fabric command failed: no ready Server is configured. Run aih server add first.\x1b[0m');
    return;
  }
  if (code === 'readiness_request_timeout') {
    consoleImpl.error(`\x1b[31m[aih] fabric transport readiness failed: request timed out ${String(error && error.detail || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_nodes_request_timeout') {
    consoleImpl.error(`\x1b[31m[aih] fabric nodes failed: request timed out ${String(error && error.detail || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_session_start_request_timeout') {
    consoleImpl.error(`\x1b[31m[aih] fabric session start failed: request timed out ${String(error && error.detail || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'fabric_session_control_request_timeout') {
    consoleImpl.error(`\x1b[31m[aih] fabric session command failed: request timed out ${String(error && error.detail || '').trim()}.\x1b[0m`);
    return;
  }
  if (code === 'missing_fabric_session_node_id') {
    consoleImpl.error('\x1b[31m[aih] fabric session failed: pass a node id or --node-id.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_session_provider') {
    consoleImpl.error('\x1b[31m[aih] fabric session start failed: pass --provider.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_session_prompt') {
    consoleImpl.error('\x1b[31m[aih] fabric session start failed: pass --prompt.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_session_run_id') {
    consoleImpl.error('\x1b[31m[aih] fabric session failed: pass --run-id.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_session_text') {
    consoleImpl.error('\x1b[31m[aih] fabric session message failed: pass --text.\x1b[0m');
    return;
  }
  if (code === 'missing_fabric_session_slash_command') {
    consoleImpl.error('\x1b[31m[aih] fabric session slash failed: pass --command.\x1b[0m');
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

  if (action !== 'transport' && action !== 'registry' && action !== 'broker' && action !== 'nodes' && action !== 'session' && action !== 'closure' && action !== 'provider') {
    consoleImpl.error(`\x1b[31m[aih] unknown fabric command: ${action}\x1b[0m`);
    showFabricUsage(consoleImpl);
    processObj.exit(1);
    return 1;
  }

  if (action === 'closure') {
    const closureArgs = Array.isArray(args) ? args.slice(2) : [];
    const subcommand = String(closureArgs[0] || '').trim();
    if (isHelp(subcommand)) {
      showFabricUsage(consoleImpl);
      processObj.exit(closureArgs.length === 0 ? 1 : 0);
      return closureArgs.length === 0 ? 1 : 0;
    }
    if (subcommand !== 'status' && subcommand !== 'audit' && subcommand !== 'verify' && subcommand !== 'resume-check') {
      consoleImpl.error(`\x1b[31m[aih] unknown fabric closure command: ${subcommand}\x1b[0m`);
      showFabricUsage(consoleImpl);
      processObj.exit(1);
      return 1;
    }
    const commandArgs = closureArgs.slice(1);
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    try {
      const runner = subcommand === 'resume-check'
        ? (deps.runFabricClosureResumeCheckCommand || runFabricClosureResumeCheckCommand)
        : (subcommand === 'verify'
          ? (deps.runFabricClosureVerifyCommand || runFabricClosureVerifyCommand)
          : (subcommand === 'status'
            ? (deps.runFabricClosureStatusCommand || runFabricClosureStatusCommand)
            : (deps.runFabricClosureAuditCommand || runFabricClosureAuditCommand)));
      const result = await runner(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else if (subcommand === 'resume-check') {
        await writeStdout(processObj, `${formatFabricClosureResumeCheckReport(result)}\n`);
      } else if (subcommand === 'status') {
        await writeStdout(processObj, `${formatFabricClosureStatusReport(result)}\n`);
      } else if (subcommand === 'verify') {
        await writeStdout(processObj, `${formatFabricClosureVerifyReport(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricClosureAuditReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'provider') {
    const providerArgs = Array.isArray(args) ? args.slice(2) : [];
    const domain = String(providerArgs[0] || '').trim();
    const subcommand = String(providerArgs[1] || '').trim();
    if (isHelp(domain) || domain !== 'accounts' || isHelp(subcommand)) {
      showFabricUsage(consoleImpl);
      processObj.exit(providerArgs.length === 0 || domain !== 'accounts' ? 1 : 0);
      return providerArgs.length === 0 || domain !== 'accounts' ? 1 : 0;
    }
    if (subcommand !== 'audit' && subcommand !== 'revalidate' && subcommand !== 'reauth' && subcommand !== 'auth-job') {
      consoleImpl.error(`\x1b[31m[aih] unknown fabric provider accounts command: ${subcommand}\x1b[0m`);
      showFabricUsage(consoleImpl);
      processObj.exit(1);
      return 1;
    }
    const commandArgs = providerArgs.slice(2);
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    try {
      const result = await (deps.runFabricProviderAccountsCommand || runFabricProviderAccountsCommand)(subcommand, commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricProviderAccountsReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'nodes') {
    const commandArgs = Array.isArray(args) ? args.slice(2) : [];
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    try {
      const result = await (deps.runFabricNodesClientCommand || runFabricNodesClientCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricNodesClientReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
  }

  if (action === 'session') {
    const sessionArgs = Array.isArray(args) ? args.slice(2) : [];
    const subcommand = String(sessionArgs[0] || '').trim();
    if (isHelp(subcommand)) {
      showFabricUsage(consoleImpl);
      processObj.exit(sessionArgs.length === 0 ? 1 : 0);
      return sessionArgs.length === 0 ? 1 : 0;
    }
    const controlCommands = new Set(['attach', 'events', 'message', 'slash', 'stop']);
    if (subcommand !== 'start' && !controlCommands.has(subcommand)) {
      consoleImpl.error(`\x1b[31m[aih] unknown fabric session command: ${subcommand}\x1b[0m`);
      showFabricUsage(consoleImpl);
      processObj.exit(1);
      return 1;
    }
    const commandArgs = sessionArgs.slice(1);
    if (hasHelpArg(commandArgs)) {
      showFabricUsage(consoleImpl);
      processObj.exit(0);
      return 0;
    }
    try {
      const result = subcommand === 'start'
        ? await (deps.runFabricSessionStartClientCommand || runFabricSessionStartClientCommand)(commandArgs, deps)
        : await (deps.runFabricSessionControlClientCommand || runFabricSessionControlClientCommand)(subcommand, commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else if (subcommand === 'start') {
        await writeStdout(processObj, `${formatFabricSessionStartClientReport(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricSessionControlClientReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    } catch (error) {
      printFabricError(error, consoleImpl);
      processObj.exit(1);
      return 1;
    }
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
        await writeStdout(processObj, `${JSON.stringify({
          ok: Boolean(result.ok),
          serverId: result.serverId,
          brokerUrl: result.brokerUrl,
          localUrl: result.localUrl,
          sessionId: result.sessionId,
          mode: result.mode,
          reason: result.reason
        })}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricBrokerConnectReport(result)}\n`);
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
          await writeStdout(processObj, `${JSON.stringify({
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
          await writeStdout(processObj, `${formatFabricRegistryAgentReport(result)}\n`);
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
          await writeStdout(processObj, `${JSON.stringify({
            ok: Boolean(result.ok),
            endpoint: result.endpoint,
            nodeId: result.nodeId,
            status: result.status,
            relayStatus: result.relayStatus,
            transports: result.transports,
            result: result.result
          })}\n`);
        } else {
          await writeStdout(processObj, `${formatFabricRegistryHeartbeatReport(result)}\n`);
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
        await writeStdout(processObj, `${JSON.stringify({
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
        await writeStdout(processObj, `${formatFabricRegistryPublishReport(result)}\n`);
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
    && subcommand !== 'readiness'
    && subcommand !== 'status'
    && subcommand !== 'prerequisites'
    && subcommand !== 'promotion-gate'
    && subcommand !== 'cloud-edge'
    && subcommand !== 'turn-relay'
    && subcommand !== 'webtransport'
    && subcommand !== 'relay-durability'
    && subcommand !== 'config'
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

    if (subcommand === 'readiness') {
      const result = await (deps.runFabricTransportReadinessClientCommand || runFabricTransportReadinessClientCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportReadinessClientReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    }

    if (subcommand === 'status') {
      const result = await (deps.runFabricTransportStatusCommand || runFabricTransportStatusCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportStatusReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'prerequisites') {
      const result = await (deps.runFabricTransportPrerequisitesCommand || runFabricTransportPrerequisitesCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportPrerequisitesReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'promotion-gate') {
      const result = await (deps.runFabricTransportPromotionGateCommand || runFabricTransportPromotionGateCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportPromotionGateReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'cloud-edge') {
      const result = await (deps.runFabricTransportCloudEdgeCommand || runFabricTransportCloudEdgeCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportCloudEdgeReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'webtransport') {
      const result = await (deps.runFabricTransportWebTransportCommand || runFabricTransportWebTransportCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportWebTransportReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'turn-relay') {
      const result = await (deps.runFabricTransportTurnRelayCommand || runFabricTransportTurnRelayCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportTurnRelayReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    if (subcommand === 'config') {
      const result = await (deps.runFabricTransportConfigCommand || runFabricTransportConfigCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportConfigReport(result)}\n`);
      }
      processObj.exit(result && result.ok ? 0 : 1);
      return result && result.ok ? 0 : 1;
    }

    if (subcommand === 'relay-durability') {
      const result = await (deps.runFabricTransportRelayDurabilityCommand || runFabricTransportRelayDurabilityCommand)(commandArgs, deps);
      if (result && result.json) {
        await writeStdout(processObj, `${JSON.stringify(result)}\n`);
      } else {
        await writeStdout(processObj, `${formatFabricTransportRelayDurabilityReport(result)}\n`);
      }
      const exitCode = result && result.exitOk === false ? 1 : 0;
      processObj.exit(exitCode);
      return exitCode;
    }

    let runner = deps.runFabricTransportProbe || runFabricTransportProbe;
    if (subcommand === 'echo') runner = deps.runFabricTransportEcho || runFabricTransportEcho;
    if (subcommand === 'tcp-echo') runner = deps.runFabricTransportTcpEcho || runFabricTransportTcpEcho;
    const result = await runner(commandArgs, deps);
    if (result && result.json) {
      await writeStdout(processObj, `${JSON.stringify({
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
      await writeStdout(processObj, `${formatFabricTransportEchoReport(result)}\n`);
    } else if (subcommand === 'tcp-echo') {
      await writeStdout(processObj, `${formatFabricTransportTcpEchoReport(result)}\n`);
    } else {
      await writeStdout(processObj, `${formatFabricTransportProbeReport(result)}\n`);
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
