'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  buildTransportStatusArgs,
  collectProviderStates,
  formatFabricClosureAuditReport,
  formatFabricClosureStatusReport,
  formatFabricClosureVerifyReport,
  parseArgs,
  runFabricClosureAudit,
  runFabricClosureStatusCommand,
  runFabricClosureVerifyCommand
} = require('../lib/cli/services/fabric/closure-audit');

function createNodesReport() {
  return {
    ok: true,
    targetNode: {
      id: 'aws-current-node',
      name: 'AWS Current Node',
      capabilities: {
        node: true,
        relayNode: true,
        projectHost: true,
        runtimeHost: true,
        sshBootstrap: true,
        transportKinds: ['relay', 'webrtc']
      },
      projects: [{
        id: 'aws-project',
        name: 'aih-fabric-current',
        displayPath: '/home/ubuntu/aih-fabric-current'
      }],
      runtimes: [
        { id: 'aws-opencode', provider: 'opencode', status: 'available' },
        { id: 'aws-codex', provider: 'codex', status: 'blocked' }
      ],
      runtimeGaps: [
        { provider: 'codex', blocker: 'provider_account_unavailable:codex', status: 'blocked' },
        { provider: 'claude', blocker: 'missing_provider_account:claude', status: 'blocked' },
        { provider: 'agy', blocker: 'missing_provider_account:agy', status: 'blocked' }
      ],
      actions: [
        { id: 'open-project', enabled: true },
        { id: 'configure-ssh', enabled: true },
        {
          id: 'start-session:opencode',
          provider: 'opencode',
          enabled: true,
          eligible: true,
          runtimeId: 'aws-opencode',
          runtimeStatus: 'available',
          blockers: []
        },
        {
          id: 'start-session:codex',
          provider: 'codex',
          enabled: false,
          eligible: false,
          runtimeStatus: 'blocked',
          blockers: ['provider_account_unavailable:codex']
        }
      ]
    }
  };
}

function createTransportReport() {
  return {
    ok: true,
    exitOk: true,
    summary: {
      status: 'complete',
      remoteDevelopmentReady: true,
      defaultTransport: 'webrtc',
      fallbackReady: true,
      advancedPromotionReady: true,
      promotedTransports: ['webrtc'],
      blockers: [],
      nextActions: []
    }
  };
}

function createTransportReportWithExternalBlockers() {
  return {
    ok: true,
    exitOk: true,
    summary: {
      status: 'complete',
      remoteDevelopmentReady: true,
      defaultTransport: 'webrtc',
      fallbackReady: true,
      advancedPromotionReady: true,
      promotedTransports: ['webrtc'],
      cloudApiCredentialsReady: false,
      udpReachable: false,
      packetArrivalCaptured: false,
      hostFirewallBlocksUdp: false,
      publicIpv4: '43.207.102.163',
      securityGroupIds: ['sg-01e33f3412fabfded'],
      blockers: [
        'webtransport:webtransport_endpoint_not_configured',
        'omr:openmptcprouter_not_detected',
        'turn_default_udp_9527_unreachable',
        'aws_cli_missing',
        'aws_local_cli_missing'
      ],
      nextActions: []
    }
  };
}

function createTransportReportWithDiagnosticConcurrency() {
  return {
    ok: true,
    exitOk: true,
    summary: {
      status: 'complete',
      remoteDevelopmentReady: true,
      defaultTransport: 'webrtc',
      fallbackReady: true,
      advancedPromotionReady: true,
      promotedTransports: ['webrtc'],
      udpReachable: false,
      packetArrivalCaptured: null,
      blockers: [
        'turn_default_udp_probe_busy'
      ],
      nextActions: [
        'Run only one default UDP transport diagnostic at a time; another probe is already binding UDP 9527.'
      ]
    }
  };
}

function createTransportReportWithDiagnosticContext() {
  return {
    ok: true,
    exitOk: true,
    summary: {
      status: 'complete',
      remoteDevelopmentReady: true,
      defaultTransport: 'webrtc',
      fallbackReady: true,
      advancedPromotionReady: true,
      promotedTransports: ['webrtc'],
      udpReachable: false,
      packetArrivalCaptured: false,
      blockers: [
        'turn_default_udp_target_local_only'
      ],
      nextActions: [
        'Run cloud-edge from the client side; target-local UDP success does not prove public cloud edge reachability.'
      ]
    }
  };
}

test('fabric closure audit parser defaults to current AWS target', () => {
  const options = parseArgs(['--json'], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.nodeId, 'aws-current-node');
  assert.equal(options.provider, 'opencode');
  assert.equal(options.aiHomeDir, '/Users/example/.ai_home');
  assert.equal(options.json, true);
});

test('fabric closure audit parser accepts positional node and strict gate options', () => {
  const options = parseArgs([
    'office-node',
    '--provider',
    'claude',
    '--fail-on-incomplete',
    '--skip-session',
    '--skip-cloud-edge',
    '--with-promotion-gate',
    '--allow-direct-webrtc-promotion'
  ], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.nodeId, 'office-node');
  assert.equal(options.provider, 'claude');
  assert.equal(options.failOnIncomplete, true);
  assert.equal(options.skipSession, true);
  assert.equal(options.skipCloudEdge, true);
  assert.equal(options.withPromotionGate, true);
  assert.equal(options.allowDirectWebrtcPromotion, true);
  const transportArgs = buildTransportStatusArgs(options);
  assert.equal(transportArgs.includes('--with-promotion-gate'), true);
  assert.equal(transportArgs.includes('--allow-direct-webrtc-promotion'), true);
  assert.equal(transportArgs.includes('--skip-cloud-edge'), true);
});

test('fabric closure audit parser accepts diagnostics and handoff output files', () => {
  const options = parseArgs([
    '--diagnostics-file',
    '/tmp/aih-fabric-closure-diagnostics.json',
    '--handoff-file=/tmp/aih-fabric-closure-handoff.json'
  ], {
    HOME: '/Users/example',
    AIH_HOST_HOME: '/Users/example'
  });

  assert.equal(options.diagnosticsFile, '/tmp/aih-fabric-closure-diagnostics.json');
  assert.equal(options.handoffFile, '/tmp/aih-fabric-closure-handoff.json');
});

test('fabric closure audit aggregates node transport runtime and real session proof', async () => {
  const calls = [];
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    sessionMarker: 'AIH_TEST_MARKER',
    eventTimeoutMs: 250,
    pollIntervalMs: 1
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReport(),
    runFabricSessionStartClient: async (options) => {
      calls.push({ type: 'start', prompt: options.prompt });
      assert.match(options.prompt, /AIH_TEST_MARKER/);
      return {
        ok: true,
        result: { runId: 'run-1', status: 'running' },
        transportDecision: {
          selectedTransportKind: 'webrtc',
          fallbackUsed: false
        },
        blockers: []
      };
    },
    runFabricSessionControlClient: async (options) => {
      calls.push({ type: 'events', runId: options.runId });
      return {
        ok: true,
        result: {
          events: [
            { type: 'delta', text: 'AIH_TEST_MARKER' },
            { type: 'result', text: 'AIH_TEST_MARKER' },
            { type: 'done' }
          ],
          completed: true,
          cursor: 3
        },
        summary: {
          cursor: 3,
          completed: true,
          eventCount: 3,
          eventTypes: { delta: 1, result: 1, done: 1 },
          terminalTail: 'AIH_TEST_MARKER'
        },
        blockers: []
      };
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.status, 'usable_with_blockers');
  assert.equal(report.summary.coreReady, true);
  assert.equal(report.summary.selectedTransportKind, 'webrtc');
  assert.equal(report.summary.fallbackUsed, false);
  assert.deepEqual(report.capabilities.startableProviders, ['opencode']);
  assert.equal(report.closurePlan.state, 'usable_with_external_blockers');
  assert.equal(report.closurePlan.items.some((item) => item.id === 'provider-codex-blocked'), true);
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'provider-codex-blocked')
      .commands
      .some((command) => command.includes('provider accounts reauth')),
    false
  );
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'provider-codex-blocked')
      .commands
      .includes('aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json'),
    true
  );
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'provider-codex-blocked')
      .commands
      .includes('aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --yes --json'),
    true
  );
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'provider-codex-blocked')
      .blockerDetails[0]
      .owner,
    'operator'
  );
  assert.equal(report.closurePlan.nextQueue[0].domain, 'provider_account');
  assert.equal(report.closurePlan.nextQueue[0].owner, 'operator');
  assert.equal(report.failureLedger.status, 'usable_with_recorded_failures');
  assert.equal(report.failureLedger.businessClosure.usable, true);
  assert.equal(report.failureLedger.streamProof.ok, true);
  assert.equal(report.failureLedger.summary.allExternal, true);
  assert.equal(report.failureLedger.automation.state, 'awaiting_external_input');
  assert.equal(report.failureLedger.automation.canContinueWithoutInput, false);
  assert.equal(report.failureLedger.executionDecision.decision, 'stop_awaiting_external_input');
  assert.equal(report.failureLedger.executionDecision.canContinueWithoutInput, false);
  assert.equal(
    report.failureLedger.executionDecision.reason.includes('Business closure and stream proof already passed'),
    true
  );
  assert.deepEqual(
    report.failureLedger.externalPrerequisites.map((item) => item.id),
    ['provider-credentials']
  );
  assert.equal(
    report.failureLedger.executionDecision.resumeWhen.some((item) => item.includes('provider accounts')),
    true
  );
  assert.equal(report.failureLedger.externalPrerequisites[0].failureIds.includes('provider-codex-blocked'), true);
  assert.equal(
    report.failureLedger.failures.some((item) => item.id === 'provider-codex-blocked'
      && item.rootCause.includes('AWS-side account login/import/revalidation')),
    true
  );
  assert.equal(
    report.failureLedger.repeatPrevention.some((rule) => rule.includes('already proven')),
    true
  );
  assert.equal(report.sessionProof.markerFound, true);
  assert.equal(report.sessionProof.doneObserved, true);
  assert.equal(report.milestones.find((item) => item.id === 'M4').status, 'pass');
  assert.equal(report.summary.runtimeBlockers.some((item) => item.provider === 'codex'), true);
  const formatted = formatFabricClosureAuditReport(report);
  assert.match(formatted, /^AIH Fabric closure audit/);
  assert.match(formatted, /closure_plan:/);
  assert.match(formatted, /failure_ledger:/);
  assert.match(formatFabricClosureVerifyReport(report), /^AIH Fabric closure verify/);
  assert.equal(calls.filter((item) => item.type === 'events').length, 1);
});

test('fabric closure audit rejects terminal marker echo when runtime is blocked', async () => {
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    sessionMarker: 'AIH_TERMINAL_ECHO_ONLY',
    eventTimeoutMs: 250,
    pollIntervalMs: 1
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReport(),
    runFabricSessionStartClient: async () => ({
      ok: true,
      result: { runId: 'run-blocked', status: 'running' },
      transportDecision: {
        selectedTransportKind: 'webrtc',
        fallbackUsed: false
      },
      blockers: []
    }),
    runFabricSessionControlClient: async () => ({
      ok: true,
      result: {
        events: [
          { type: 'ready' },
          { type: 'terminal-output', text: 'Do not use tools. Output exactly: AIH_TERMINAL_ECHO_ONLY' },
          {
            type: 'runtime-blocked',
            provider: 'opencode',
            accountId: '2',
            status: 'auth_invalid',
            reason: 'upstream_401'
          },
          { type: 'error', code: 'native_runtime_blocked', message: 'Unexpected status 401 Unauthorized' }
        ],
        completed: true,
        cursor: 4
      },
      summary: {
        cursor: 4,
        completed: true,
        eventCount: 4,
        eventTypes: {
          ready: 1,
          'terminal-output': 1,
          'runtime-blocked': 1,
          error: 1
        },
        terminalTail: 'AIH_TERMINAL_ECHO_ONLY'
      },
      blockers: []
    })
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.coreReady, false);
  assert.equal(report.summary.sessionReady, false);
  assert.equal(report.sessionProof.ok, false);
  assert.equal(report.sessionProof.markerFound, false);
  assert.equal(report.sessionProof.doneObserved, false);
  assert.equal(report.sessionProof.blockers.includes('runtime_blocked:opencode:upstream_401'), true);
  assert.equal(report.sessionProof.blockers.includes('native_runtime_blocked'), true);
  assert.equal(report.sessionProof.blockers.includes('session_marker_not_observed'), true);
  assert.equal(report.closurePlan.immediateNext.id, 'provider-opencode-blocked');
  assert.equal(report.closurePlan.nextQueue[0].id, 'provider-opencode-blocked');
  assert.equal(report.closurePlan.nextQueue[1].id, 'session-marker-proof-blocked');
  assert.equal(
    report.closurePlan.immediateNext.command,
    'aih fabric provider accounts revalidate --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers opencode --yes --json'
  );
  assert.equal(report.milestones.find((item) => item.id === 'M4').status, 'blocked');
  assert.equal(report.milestones.find((item) => item.id === 'M5').status, 'blocked');
});

test('fabric closure audit closure plan groups external transport blockers without marking them complete', async () => {
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    skipSession: true
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReportWithExternalBlockers()
  });

  assert.equal(report.ok, true);
  assert.equal(report.closurePlan.state, 'needs_real_session_proof');
  assert.equal(report.closurePlan.immediateNext.id, 'session-marker-proof-unchecked');
  assert.equal(report.closurePlan.nextQueue[0].id, 'session-marker-proof-unchecked');
  assert.equal(report.closurePlan.nextQueue[1].id, 'transport-cloud-edge-udp');
  assert.equal(report.closurePlan.nextQueue[1].requiresConfirmation, true);
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-default-ready').status, 'done');
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-webtransport-h3').status, 'blocked_external');
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-webtransport-h3').requiresConfirmation, true);
  assert.deepEqual(
    report.closurePlan.items.find((item) => item.id === 'transport-webtransport-h3').blockers,
    ['webtransport:webtransport_h3_endpoint_missing']
  );
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-multipath-underlay').status, 'blocked_external');
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-multipath-underlay').requiresConfirmation, true);
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-cloud-edge-udp').status, 'blocked_external');
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-cloud-edge-udp').requiresConfirmation, true);
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-cloud-api-readback').status, 'blocked_external');
  assert.equal(report.closurePlan.items.find((item) => item.id === 'transport-cloud-api-readback').requiresConfirmation, true);
  assert.equal(report.closurePlan.nextQueue[2].id, 'transport-cloud-api-readback');
  assert.equal(report.closurePlan.nextQueue[2].requiresConfirmation, true);
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'transport-cloud-api-readback')
      .blockers
      .includes('aws_local_cli_missing'),
    true
  );
  assert.equal(
    report.closurePlan.items
      .find((item) => item.id === 'transport-cloud-edge-udp')
      .blockerDetails[0]
      .command,
    'aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json'
  );
  assert.equal(report.failureLedger.summary.total, 8);
  assert.equal(report.failureLedger.automation.state, 'can_continue');
  assert.equal(report.failureLedger.automation.canContinueWithoutInput, true);
  assert.equal(report.failureLedger.automation.nextAutomatable.id, 'session-marker-proof-unchecked');
  assert.equal(report.failureLedger.executionDecision.decision, 'continue_automatable');
  assert.equal(report.failureLedger.executionDecision.canContinueWithoutInput, true);
  assert.equal(
    report.failureLedger.executionDecision.nextCommand.includes('fabric closure audit'),
    true
  );
  assert.equal(report.failureLedger.failures[0].id, 'session-marker-proof-unchecked');
  assert.equal(report.failureLedger.failures.some((item) => item.id === 'transport-cloud-edge-udp'
    && item.rootCause.includes('packets do not arrive')), true);
  assert.equal(report.failureLedger.failures.find((item) => item.id === 'transport-cloud-edge-udp').requiresConfirmation, true);
  assert.equal(report.failureLedger.failures.some((item) => item.id === 'transport-webtransport-h3'
    && item.repeatPrevention.includes('HTTPS/H3 endpoint')), true);
  assert.equal(report.failureLedger.failures.find((item) => item.id === 'transport-webtransport-h3').requiresConfirmation, true);
  assert.equal(report.failureLedger.repeatPrevention.some((rule) => rule.includes('one default UDP transport diagnostic')), true);
  assert.deepEqual(
    report.failureLedger.externalPrerequisites.map((item) => item.id),
    ['cloud-udp-policy', 'webtransport-h3-endpoint', 'multipath-underlay', 'provider-credentials']
  );
  assert.equal(
    report.failureLedger.externalPrerequisites
      .find((item) => item.id === 'cloud-udp-policy')
      .failureIds
      .includes('transport-cloud-api-readback'),
    true
  );
  assert.equal(
    report.failureLedger.externalPrerequisites
      .find((item) => item.id === 'webtransport-h3-endpoint')
      .requiredEvidence
      .includes('HTTPS/H3'),
    true
  );
  assert.deepEqual(
    report.failureLedger.externalPrerequisites
      .find((item) => item.id === 'webtransport-h3-endpoint')
      .blockers,
    ['webtransport:webtransport_h3_endpoint_missing']
  );
});

test('fabric closure audit does not classify UDP probe contention as cloud edge external work', async () => {
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    skipSession: true
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReportWithDiagnosticConcurrency()
  });

  const diagnosticItem = report.closurePlan.items.find((item) => item.id === 'transport-diagnostic-concurrency');
  const diagnosticFailure = report.failureLedger.failures.find((item) => item.id === 'transport-diagnostic-concurrency');

  assert.equal(diagnosticItem.status, 'diagnostic_retry');
  assert.equal(diagnosticItem.domain, 'diagnostic_concurrency');
  assert.equal(diagnosticItem.canAutomate, true);
  assert.equal(diagnosticItem.requiresConfirmation, false);
  assert.equal(report.closurePlan.items.some((item) => item.id === 'transport-cloud-edge-udp'), false);
  assert.equal(diagnosticFailure.external, false);
  assert.equal(
    report.failureLedger.externalPrerequisites.some((item) => item.id === 'cloud-udp-policy'),
    false
  );
});

test('fabric closure audit does not classify target-local UDP proof as cloud edge external work', async () => {
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    skipSession: true
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReportWithDiagnosticContext()
  });

  const diagnosticItem = report.closurePlan.items.find((item) => item.id === 'transport-diagnostic-context');
  const diagnosticFailure = report.failureLedger.failures.find((item) => item.id === 'transport-diagnostic-context');

  assert.equal(diagnosticItem.status, 'diagnostic_retry');
  assert.equal(diagnosticItem.domain, 'diagnostic_context');
  assert.equal(diagnosticItem.canAutomate, true);
  assert.equal(diagnosticItem.requiresConfirmation, false);
  assert.equal(report.closurePlan.items.some((item) => item.id === 'transport-cloud-edge-udp'), false);
  assert.equal(diagnosticFailure.external, false);
  assert.equal(
    report.failureLedger.externalPrerequisites.some((item) => item.id === 'cloud-udp-policy'),
    false
  );
});

test('fabric closure audit strict mode fails when non-selected providers remain blocked', async () => {
  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    skipSession: true,
    failOnIncomplete: true
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReport()
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.milestones.find((item) => item.id === 'M4').status, 'unchecked');
  assert.equal(report.summary.externalBlockers.some((item) => item.includes('claude')), true);
});

test('fabric closure verify command records workflow in the generated report', async () => {
  const report = await runFabricClosureVerifyCommand([
    '--skip-session',
    '--json'
  ], {
    env: {
      HOME: '/Users/example',
      AIH_HOST_HOME: '/Users/example'
    },
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReport()
  });

  assert.equal(report.workflow, 'closure_verify');
  assert.equal(report.json, true);
  assert.equal(report.ok, true);
  assert.equal(report.sessionProof.skipped, true);
});

test('fabric closure status command skips session proof and cloud-edge diagnostics', async () => {
  const transportArgsSeen = [];
  let sessionStartCalled = false;
  const report = await runFabricClosureStatusCommand([
    '--node-id',
    'aws-current-node',
    '--provider',
    'opencode',
    '--json'
  ], {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async (args) => {
      transportArgsSeen.push(args);
      return createTransportReportWithExternalBlockers();
    },
    runFabricSessionStartClient: async () => {
      sessionStartCalled = true;
      return {};
    }
  });

  assert.equal(report.workflow, 'closure_status');
  assert.equal(report.json, true);
  assert.equal(report.sessionProof.skipped, true);
  assert.equal(sessionStartCalled, false);
  assert.equal(transportArgsSeen.length, 1);
  assert.equal(transportArgsSeen[0].includes('--skip-cloud-edge'), true);
  assert.equal(report.closurePlan.state, 'usable_with_external_blockers');
  assert.equal(report.closurePlan.immediateNext.id, 'transport-cloud-edge-udp');
  assert.equal(
    report.closurePlan.nextQueue.some((item) => item.id === 'session-marker-proof-unchecked'),
    false
  );
  assert.equal(
    report.failureLedger.failures.some((item) => item.id === 'session-marker-proof-unchecked'),
    false
  );
  assert.equal(report.failureLedger.automation.canContinueWithoutInput, false);
  assert.equal(report.statusView.sessionProof, 'not_run_by_status');
  assert.equal(report.statusView.availableNow.includes('start-session:opencode'), true);
  assert.equal(report.statusView.blockedProviders.some((item) => item.provider === 'codex'), true);
  const formatted = formatFabricClosureStatusReport(report);
  assert.match(formatted, /^AIH Fabric closure status/);
  assert.doesNotMatch(formatted, /session-marker-proof-unchecked/);
});

test('fabric closure verify command writes handoff file without raw reports', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-fabric-handoff-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const handoffFile = path.join(tempDir, 'handoff.json');
  const nodesReport = createNodesReport();
  nodesReport.targetNode.deviceToken = 'raw-device-token-secret';

  const report = await runFabricClosureVerifyCommand([
    '--node-id',
    'aws-current-node',
    '--provider',
    'opencode',
    '--session-marker',
    'AIH_HANDOFF_TEST',
    '--event-timeout-ms',
    '250',
    '--poll-interval-ms',
    '100',
    '--handoff-file',
    handoffFile,
    '--json'
  ], {
    env: {
      HOME: '/Users/example',
      AIH_HOST_HOME: '/Users/example'
    },
    runFabricNodesClient: async () => nodesReport,
    runFabricTransportStatusCommand: async () => createTransportReportWithExternalBlockers(),
    runFabricSessionStartClient: async () => ({
      ok: true,
      result: { runId: 'run-handoff', status: 'running' },
      transportDecision: {
        selectedTransportKind: 'webrtc',
        fallbackUsed: false
      },
      blockers: []
    }),
    runFabricSessionControlClient: async () => ({
      ok: true,
      result: {
        events: [
          { type: 'ready' },
          { type: 'session-created' },
          { type: 'delta', text: 'AIH_HANDOFF_TEST' },
          { type: 'result', text: 'AIH_HANDOFF_TEST' },
          { type: 'done' }
        ],
        completed: true,
        cursor: 5
      },
      summary: {
        cursor: 5,
        completed: true,
        eventCount: 5,
        eventTypes: {
          ready: 1,
          'session-created': 1,
          delta: 1,
          result: 1,
          done: 1
        }
      },
      blockers: []
    })
  });

  const rawHandoff = fs.readFileSync(handoffFile, 'utf8');
  const handoff = JSON.parse(rawHandoff);
  assert.equal(report.workflow, 'closure_verify');
  assert.equal(report.artifacts.handoffFile, handoffFile);
  assert.equal(handoff.schema, 'aih.fabric.closure-handoff.v1');
  assert.equal(handoff.workflow, 'closure_verify');
  assert.equal(handoff.conclusion.businessClosureProven, true);
  assert.equal(handoff.conclusion.streamProofProven, true);
  assert.equal(handoff.conclusion.automationState, 'awaiting_external_input');
  assert.equal(handoff.conclusion.canContinueWithoutInput, false);
  assert.equal(handoff.conclusion.runnableCount, 0);
  assert.equal(handoff.conclusion.executionDecision, 'stop_awaiting_external_input');
  assert.equal(handoff.executionDecision.decision, 'stop_awaiting_external_input');
  assert.equal(handoff.executionDecision.canContinueWithoutInput, false);
  assert.equal(
    handoff.executionDecision.resumeWhen.some((item) => item.includes('HTTPS/H3')),
    true
  );
  assert.equal(
    handoff.failureLedger.executionDecision.decision,
    handoff.executionDecision.decision
  );
  assert.equal(handoff.proof.session.runId, 'run-handoff');
  assert.equal(handoff.proof.session.markerFound, true);
  assert.equal(handoff.proof.session.doneObserved, true);
  assert.equal(handoff.proof.transport.selectedTransportKind, 'webrtc');
  assert.equal(handoff.proof.transport.fallbackUsed, false);
  assert.deepEqual(
    handoff.externalPrerequisites.map((item) => item.id),
    ['cloud-udp-policy', 'webtransport-h3-endpoint', 'multipath-underlay', 'provider-credentials']
  );
  assert.equal(handoff.nextRequiredEvidence.some((item) => item.includes('HTTPS/H3')), true);
  assert.equal(handoff.failures.some((item) => item.id === 'transport-cloud-edge-udp'), true);
  assert.deepEqual(
    handoff.externalPrerequisites
      .find((item) => item.id === 'webtransport-h3-endpoint')
      .blockers,
    ['webtransport:webtransport_h3_endpoint_missing']
  );
  assert.equal(Object.prototype.hasOwnProperty.call(handoff, 'reports'), false);
  assert.equal(rawHandoff.includes('raw-device-token-secret'), false);
});

test('fabric closure audit prioritizes selected provider blocker before session retry', async () => {
  const nodesReport = createNodesReport();
  const codexGap = nodesReport.targetNode.runtimeGaps.find((item) => item.provider === 'codex');
  codexGap.diagnostic = {
    accounts: {
      total: 1,
      schedulable: 0,
      unavailable: 1,
      reasons: [{
        reason: 'runtime:auth_invalid:upstream_401',
        count: 1,
        sampleAccountIds: ['2']
      }]
    }
  };

  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'codex',
    sessionMarker: 'AIH_CODEX_BLOCKED',
    eventTimeoutMs: 250,
    pollIntervalMs: 1
  }, {
    runFabricNodesClient: async () => nodesReport,
    runFabricTransportStatusCommand: async () => createTransportReport(),
    runFabricSessionStartClient: async () => ({
      ok: false,
      blockers: ['provider_account_unavailable:codex']
    })
  });

  assert.equal(report.summary.targetProviderReady, false);
  assert.equal(report.summary.sessionReady, false);
  assert.equal(report.closurePlan.state, 'blocked');
  assert.equal(report.closurePlan.immediateNext.id, 'provider-codex-blocked');
  assert.equal(
    report.closurePlan.immediateNext.command,
    'aih fabric provider accounts audit --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --providers codex --json'
  );
  assert.equal(report.closurePlan.nextQueue[0].id, 'provider-codex-blocked');
  assert.equal(
    report.closurePlan.nextQueue[0].blockers.includes('provider_account_unavailable:codex'),
    true
  );
  assert.equal(report.closurePlan.nextQueue[1].id, 'session-marker-proof-blocked');
});

test('fabric closure audit reports blocked instead of crashing when node inventory is unavailable', async () => {
  const error = new Error('No ready server profile found');
  error.code = 'ready_server_profile_missing';

  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    skipSession: true
  }, {
    runFabricNodesClient: async () => {
      throw error;
    },
    runFabricTransportStatusCommand: async () => ({
      ok: true,
      summary: {
        remoteDevelopmentReady: true,
        defaultTransport: 'webrtc',
        fallbackReady: true,
        advancedPromotionReady: true,
        blockers: [],
        nextActions: []
      }
    })
  });

  assert.equal(report.ok, false);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.status, 'blocked');
  assert.equal(report.summary.nodeReady, false);
  assert.equal(report.steps.nodes.error.code, 'ready_server_profile_missing');
  assert.equal(report.summary.nextActions.some((item) => item.includes('Pair a ready server profile')), true);
  assert.equal(report.closurePlan.immediateNext.id, 'node-registry-pairing');
  assert.equal(report.closurePlan.items.some((item) => item.id === 'provider-opencode-blocked'), false);
  assert.equal(report.closurePlan.items.some((item) => item.id === 'provider-opencode-unchecked'), true);
  assert.equal(report.failureLedger.failures.some((item) => item.id === 'provider-opencode-blocked'), false);
  assert.equal(report.failureLedger.failures.some((item) => item.id === 'provider-opencode-unchecked'
    && item.blockers.includes('ready_server_profile_missing')), true);
  assert.equal(report.failureLedger.automation.state, 'awaiting_operator_input');
  assert.equal(report.failureLedger.automation.canContinueWithoutInput, false);
  assert.equal(report.failureLedger.automation.placeholderCommandCount > 0, true);
  assert.equal(report.failureLedger.executionDecision.decision, 'stop_pair_server_profile');
  assert.equal(
    report.failureLedger.executionDecision.resumeWhen.some((item) => item.includes('paired server profile')),
    true
  );
});

test('fabric closure audit reports session start errors instead of crashing on null step reports', async () => {
  const error = new Error('Remote profile is not paired');
  error.code = 'ready_server_profile_missing';

  const report = await runFabricClosureAudit({
    aiHomeDir: '/tmp/aih-test',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    nodeId: 'aws-current-node',
    provider: 'opencode',
    sessionMarker: 'AIH_SESSION_START_ERROR',
    eventTimeoutMs: 250,
    pollIntervalMs: 1
  }, {
    runFabricNodesClient: async () => createNodesReport(),
    runFabricTransportStatusCommand: async () => createTransportReport(),
    runFabricSessionStartClient: async () => {
      throw error;
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.summary.sessionReady, false);
  assert.equal(report.sessionProof.ok, false);
  assert.equal(report.sessionProof.runId, '');
  assert.deepEqual(report.sessionProof.blockers, ['ready_server_profile_missing']);
  assert.equal(report.closurePlan.immediateNext.id, 'session-marker-proof-blocked');
  assert.equal(report.failureLedger.status, 'blocked_with_recorded_failures');
  assert.equal(report.failureLedger.failures[0].id, 'session-marker-proof-blocked');
  assert.equal(report.failureLedger.failures[0].rootCause.includes('marker appears in events'), true);
});

test('fabric closure audit provider states keep selected blocker visible', () => {
  const states = collectProviderStates(createNodesReport().targetNode, 'codex');
  const codex = states.find((item) => item.provider === 'codex');

  assert.equal(codex.selected, true);
  assert.equal(codex.startEnabled, false);
  assert.deepEqual(codex.blockers, ['provider_account_unavailable:codex']);
});

test('fabric command router routes closure audit JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'closure',
    'audit',
    '--node-id',
    'aws-current-node',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricClosureAuditCommand: async (args) => {
      assert.deepEqual(args, ['--node-id', 'aws-current-node', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        summary: { status: 'usable_with_blockers' }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.summary.status, 'usable_with_blockers');
});

test('fabric command router routes closure status JSON through the cheap status workflow', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'closure',
    'status',
    '--node-id',
    'aws-current-node',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricClosureStatusCommand: async (args) => {
      assert.deepEqual(args, ['--node-id', 'aws-current-node', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        workflow: 'closure_status',
        summary: { status: 'usable_with_blockers' }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.workflow, 'closure_status');
  assert.equal(payload.summary.status, 'usable_with_blockers');
});

test('fabric command router routes closure verify JSON through the closure workflow', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'closure',
    'verify',
    '--node-id',
    'aws-current-node',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricClosureVerifyCommand: async (args) => {
      assert.deepEqual(args, ['--node-id', 'aws-current-node', '--json']);
      return {
        ok: true,
        json: true,
        exitOk: true,
        workflow: 'closure_verify',
        summary: { status: 'usable_with_blockers' }
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.workflow, 'closure_verify');
  assert.equal(payload.summary.status, 'usable_with_blockers');
});
