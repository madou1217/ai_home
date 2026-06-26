const test = require('node:test');
const assert = require('node:assert/strict');

const { createCliHelpService } = require('../lib/cli/commands/help/messages');

test('root help explains remote defaults and client pairing boundaries', () => {
  const logs = [];
  const help = createCliHelpService({
    log: (value) => logs.push(String(value))
  });

  help.showHelp();

  const output = logs.join('\n');
  assert.match(output, /relay is the default no-public-IP path/);
  assert.match(output, /provider\/route\/trust are derived from transport/);
  assert.match(output, /phones, PWAs, tablets, and other computers pair as Control Plane device clients/);
  assert.match(output, /FRP\/SSH\/VPN\/OMR\/MPTCP require a user-managed HTTP endpoint/);
  assert.match(output, /Strict zero-client means no client helper\/config/);
  assert.match(output, /normal SSH to the host, run aih <cli> <id>, then paste or press Alt\+V/);
  assert.match(output, /OSC 5522/);
  assert.match(output, /5522 paste events/);
  assert.match(output, /OSC 52 reads/);
  assert.match(output, /aih ssh-clipboard probe/);
  assert.match(output, /image\/data-url data/);
  assert.match(output, /tmux passthrough/);
  assert.match(output, /strict zero-client cannot fetch the client's clipboard image/);
  assert.match(output, /Non-zero-client fallback is explicit opt-in/);
  assert.match(output, /AIH_SSH_CLIP_AGENT=1/);
  assert.match(output, /aih clip-agent start/);
  assert.match(output, /RemoteForward \/tmp\/aih-clip-%r\.sock 127\.0\.0\.1:17652/);
  assert.match(output, /separate non-zero-client wrapper fallback/);
});
