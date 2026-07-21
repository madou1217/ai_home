'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildLocalMptcpCommand,
  buildRemoteMptcpCommand,
  parseArgs,
  parseKeyValueLines,
  summarizeMultipathReport
} = require('../scripts/fabric-multipath-diagnosis');

test('multipath diagnosis parser defaults to AWS current and default port', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(parsed.sshTarget, 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com');
  assert.equal(parsed.json, false);
});

test('multipath diagnosis commands are read-only capability checks', () => {
  const local = buildLocalMptcpCommand();
  const remote = buildRemoteMptcpCommand();
  assert.match(local, /python3 - <<'PY'/);
  assert.match(remote, /\/proc\/sys\/net\/mptcp\/enabled/);
  assert.match(remote, /ip mptcp endpoint show/);
  assert.doesNotMatch(`${local}\n${remote}`, /sysctl -w/);
  assert.doesNotMatch(`${local}\n${remote}`, /apt /);
  assert.doesNotMatch(`${local}\n${remote}`, /systemctl .*start/);
});

test('parseKeyValueLines accepts shell and sysctl key value formats', () => {
  assert.deepEqual(
    parseKeyValueLines([
      'platform=Linux',
      'net.mptcp.enabled = 1',
      'python_has_IPPROTO_MPTCP=True'
    ].join('\n')),
    {
      platform: 'Linux',
      'net.mptcp.enabled': '1',
      python_has_IPPROTO_MPTCP: 'True'
    }
  );
});

test('summarizeMultipathReport blocks promotion when default AIH listener is plain HTTP', () => {
  const summary = summarizeMultipathReport({
    local: {
      mptcp: {
        stdout: [
          'platform=Darwin',
          'arch=arm64',
          'python_has_IPPROTO_MPTCP=False'
        ].join('\n')
      }
    },
    remote: {
      mptcp: {
        stdout: [
          'platform=Linux',
          'arch=x86_64',
          'proc_net_mptcp_enabled=1',
          'python_has_IPPROTO_MPTCP=True',
          'listener_9527=tcp LISTEN 0 511 0.0.0.0:9527 users:(("node",pid=225598,fd=18))'
        ].join('\n')
      }
    },
    defaultPort: {
      tcp: {
        stdout: JSON.stringify({ ok: true, host: 'example.com', port: 9527, durationMs: 10 })
      },
      readyz: {
        stdout: JSON.stringify({ ok: true, service: 'aih-server', ready: false })
      }
    }
  });

  assert.equal(summary.defaultPortReachable, true);
  assert.equal(summary.remote.kernelMptcp, true);
  assert.equal(summary.remote.pythonMptcpSocket, true);
  assert.equal(summary.promotionReady, false);
  assert.equal(summary.verdict, 'diagnostic_pass_promotion_blocked');
  assert.equal(summary.blockers.includes('default_listener_is_plain_http_not_multipath_transport'), true);
  assert.equal(summary.blockers.includes('local_mptcp_unavailable'), true);
  assert.equal(summary.blockers.includes('openmptcprouter_not_detected'), true);
});

test('summarizeMultipathReport requires default port AIH readiness', () => {
  const summary = summarizeMultipathReport({
    local: {
      mptcp: {
        stdout: [
          'platform=Linux',
          'arch=x86_64',
          'net.mptcp.enabled = 1',
          'python_has_IPPROTO_MPTCP=True',
          'openmptcprouter_marker=omr-tracker'
        ].join('\n')
      }
    },
    remote: {
      mptcp: {
        stdout: [
          'platform=Linux',
          'arch=x86_64',
          'proc_net_mptcp_enabled=1',
          'python_has_IPPROTO_MPTCP=True'
        ].join('\n')
      }
    },
    defaultPort: {
      tcp: {
        stdout: JSON.stringify({ ok: true, host: 'example.com', port: 9527, durationMs: 10 })
      },
      readyz: {
        stdout: JSON.stringify({ ok: true, service: 'custom-multipath-server' })
      }
    }
  });

  assert.equal(summary.defaultPortReachable, false);
  assert.equal(summary.promotionReady, false);
  assert.equal(summary.blockers.includes('default_port_not_aih_readyz'), true);
});

test('summarizeMultipathReport reports promotion ready when every gate is present', () => {
  const summary = summarizeMultipathReport({
    local: {
      mptcp: {
        stdout: [
          'platform=Linux',
          'arch=x86_64',
          'net.mptcp.enabled = 1',
          'python_has_IPPROTO_MPTCP=True',
          'openmptcprouter_marker=omr-tracker'
        ].join('\n')
      }
    },
    remote: {
      mptcp: {
        stdout: [
          'platform=Linux',
          'arch=x86_64',
          'proc_net_mptcp_enabled=1',
          'python_has_IPPROTO_MPTCP=True',
          'listener_9527=tcp LISTEN 0 511 0.0.0.0:9527 users:(("omr-gateway",pid=100,fd=7))'
        ].join('\n')
      }
    },
    defaultPort: {
      tcp: {
        stdout: JSON.stringify({ ok: true, host: 'example.com', port: 9527, durationMs: 10 })
      },
      readyz: {
        stdout: JSON.stringify({ ok: true, service: 'aih-server' })
      }
    }
  });

  assert.equal(summary.defaultPortReachable, true);
  assert.equal(summary.openMptcpRouterDetected, true);
  assert.deepEqual(summary.blockers, []);
  assert.equal(summary.promotionReady, true);
  assert.equal(summary.verdict, 'promotion_ready');
});
