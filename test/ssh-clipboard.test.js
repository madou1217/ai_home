const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  encodeClipboardImageFrames,
  createClipboardFrameParser,
  OSC_PREFIX
} = require('../lib/cli/services/ssh-clipboard/frames');
const {
  buildSshClipboardSessionKey,
  createSshClipboardInbox,
  isSafeInjectableImagePath
} = require('../lib/cli/services/ssh-clipboard/inbox');
const {
  DEFAULT_WATCH_INTERVAL_MS,
  buildSshSpawnArgs,
  parseAihSshArgs,
  runAihSshCommand
} = require('../lib/cli/services/ssh-clipboard/ssh-command');
const {
  OSC52_PREFIX,
  OSC5522_PREFIX,
  BEL_TERMINATOR,
  PASTE_EVENTS_5522_DISABLE,
  PASTE_EVENTS_5522_ENABLE,
  PASTE_EVENTS_5522_SUPPORT_QUERY,
  STRING_TERMINATOR,
  TMUX_PASSTHROUGH_PREFIX,
  buildOsc52ClipboardReadQuery,
  buildOsc5522ClipboardListMimeTypesQuery,
  buildOsc5522ClipboardReadMimeQuery,
  buildOsc5522ClipboardReadImageQuery,
  buildTerminalClipboardPasteEventsModeSequence,
  buildTerminalClipboardPasteEventsSupportQuery,
  createTerminalClipboardImageParser,
  decodeTerminalClipboardImagePayload,
  parsePasteEventsSupportResponse,
  wrapTerminalEscapeForTmuxPassthrough
} = require('../lib/cli/services/ssh-clipboard/terminal-clipboard');
const { createClipAgentServer, parseClipAgentArgs } = require('../lib/cli/services/ssh-clipboard/clip-agent');
const { fetchSshClipAgentImage } = require('../lib/cli/services/ssh-clipboard/clip-agent-client');
const { runSshClipboardProbeCommand } = require('../lib/cli/services/ssh-clipboard/terminal-probe');
const {
  parseShimInvocation,
  runSshClipboardShimCli
} = require('../lib/cli/services/ssh-clipboard/shim-cli');
const {
  normalizeImageForInjection
} = require('../lib/cli/services/ssh-clipboard/image-normalizer');

function pngBuffer(seed = 'x') {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(seed)
  ]);
}

function tiffBuffer(seed = 'x') {
  return Buffer.concat([
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from(seed)
  ]);
}

function listenOnLoopback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('ssh clipboard frames round-trip chunked image data and preserve passthrough input', () => {
  const image = {
    buffer: Buffer.concat([pngBuffer('round-trip'), Buffer.alloc(800, 7)]),
    mimeType: 'image/png'
  };
  const encoded = encodeClipboardImageFrames(image, { chunkSize: 512, action: 'paste', id: 'frame-test' });
  const parser = createClipboardFrameParser({ maxBytes: 1024 * 1024 });

  const first = parser.consume(Buffer.from(`abc${encoded.frames[0]}`));
  assert.equal(String(first.passthrough), 'abc');
  assert.deepEqual(first.images, []);

  let completed = null;
  for (const frame of encoded.frames.slice(1)) {
    const result = parser.consume(Buffer.from(frame));
    if (result.images.length) completed = result.images[0];
  }

  assert.ok(completed);
  assert.equal(completed.action, 'paste');
  assert.equal(completed.mimeType, 'image/png');
  assert.deepEqual(completed.buffer, image.buffer);
});

test('ssh clipboard frame parser rejects checksum mismatches without leaking frame text', () => {
  const image = { buffer: pngBuffer('bad-checksum'), mimeType: 'image/png' };
  const encoded = encodeClipboardImageFrames(image, { chunkSize: 4096, id: 'checksum-test' });
  const tampered = encoded.frames[0].replace('data=', 'data=AAAA');
  const parser = createClipboardFrameParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(tampered));

  assert.equal(result.passthrough, null);
  assert.equal(result.images.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'ssh_clip_frame_checksum_mismatch');
});

test('ssh clipboard inbox persists safe generated image paths and rejects unsafe paths', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-ssh-clip-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inbox = createSshClipboardInbox({
    fs,
    rootDir: root,
    sessionKey: buildSshClipboardSessionKey({
      env: { SSH_TTY: '/dev/pts/9' },
      cwd: '/Users/model/projects/feature/ai_home',
      provider: 'claude',
      cliAccountId: '1'
    }),
    now: () => 1700000000000
  });

  const saved = inbox.persistImage({ buffer: pngBuffer('persist'), mimeType: 'image/png' });
  assert.equal(path.isAbsolute(saved.filePath), true);
  assert.equal(saved.filePath.startsWith(root), true);
  assert.equal(fs.existsSync(saved.filePath), true);
  assert.equal(inbox.latestImagePath(), saved.filePath);
  assert.equal(isSafeInjectableImagePath(fs, inbox.rootDir, saved.filePath), true);
  assert.equal(isSafeInjectableImagePath(fs, inbox.rootDir, `${saved.filePath}\nrm -rf /`), false);
  assert.throws(() => inbox.assertSafeImagePath('/tmp/not-owned.png'), /ssh_clip_unsafe_image_path/);
});

test('clip-agent argument parser keeps RemoteForward agent local by default', () => {
  const parsed = parseClipAgentArgs(['clip-agent', 'start', '--port', '19000', '--max-bytes', '1000'], {});

  assert.equal(parsed.action, 'start');
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 19000);
  assert.equal(parsed.maxBytes, 1000);
});

test('clip-agent serves the client clipboard image over loopback HTTP', async (t) => {
  const image = { buffer: pngBuffer('clip-agent'), mimeType: 'image/png' };
  const server = createClipAgentServer({
    readClipboardImage: () => image,
    maxBytes: 1024 * 1024
  });
  t.after(() => closeServer(server));
  const address = await listenOnLoopback(server);

  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: address.address,
      port: address.port,
      path: '/image',
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal(response.res.statusCode, 200);
  assert.equal(response.res.headers['content-type'], 'image/png');
  assert.deepEqual(response.body, image.buffer);
});

test('clip-agent client fetches and validates forwarded clipboard images', async (t) => {
  const image = { buffer: pngBuffer('clip-client'), mimeType: 'image/png' };
  const server = createClipAgentServer({
    readClipboardImage: () => image,
    maxBytes: 1024 * 1024
  });
  t.after(() => closeServer(server));
  const address = await listenOnLoopback(server);

  const fetched = await fetchSshClipAgentImage({
    url: `http://${address.address}:${address.port}`,
    maxBytes: 1024 * 1024
  });

  assert.ok(fetched);
  assert.equal(fetched.mimeType, 'image/png');
  assert.deepEqual(fetched.buffer, image.buffer);
});

test('clip-agent client reports missing SSH RemoteForward socket', async () => {
  const reasons = [];
  const fetched = await fetchSshClipAgentImage({
    fs: { existsSync: () => false },
    os: {
      tmpdir: () => '/tmp',
      userInfo: () => ({ username: 'remote-user' })
    },
    path,
    onUnavailable: (reason) => reasons.push(reason)
  });

  assert.equal(fetched, null);
  assert.deepEqual(reasons, [{
    code: 'ssh_clip_agent_socket_missing',
    socketPath: '/tmp/aih-clip-remote-user.sock'
  }]);
});

test('ssh clipboard shim parser covers macOS and Wayland clipboard commands', () => {
  assert.deepEqual(parseShimInvocation(['wl-paste', '--type=image/png']), {
    tool: 'wl-paste',
    args: ['--type=image/png'],
    output: true,
    mimeType: 'image/png'
  });
  assert.deepEqual(parseShimInvocation(['pbpaste', '-Prefer', 'public.png']), {
    tool: 'pbpaste',
    args: ['-Prefer', 'public.png'],
    output: true,
    mimeType: 'image/png'
  });
  assert.deepEqual(parseShimInvocation(['pngpaste', '/tmp/clipboard.png']), {
    tool: 'pngpaste',
    args: ['/tmp/clipboard.png'],
    output: true,
    mimeType: 'image/png',
    outputPath: '/tmp/clipboard.png'
  });
  assert.deepEqual(parseShimInvocation([
    'osascript',
    '-e',
    'set png_data to (the clipboard as class PNGf)',
    '-e',
    'set fp to open for access POSIX file "/tmp/clipboard.png" with write permission',
    '-e',
    'write png_data to fp'
  ]), {
    tool: 'osascript',
    args: [
      '-e',
      'set png_data to (the clipboard as class PNGf)',
      '-e',
      'set fp to open for access POSIX file "/tmp/clipboard.png" with write permission',
      '-e',
      'write png_data to fp'
    ],
    output: true,
    mimeType: 'image/png',
    outputPath: '/tmp/clipboard.png',
    discardOutput: false
  });
  assert.deepEqual(parseShimInvocation([
    'osascript',
    '-e',
    'the clipboard as class PNGf'
  ]), {
    tool: 'osascript',
    args: [
      '-e',
      'the clipboard as class PNGf'
    ],
    output: true,
    mimeType: 'image/png',
    outputPath: '',
    discardOutput: true
  });
});

test('ssh clipboard shim writes pngpaste image responses to the requested file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-shim-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = pngBuffer('pngpaste-response');
  const outPath = path.join(root, 'clipboard.png');
  const stdoutWrites = [];
  const stderrWrites = [];
  const fsImpl = {
    ...fs,
    writeFileSync(filePath, value, encoding) {
      if (filePath === '/dev/tty') {
        const match = String(value || '').match(/response=([^;\x07\x1b]+)/);
        assert.ok(match);
        const responsePath = decodeURIComponent(match[1]);
        fs.writeFileSync(responsePath, JSON.stringify({
          ok: true,
          mimeType: 'image/png',
          byteLength: image.length,
          data: image.toString('base64')
        }), 'utf8');
        return;
      }
      fs.writeFileSync(filePath, value, encoding);
    }
  };

  const code = await runSshClipboardShimCli(['pngpaste', outPath], {
    fs: fsImpl,
    path,
    processObj: {
      env: {
        AIH_SSH_CLIP_SHIM_DIR: root,
        AIH_SSH_CLIP_SHIM_TTY: '/dev/tty'
      },
      stdout: { write: (chunk) => stdoutWrites.push(chunk) },
      stderr: { write: (chunk) => stderrWrites.push(String(chunk || '')) }
    }
  });

  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(outPath), image);
  assert.equal(stdoutWrites.length, 0);
  assert.deepEqual(stderrWrites, []);
});

test('terminal clipboard query requests image and data-url MIME types over OSC5522', () => {
  const query = buildOsc5522ClipboardReadImageQuery({ id: 'aih-test' });

  assert.equal(query.startsWith(`${OSC5522_PREFIX}type=read:id=aih-test;`), true);
  assert.equal(query.endsWith(STRING_TERMINATOR), true);
  const payload = query.slice(query.indexOf(';', OSC5522_PREFIX.length) + 1, -STRING_TERMINATOR.length);
  const mimeList = Buffer.from(payload, 'base64').toString('utf8').split(/\s+/);
  assert.deepEqual(mimeList, ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'text/html']);
});

test('terminal clipboard query normalizes image MIME aliases before reading', () => {
  const query = buildOsc5522ClipboardReadMimeQuery({ mimeType: 'public.png' });
  const mime = Buffer.from('image/png', 'utf8').toString('base64');

  assert.equal(query, `${OSC5522_PREFIX}type=read:mime=${mime};${mime}${STRING_TERMINATOR}`);
});

test('terminal clipboard query requests available MIME types over OSC5522', () => {
  const query = buildOsc5522ClipboardListMimeTypesQuery({ id: 'aih-targets' });

  assert.equal(query, `${OSC5522_PREFIX}type=read:id=aih-targets;${Buffer.from('.').toString('base64')}${STRING_TERMINATOR}`);
});

test('terminal clipboard query can request raw clipboard data over OSC52', () => {
  assert.equal(buildOsc52ClipboardReadQuery(), `${OSC52_PREFIX}c;?${BEL_TERMINATOR}`);
  assert.equal(
    buildOsc52ClipboardReadQuery({ tmuxPassthrough: true }),
    wrapTerminalEscapeForTmuxPassthrough(`${OSC52_PREFIX}c;?${BEL_TERMINATOR}`)
  );
});

test('terminal clipboard query can be wrapped for tmux passthrough', () => {
  const raw = buildOsc5522ClipboardReadImageQuery({ id: 'aih-test' });
  const wrapped = buildOsc5522ClipboardReadImageQuery({ id: 'aih-test', tmuxPassthrough: true });

  assert.equal(wrapped, wrapTerminalEscapeForTmuxPassthrough(raw));
  assert.equal(wrapped.startsWith(`${TMUX_PASSTHROUGH_PREFIX}\x1b\x1b]5522;type=read:id=aih-test;`), true);
  assert.equal(wrapped.endsWith(`\x1b\x1b\\${STRING_TERMINATOR}`), true);
});

test('terminal clipboard paste events mode can be enabled and disabled', () => {
  assert.equal(buildTerminalClipboardPasteEventsModeSequence({ enabled: true }), PASTE_EVENTS_5522_ENABLE);
  assert.equal(buildTerminalClipboardPasteEventsModeSequence({ enabled: false }), PASTE_EVENTS_5522_DISABLE);
  assert.equal(
    buildTerminalClipboardPasteEventsModeSequence({ enabled: true, tmuxPassthrough: true }),
    wrapTerminalEscapeForTmuxPassthrough(PASTE_EVENTS_5522_ENABLE)
  );
});

test('terminal clipboard paste events support query and response are parsed', () => {
  assert.equal(buildTerminalClipboardPasteEventsSupportQuery(), PASTE_EVENTS_5522_SUPPORT_QUERY);
  assert.equal(
    buildTerminalClipboardPasteEventsSupportQuery({ tmuxPassthrough: true }),
    wrapTerminalEscapeForTmuxPassthrough(PASTE_EVENTS_5522_SUPPORT_QUERY)
  );
  assert.deepEqual(parsePasteEventsSupportResponse('\x1b[?5522;2$y'), {
    mode: 5522,
    state: 2,
    supported: true,
    enabled: false
  });
  assert.deepEqual(parsePasteEventsSupportResponse('\x1b[?5522;4$y'), {
    mode: 5522,
    state: 4,
    supported: false,
    enabled: false
  });
});

test('terminal clipboard parser consumes 5522 support responses', () => {
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from('\x1b[?5522;2$y', 'latin1'));

  assert.equal(result.passthrough, null);
  assert.equal(result.progress, true);
  assert.deepEqual(result.pasteEventsSupport, {
    mode: 5522,
    state: 2,
    supported: true,
    enabled: false
  });
});

test('terminal clipboard parser consumes 5522 support responses inside surrounding input', () => {
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(`before\x1b[?5522;4$yafter`, 'latin1'));

  assert.deepEqual(result.passthrough, Buffer.from('beforeafter', 'latin1'));
  assert.deepEqual(result.pasteEventsSupport, {
    mode: 5522,
    state: 4,
    supported: false,
    enabled: false
  });
});

test('terminal clipboard direct read query requests one MIME type from paste event token', () => {
  const query = buildOsc5522ClipboardReadMimeQuery({
    mimeType: 'image/png',
    loc: 'primary',
    pw: Buffer.from('secret', 'utf8').toString('base64'),
    name: 'Paste event'
  });

  assert.equal(query, `${OSC5522_PREFIX}type=read:loc=primary:mime=${Buffer.from('image/png').toString('base64')}:pw=c2VjcmV0:name=${Buffer.from('Paste event').toString('base64')};${Buffer.from('image/png').toString('base64')}${STRING_TERMINATOR}`);
});

test('terminal clipboard parser turns 5522 paste event image MIME list into a read request', () => {
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const pw = Buffer.from('secret', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK:loc=primary:pw=${pw}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 0);
  assert.deepEqual(result.pasteRequests, [{
    mimeType: 'image/png',
    mimeTypes: ['image/png'],
    loc: 'primary',
    pw,
    passwordKey: 'pw',
    name: 'Paste event'
  }]);
});

test('terminal clipboard parser normalizes 5522 paste event MIME aliases', () => {
  const mime = Buffer.from('public.png', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.pasteRequests, [{
    mimeType: 'image/png',
    mimeTypes: ['image/png'],
    loc: '',
    pw: '',
    passwordKey: 'pw',
    name: 'Paste event'
  }]);
});

test('terminal clipboard parser turns 5522 paste event text/html into an image read request', () => {
  const mime = Buffer.from('text/html', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 0);
  assert.deepEqual(result.pasteRequests, [{
    mimeType: 'text/html',
    mimeTypes: ['text/html'],
    loc: '',
    pw: '',
    passwordKey: 'pw',
    name: 'Paste event'
  }]);
});

test('terminal clipboard parser preserves password metadata key for 5522 paste event reads', () => {
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const pw = Buffer.from('secret', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK:password=${pw}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.deepEqual(result.pasteRequests, [{
    mimeType: 'image/png',
    mimeTypes: ['image/png'],
    loc: '',
    pw,
    passwordKey: 'password',
    name: 'Paste event'
  }]);
  assert.equal(
    buildOsc5522ClipboardReadMimeQuery({ mimeType: 'image/png', pw, passwordKey: result.pasteRequests[0].passwordKey }),
    `${OSC5522_PREFIX}type=read:mime=${mime}:password=${pw};${mime}${STRING_TERMINATOR}`
  );
});

test('terminal clipboard parser exposes unsupported 5522 paste event MIME notifications', () => {
  const mime = Buffer.from('image/heic', 'utf8').toString('base64');
  const pw = Buffer.from('secret', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK:loc=primary:pw=${pw}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 0);
  assert.equal(result.pasteRequests.length, 0);
  assert.deepEqual(result.unsupportedPasteNotifications, [{
    mimeTypes: ['image/heic'],
    loc: 'primary',
    pw,
    passwordKey: 'pw'
  }]);
});

test('terminal clipboard parser extracts OSC5522 available MIME list', () => {
  const targetsMime = Buffer.from('.', 'utf8').toString('base64');
  const payload = Buffer.from('text/plain image/png image/tiff\n', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:id=targets:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=targets:status=DATA:mime=${targetsMime};${payload}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=targets:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.mimeLists, [['text/plain', 'image/png', 'image/tiff']]);
  assert.equal(result.images.length, 0);
});

test('terminal clipboard parser returns text/plain paste content so normal paste still works', () => {
  const mime = Buffer.from('text/plain', 'utf8').toString('base64');
  const text = Buffer.from('hello from paste', 'utf8');
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${text.toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 0);
  assert.equal(result.textPastes.length, 1);
  assert.deepEqual(result.textPastes[0].buffer, text);
});

test('terminal clipboard parser extracts image data URLs from OSC5522 text/html data', () => {
  const image = pngBuffer('html-data-url');
  const mime = Buffer.from('text/html', 'utf8').toString('base64');
  const html = `<img alt="clipboard" src="data:image/png;base64,${image.toString('base64')}">`;
  const frames = [
    `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${Buffer.from(html).toString('base64')}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frames, 'latin1'));

  assert.equal(result.errors.length, 0);
  assert.equal(result.textPastes.length, 0);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].buffer, image);
  assert.equal(result.images[0].mimeType, 'image/png');
});

test('terminal clipboard parser extracts OSC5522 image data chunks over the current SSH tty', () => {
  const image = pngBuffer('osc5522-data');
  const first = image.slice(0, 9).toString('base64');
  const second = image.slice(9).toString('base64');
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const frames = [
    `${OSC5522_PREFIX}type=read:id=clip1:status=OK${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=clip1:status=DATA:mime=${mime};${first}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=clip1:status=DATA:mime=${mime};${second}${STRING_TERMINATOR}`,
    `${OSC5522_PREFIX}type=read:id=clip1:status=DONE${STRING_TERMINATOR}`
  ].join('');
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(`before${frames}after`, 'latin1'));

  assert.equal(String(result.passthrough), 'beforeafter');
  assert.equal(result.errors.length, 0);
  assert.equal(result.progress, true);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].buffer, image);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.equal(result.completed, true);
});

test('terminal clipboard parser reports OSC5522 terminal errors as completed responses', () => {
  const frame = `${OSC5522_PREFIX}type=read:id=clip-error:status=ENOSYS${STRING_TERMINATOR}`;
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frame, 'latin1'));

  assert.equal(result.passthrough, null);
  assert.equal(result.images.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'ssh_clip_terminal_clipboard_enosys');
  assert.equal(result.completed, true);
});

test('terminal clipboard parser keeps OSC52 raw image payloads as a weak fallback', () => {
  const image = pngBuffer('osc52-raw');
  const frame = `${OSC52_PREFIX}c;${image.toString('base64')}\x07`;
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frame, 'latin1'));

  assert.equal(result.passthrough, null);
  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].buffer, image);
  assert.equal(result.images[0].mimeType, 'image/png');
});

test('terminal clipboard parser keeps OSC52 raw TIFF payloads from macOS terminals', () => {
  const image = tiffBuffer('osc52-raw-tiff');
  const frame = `${OSC52_PREFIX}c;${image.toString('base64')}\x07`;
  const parser = createTerminalClipboardImageParser({ maxBytes: 1024 * 1024 });
  const result = parser.consume(Buffer.from(frame, 'latin1'));

  assert.equal(result.passthrough, null);
  assert.equal(result.errors.length, 0);
  assert.equal(result.images.length, 1);
  assert.deepEqual(result.images[0].buffer, image);
  assert.equal(result.images[0].mimeType, 'image/tiff');
});

test('image normalizer converts TIFF clipboard images to PNG when a server converter is available', () => {
  const input = tiffBuffer('normalize-tiff');
  const output = pngBuffer('normalized-png');
  const calls = [];
  const converted = normalizeImageForInjection({
    buffer: input,
    mimeType: 'image/tiff'
  }, {
    maxBytes: 1024 * 1024,
    spawnSync: (command, args) => {
      calls.push({ command, args });
      const outputPath = args[args.length - 1];
      fs.writeFileSync(outputPath, output);
      return { status: 0 };
    }
  });

  assert.equal(calls[0].command, 'sips');
  assert.deepEqual(converted.buffer, output);
  assert.equal(converted.mimeType, 'image/png');
});

test('terminal clipboard decoder accepts base64 encoded image data URLs', () => {
  const image = pngBuffer('osc52-data-url');
  const dataUrl = `data:image/png;base64,${image.toString('base64')}`;
  const decoded = decodeTerminalClipboardImagePayload(Buffer.from(dataUrl, 'utf8').toString('base64'), {
    maxBytes: 1024 * 1024
  });

  assert.ok(decoded);
  assert.deepEqual(decoded.buffer, image);
  assert.equal(decoded.mimeType, 'image/png');
});

test('terminal clipboard decoder accepts embedded markdown image data URLs', () => {
  const image = pngBuffer('markdown-data-url');
  const markdown = `![clipboard](data:image/png;base64,${image.toString('base64')})`;
  const decoded = decodeTerminalClipboardImagePayload(Buffer.from(markdown, 'utf8').toString('base64'), {
    maxBytes: 1024 * 1024
  });

  assert.ok(decoded);
  assert.deepEqual(decoded.buffer, image);
  assert.equal(decoded.mimeType, 'image/png');
});

test('ssh clipboard probe reports strict zero-client terminal image support', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => {
    stdin.isRaw = enabled;
  };
  const image = pngBuffer('probe');
  const targetsMime = Buffer.from('.', 'utf8').toString('base64');
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const writes = [];
  const stdout = {
    isTTY: true,
    write: (value) => {
      const text = String(value);
      writes.push(text);
      if (text.includes(PASTE_EVENTS_5522_SUPPORT_QUERY)) {
        setImmediate(() => stdin.emit('data', Buffer.from('\x1b[?5522;2$y', 'latin1')));
      } else if (text.includes(`${OSC5522_PREFIX}type=read:id=aih-probe-mimes-`)) {
        const payload = Buffer.from('text/plain image/png image/tiff\n', 'utf8').toString('base64');
        setImmediate(() => stdin.emit('data', Buffer.from([
          `${OSC5522_PREFIX}type=read:id=probe-mimes:status=OK${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:id=probe-mimes:status=DATA:mime=${targetsMime};${payload}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:id=probe-mimes:status=DONE${STRING_TERMINATOR}`
        ].join(''), 'latin1')));
      } else if (text.includes(`${OSC5522_PREFIX}type=read:id=aih-probe-image-`)) {
        setImmediate(() => stdin.emit('data', Buffer.from([
          `${OSC5522_PREFIX}type=read:id=probe:status=OK${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:id=probe:status=DATA:mime=${mime};${image.toString('base64')}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:id=probe:status=DONE${STRING_TERMINATOR}`
        ].join(''), 'latin1')));
      }
    }
  };
  const stderr = { write: () => {} };

  const code = await runSshClipboardProbeCommand(['ssh-clipboard', 'probe', '--json'], {
    processObj: {
      env: {
        SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
        SSH_TTY: '/dev/pts/10'
      },
      stdin,
      stdout,
      stderr
    }
  });

  assert.equal(code, 0);
  assert.equal(stdin.isRaw, false);
  const payload = JSON.parse(writes.find((line) => line.startsWith('{')));
  assert.equal(payload.sshSession, true);
  assert.equal(payload.pasteEvents.supported, true);
  assert.deepEqual(payload.mimeTypes.mimeTypes, ['text/plain', 'image/png', 'image/tiff']);
  assert.equal(payload.osc5522.status, 'ok');
  assert.equal(payload.osc5522.requestedMimeType, 'image/png');
  assert.equal(payload.osc5522.byteLength, image.length);
  assert.equal(payload.osc52.status, 'skipped');
  assert.equal(payload.zeroClient.supported, true);
});

test('ssh clipboard probe waits for a real OSC5522 paste event image token', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => {
    stdin.isRaw = enabled;
  };
  const image = pngBuffer('paste-event-probe');
  const mime = Buffer.from('image/png', 'utf8').toString('base64');
  const pw = Buffer.from('secret', 'utf8').toString('base64');
  const writes = [];
  const stderrWrites = [];
  const stdout = {
    isTTY: true,
    write: (value) => {
      const text = String(value);
      writes.push(text);
      if (text.includes(PASTE_EVENTS_5522_SUPPORT_QUERY)) {
        setImmediate(() => stdin.emit('data', Buffer.from('\x1b[?5522;2$y', 'latin1')));
      } else if (text.includes(PASTE_EVENTS_5522_ENABLE)) {
        setImmediate(() => stdin.emit('data', Buffer.from([
          `${OSC5522_PREFIX}type=read:status=OK:loc=primary:pw=${pw}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
        ].join(''), 'latin1')));
      } else if (text.includes(`${OSC5522_PREFIX}type=read:loc=primary:mime=${mime}:pw=${pw}:name=`) && text.includes(`;${mime}${STRING_TERMINATOR}`)) {
        setImmediate(() => stdin.emit('data', Buffer.from([
          `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime};${image.toString('base64')}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
        ].join(''), 'latin1')));
      }
    }
  };

  const code = await runSshClipboardProbeCommand([
    'ssh-clipboard',
    'probe',
    '--paste-event',
    '--json',
    '--timeout-ms',
    '1000'
  ], {
    processObj: {
      env: {
        SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
        SSH_TTY: '/dev/pts/10'
      },
      stdin,
      stdout,
      stderr: { write: (value) => stderrWrites.push(String(value)) }
    }
  });

  assert.equal(code, 0);
  assert.equal(stdin.isRaw, false);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_ENABLE)), true);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_DISABLE)), true);
  assert.equal(writes.some((line) => line.includes(`:pw=${pw}`)), true);
  assert.equal(stderrWrites.some((line) => line.includes('paste an image')), true);
  const payload = JSON.parse(writes.find((line) => line.startsWith('{')));
  assert.equal(payload.pasteEvents.supported, true);
  assert.equal(payload.pasteEvent.status, 'ok');
  assert.equal(payload.pasteEvent.request.mimeType, 'image/png');
  assert.deepEqual(payload.pasteEvent.request.mimeTypes, ['image/png']);
  assert.deepEqual(payload.pasteEvent.mimeTypes, ['image/png']);
  assert.equal(payload.pasteEvent.request.passwordKey, 'pw');
  assert.equal(payload.pasteEvent.image.byteLength, image.length);
  assert.equal(payload.mimeTypes.status, 'skipped');
  assert.equal(payload.osc5522.status, 'skipped');
  assert.equal(payload.zeroClient.supported, true);
  assert.equal(payload.zeroClient.reason, 'osc5522_paste_event_image_data');
});

test('ssh clipboard paste-event probe disables OSC5522 mode on timeout', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => {
    stdin.isRaw = enabled;
  };
  const writes = [];
  const stdout = {
    isTTY: true,
    write: (value) => {
      writes.push(String(value));
    }
  };
  const setTimeoutForTest = (callback, ms) => {
    const id = setTimeout(callback, ms);
    return { id };
  };
  const clearTimeoutForTest = (timer) => {
    if (timer && timer.id) clearTimeout(timer.id);
  };

  const code = await runSshClipboardProbeCommand([
    'ssh-clipboard',
    'probe',
    '--paste-event',
    '--json',
    '--timeout-ms',
    '1'
  ], {
    processObj: {
      env: {
        SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
        SSH_TTY: '/dev/pts/10'
      },
      stdin,
      stdout,
      stderr: { write: () => {} }
    },
    setTimeout: setTimeoutForTest,
    clearTimeout: clearTimeoutForTest
  });

  assert.equal(code, 0);
  assert.equal(stdin.isRaw, false);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_ENABLE)), true);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_DISABLE)), true);
  const payload = JSON.parse(writes.find((line) => line.startsWith('{')));
  assert.equal(payload.pasteEvent.status, 'timeout');
  assert.equal(payload.pasteEvent.phase, 'paste_event');
  assert.equal(payload.zeroClient.supported, false);
});

test('ssh clipboard paste-event probe reports unsupported MIME without waiting for timeout', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => {
    stdin.isRaw = enabled;
  };
  const mime = Buffer.from('image/heic', 'utf8').toString('base64');
  const writes = [];
  const stdout = {
    isTTY: true,
    write: (value) => {
      const text = String(value);
      writes.push(text);
      if (text.includes(PASTE_EVENTS_5522_SUPPORT_QUERY)) {
        setImmediate(() => stdin.emit('data', Buffer.from('\x1b[?5522;2$y', 'latin1')));
      } else if (text.includes(PASTE_EVENTS_5522_ENABLE)) {
        setImmediate(() => stdin.emit('data', Buffer.from([
          `${OSC5522_PREFIX}type=read:status=OK${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DATA:mime=${mime}${STRING_TERMINATOR}`,
          `${OSC5522_PREFIX}type=read:status=DONE${STRING_TERMINATOR}`
        ].join(''), 'latin1')));
      }
    }
  };
  let timerArmed = false;
  let timerCleared = false;
  const setTimeoutForTest = () => {
    timerArmed = true;
    return { id: 'paste-event' };
  };
  const clearTimeoutForTest = (timer) => {
    if (timer && timer.id === 'paste-event') timerCleared = true;
  };

  const code = await runSshClipboardProbeCommand([
    'ssh-clipboard',
    'probe',
    '--paste-event',
    '--json',
    '--timeout-ms',
    '1000'
  ], {
    processObj: {
      env: {
        SSH_CONNECTION: '192.0.2.10 50000 192.0.2.20 22',
        SSH_TTY: '/dev/pts/10'
      },
      stdin,
      stdout,
      stderr: { write: () => {} }
    },
    setTimeout: setTimeoutForTest,
    clearTimeout: clearTimeoutForTest
  });

  assert.equal(code, 0);
  assert.equal(timerArmed, true);
  assert.equal(timerCleared, true);
  assert.equal(writes.some((line) => line.includes(PASTE_EVENTS_5522_DISABLE)), true);
  const payload = JSON.parse(writes.find((line) => line.startsWith('{')));
  assert.equal(payload.pasteEvent.status, 'error');
  assert.equal(payload.pasteEvent.error, 'paste_event_unsupported_mime');
  assert.deepEqual(payload.pasteEvent.mimeTypes, ['image/heic']);
  assert.equal(payload.zeroClient.supported, false);
});

test('ssh clipboard probe reports tty requirement before terminal queries', async () => {
  const writes = [];
  const code = await runSshClipboardProbeCommand(['ssh-clipboard', 'probe', '--json'], {
    processObj: {
      env: {},
      stdin: { isTTY: false },
      stdout: {
        isTTY: false,
        write: (value) => writes.push(String(value))
      },
      stderr: { write: () => {} }
    }
  });

  assert.equal(code, 1);
  const payload = JSON.parse(writes[0]);
  assert.equal(payload.ok, false);
  assert.equal(payload.zeroClient.supported, false);
  assert.equal(payload.zeroClient.reason, 'tty_required');
  assert.equal(payload.osc5522.status, 'skipped');
});

test('parseAihSshArgs strips AIH options and preserves ssh plus remote command args', () => {
  const parsed = parseAihSshArgs([
    '--watch-clipboard',
    '--clip-max-bytes',
    '12345',
    '-p',
    '2222',
    'model@host',
    '--',
    'aih',
    'claude'
  ]);

  assert.equal(parsed.watchClipboard, true);
  assert.equal(parsed.maxBytes, 12345);
  assert.deepEqual(parsed.sshArgs, ['-p', '2222', 'model@host']);
  assert.deepEqual(parsed.remoteArgs, ['aih', 'claude']);
});

test('buildSshSpawnArgs quotes the remote command as one OpenSSH argument', () => {
  const parsed = parseAihSshArgs([
    '-p',
    '2222',
    'model@host',
    '--',
    'aih',
    'claude',
    '-p',
    'hello world',
    '--flag=value'
  ]);

  assert.deepEqual(buildSshSpawnArgs(parsed), [
    '-p',
    '2222',
    'model@host',
    "aih claude -p 'hello world' --flag=value"
  ]);
});

test('runAihSshCommand sends clipboard image frames on Alt+V and keeps regular input raw', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  const rawModeCalls = [];
  stdin.setRawMode = (enabled) => {
    rawModeCalls.push(Boolean(enabled));
    stdin.isRaw = Boolean(enabled);
  };
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.write = () => {};
  const stderrWrites = [];
  const stderr = { write: (chunk) => stderrWrites.push(String(chunk)) };
  const processObj = {
    env: {},
    platform: 'linux',
    stdin,
    stdout,
    stderr,
    cwd: () => '/tmp/project'
  };

  let child = null;
  const stdinWrites = [];
  const spawn = (command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (chunk) => stdinWrites.push(String(chunk)),
      end: () => {}
    };
    child.command = command;
    child.args = args;
    return child;
  };
  const spawnSync = () => ({ status: 0, stdout: pngBuffer('client') });

  const runPromise = runAihSshCommand(['ssh', 'model@host', '--', 'aih', 'claude'], {
    processObj,
    consoleImpl: { log: () => {}, error: () => {} },
    spawn,
    spawnSync
  });

  assert.equal(child.command, 'ssh');
  assert.deepEqual(child.args, ['model@host', 'aih claude']);
  stdin.emit('data', Buffer.from('x'));
  stdin.emit('data', Buffer.from('\x1bv'));
  child.emit('exit', 0);
  const code = await runPromise;

  assert.equal(code, 0);
  assert.equal(rawModeCalls[0], true);
  assert.equal(rawModeCalls.at(-1), false);
  assert.equal(stdinWrites[0], 'x');
  assert.equal(stdinWrites.some((chunk) => chunk.startsWith(OSC_PREFIX)), true);
  assert.equal(stderrWrites.some((line) => line.includes('sent clipboard image')), true);
});

test('runAihSshCommand watches and caches changed clipboard images when enabled', async () => {
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.setRawMode = (enabled) => { stdin.isRaw = Boolean(enabled); };
  stdin.resume = () => {};
  stdin.pause = () => {};
  const stdout = new EventEmitter();
  stdout.isTTY = true;
  stdout.write = () => {};
  const processObj = {
    env: {},
    platform: 'linux',
    stdin,
    stdout,
    stderr: { write: () => {} },
    cwd: () => '/tmp/project'
  };

  let child = null;
  const stdinWrites = [];
  const spawn = (command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (chunk) => stdinWrites.push(String(chunk)),
      end: () => {}
    };
    child.command = command;
    child.args = args;
    return child;
  };
  const spawnSync = () => ({ status: 0, stdout: pngBuffer('watched') });
  let watchCallback = null;
  let watchDelay = 0;
  let didUnref = false;
  let didClear = false;
  const watchTimer = {
    unref: () => { didUnref = true; }
  };
  const setIntervalImpl = (callback, delay) => {
    watchCallback = callback;
    watchDelay = delay;
    return watchTimer;
  };
  const clearIntervalImpl = (timer) => {
    assert.equal(timer, watchTimer);
    didClear = true;
  };

  const runPromise = runAihSshCommand(['ssh', '--watch-clipboard', 'model@host', '--', 'aih', 'claude'], {
    processObj,
    consoleImpl: { log: () => {}, error: () => {} },
    spawn,
    spawnSync,
    setInterval: setIntervalImpl,
    clearInterval: clearIntervalImpl
  });

  assert.equal(child.command, 'ssh');
  assert.deepEqual(child.args, ['model@host', 'aih claude']);
  assert.equal(typeof watchCallback, 'function');
  assert.equal(watchDelay, DEFAULT_WATCH_INTERVAL_MS);
  assert.equal(didUnref, true);

  watchCallback();
  const firstWriteCount = stdinWrites.length;
  assert.equal(stdinWrites.some((chunk) => chunk.includes('action=cache')), true);

  watchCallback();
  assert.equal(stdinWrites.length, firstWriteCount);

  child.emit('exit', 0);
  assert.equal(await runPromise, 0);
  assert.equal(didClear, true);
});

test('runSshMcpServerLoop handles Stdio MCP tools/list', async () => {
  const { runSshMcpServerLoop } = require('../lib/cli/services/pty/runtime');
  const { EventEmitter } = require('events');
  const assert = require('assert/strict');

  const stdin = new EventEmitter();
  const stdoutData = [];
  const stdout = {
    write: (data) => {
      stdoutData.push(data.toString());
    }
  };
  const processObj = {
    stdin,
    stdout,
    stderr: { write: () => {} },
    platform: 'darwin',
    exit: (code) => {
      exitCode = code;
    }
  };
  let exitCode = null;

  runSshMcpServerLoop('mock@host', '/remote/path', processObj);

  const listToolsRequest = {
    jsonrpc: '2.0',
    id: 42,
    method: 'tools/list'
  };

  stdin.emit('data', Buffer.from(JSON.stringify(listToolsRequest) + '\n'));

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(stdoutData.length, 1);
  const response = JSON.parse(stdoutData[0].trim());
  assert.equal(response.id, 42);
  assert.ok(Array.isArray(response.result.tools));
  assert.ok(response.result.tools.some(t => t.name === 'view_file'));
  assert.ok(response.result.tools.some(t => t.name === 'edit_file'));
  assert.ok(response.result.tools.some(t => t.name === 'run_command'));
});
