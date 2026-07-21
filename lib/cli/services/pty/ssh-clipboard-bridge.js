'use strict';

// SSH clipboard bridge: the full remote-clipboard state machine for a PTY
// session running over SSH. Owns paste-events mode (OSC 5522), terminal
// clipboard reads (OSC 52 / 5522), clip-agent fallback, bracketed-paste image
// decoding, shim request fulfilment, and the on-disk image inbox. The runtime
// feeds it stdin/pty data through the consume* functions and it injects
// results back via the writePtyInput callback. Extracted from runCliPty;
// exported names match the original closure functions so call sites are
// unchanged.

const {
  createClipboardFrameParser,
  DEFAULT_MAX_BYTES: SSH_CLIP_DEFAULT_MAX_BYTES
} = require('../ssh-clipboard/frames');
const {
  buildSshClipboardSessionKey,
  createSshClipboardInbox
} = require('../ssh-clipboard/inbox');
const {
  extractBracketedPastePayload
} = require('../ssh-clipboard/keys');
const {
  buildOsc52ClipboardReadQuery,
  buildOsc5522ClipboardListMimeTypesQuery,
  buildOsc5522ClipboardReadMimeQuery,
  buildOsc5522ClipboardReadImageQuery,
  OSC5522_IMAGE_MIME_TYPES,
  OSC5522_TEXT_IMAGE_MIME_TYPES,
  buildTerminalClipboardPasteEventsModeSequence,
  buildTerminalClipboardPasteEventsSupportQuery,
  createTerminalClipboardImageParser,
  decodeTerminalClipboardImagePayload
} = require('../ssh-clipboard/terminal-clipboard');
const {
  DEFAULT_SHIM_TIMEOUT_MS,
  createShimRequestParser,
  isSafeShimResponsePath
} = require('../ssh-clipboard/shim-protocol');
const {
  normalizeImageForInjection
} = require('../ssh-clipboard/image-normalizer');

function createSshClipboardBridge(deps = {}) {
  const {
    fs,
    path,
    processObj,
    spawnSync,
    fetchSshClipAgentImage,
    provider,
    getCliAccountId,
    writePtyInput
  } = deps;

  let sshClipboardParser = null;
  let sshTerminalClipboardParser = null;
  let sshClipboardShimRequestParser = null;
  let sshClipboardShimRequest = null;
  let sshTerminalClipboardPromptTimer = null;
  let sshTerminalClipboardTimeoutConfig = null;
  let sshTerminalClipboardRequestSeq = 0;
  let sshTerminalClipboardRequestProtocol = '';
  let sshTerminalPasteEventsModeEnabled = false;
  let sshTerminalPasteEventsSupport = 'unknown';
  let sshClipAgentRequestInFlight = false;
  const sshClipboardInboxes = new Map();

  function isSshRuntimeSession() {
    return Boolean(
      String(processObj.env.SSH_CONNECTION || '').trim()
      || String(processObj.env.SSH_TTY || '').trim()
    );
  }

  function readSshClipMaxBytes() {
    const configured = Number(processObj.env.AIH_SSH_CLIP_MAX_BYTES);
    return Number.isInteger(configured) && configured > 0 ? configured : SSH_CLIP_DEFAULT_MAX_BYTES;
  }

  function shouldEnableSshClipboardImagePaste() {
    if (!isSshRuntimeSession()) return false;
    return String(processObj.env.AIH_SSH_IMAGE_PASTE || '1') !== '0';
  }

  function shouldEnableSshTerminalClipboardImagePaste() {
    if (!shouldEnableSshClipboardImagePaste()) return false;
    return String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD || '1') !== '0';
  }

  function shouldEnableSshTerminalPasteEvents() {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
    return String(processObj.env.AIH_SSH_TERMINAL_PASTE_EVENTS || '1') !== '0';
  }

  function shouldWrapSshTerminalClipboardQueryForTmux() {
    if (!String(processObj.env.TMUX || '').trim()) return false;
    return String(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD_TMUX_PASSTHROUGH || '1') !== '0';
  }

  function formatSshTerminalClipboardCapabilityHint() {
    if (sshTerminalPasteEventsSupport === 'unsupported') {
      return ' Terminal reported OSC 5522 paste-events unsupported.';
    }
    if (sshTerminalPasteEventsSupport === 'supported') {
      return ' Terminal reported OSC 5522 paste-events supported.';
    }
    return ' Terminal did not report OSC 5522 paste-events support.';
  }

  function formatSshTerminalClipboardReadHint() {
    return `${formatSshTerminalClipboardCapabilityHint()} Strict zero-client image paste requires terminal clipboard read support such as OSC 5522 image MIME data or OSC 52 image/data-url data.`;
  }

  function chooseSshTerminalImageMimeType(mimeTypes) {
    const available = Array.isArray(mimeTypes)
      ? mimeTypes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    return OSC5522_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
      || available.find((mimeType) => OSC5522_IMAGE_MIME_TYPES.includes(mimeType))
      || OSC5522_TEXT_IMAGE_MIME_TYPES.find((mimeType) => available.includes(mimeType))
      || '';
  }

  function formatSshTerminalMimeTypes(notifications) {
    const seen = new Set();
    const mimeTypes = (Array.isArray(notifications) ? notifications : [])
      .flatMap((notification) => Array.isArray(notification && notification.mimeTypes) ? notification.mimeTypes : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      });
    return mimeTypes.length > 0 ? `: ${mimeTypes.join(', ')}` : '';
  }

  function shouldEnableSshClipAgentImagePaste() {
    if (!shouldEnableSshClipboardImagePaste()) return false;
    const env = processObj.env || {};
    const mode = String(env.AIH_SSH_CLIP_AGENT || '').trim().toLowerCase();
    if (mode === '0' || mode === 'false' || mode === 'off' || mode === 'no') return false;
    if (mode === '1' || mode === 'true' || mode === 'on' || mode === 'yes') return true;
    return Boolean(String(env.AIH_SSH_CLIP_AGENT_SOCKET || env.AIH_SSH_CLIP_AGENT_URL || '').trim());
  }

  function clearSshTerminalClipboardPromptTimer() {
    if (!sshTerminalClipboardPromptTimer) return;
    clearTimeout(sshTerminalClipboardPromptTimer);
    sshTerminalClipboardPromptTimer = null;
    sshTerminalClipboardTimeoutConfig = null;
  }

  function finishSshTerminalClipboardRequest() {
    clearSshTerminalClipboardPromptTimer();
    sshTerminalClipboardRequestProtocol = '';
  }

  function ensureSshTerminalClipboardParser() {
    if (!sshTerminalClipboardParser) {
      sshTerminalClipboardParser = createTerminalClipboardImageParser({
        maxBytes: readSshClipMaxBytes()
      });
    }
    return sshTerminalClipboardParser;
  }

  function writeSshTerminalClipboardSequence(sequence) {
    const text = String(sequence || '');
    if (!text) return false;
    try {
      processObj.stdout.write(text);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function getSshClipboardShimRootDir() {
    const sessionKey = buildSshClipboardSessionKey({
      env: processObj.env,
      cwd: processObj.cwd(),
      provider,
      cliAccountId: getCliAccountId(),
      pid: processObj.pid
    });
    return path.join(createSshClipboardInbox({
      fs,
      sessionKey,
      maxBytes: readSshClipMaxBytes()
    }).rootDir, 'shim');
  }

  function writeSshClipboardShimResponse(request, response) {
    if (!request || !request.responsePath) return false;
    const rootDir = getSshClipboardShimRootDir();
    if (!isSafeShimResponsePath(rootDir, request.responsePath, path)) return false;
    try {
      fs.mkdirSync(path.dirname(request.responsePath), { recursive: true });
      fs.writeFileSync(request.responsePath, JSON.stringify(response), 'utf8');
      return true;
    } catch (_error) {
      return false;
    }
  }

  function finishSshClipboardShimRequest(response) {
    const request = sshClipboardShimRequest;
    sshClipboardShimRequest = null;
    finishSshTerminalClipboardRequest();
    if (request) writeSshClipboardShimResponse(request, response);
  }

  function requestSshClipboardShimMimeList(request) {
    sshClipboardShimRequest = request;
    ensureSshTerminalClipboardParser();
    const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardListMimeTypesQuery({
      id: `aih-shim-${request.id}`,
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
    if (!wrote) {
      finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_terminal_write_failed' });
      return false;
    }
    startSshTerminalClipboardTimeout('shim-mime-list', readSshTerminalClipboardTimeoutMs(DEFAULT_SHIM_TIMEOUT_MS), () => {
      finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_mime_list_timeout' });
    });
    return true;
  }

  function requestSshClipboardShimRead(request) {
    sshClipboardShimRequest = request;
    ensureSshTerminalClipboardParser();
    const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadMimeQuery({
      id: `aih-shim-${request.id}`,
      mimeType: request.mimeType,
      name: 'AIH clipboard shim',
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
    if (!wrote) {
      finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_terminal_write_failed' });
      return false;
    }
    startSshTerminalClipboardTimeout('shim-read', readSshTerminalClipboardTimeoutMs(DEFAULT_SHIM_TIMEOUT_MS), () => {
      finishSshClipboardShimRequest({ ok: false, error: 'ssh_clip_shim_read_timeout' });
    });
    return true;
  }

  function handleSshClipboardShimRequest(request) {
    if (!request || !shouldEnableSshTerminalClipboardImagePaste()) return false;
    const rootDir = getSshClipboardShimRootDir();
    if (!isSafeShimResponsePath(rootDir, request.responsePath, path)) return false;
    if (sshClipboardShimRequest) {
      writeSshClipboardShimResponse(request, { ok: false, error: 'ssh_clip_shim_busy' });
      return true;
    }
    if (request.kind === 'list' || request.mimeType === 'TARGETS') {
      return requestSshClipboardShimMimeList(request);
    }
    return requestSshClipboardShimRead(request);
  }

  function handleSshClipboardShimTerminalResult(result) {
    if (!sshClipboardShimRequest || !result) return false;
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_shim_terminal_failed');
      finishSshClipboardShimRequest({ ok: false, error: code });
      return true;
    }
    if (Array.isArray(result.images) && result.images.length > 0) {
      const image = result.images[0];
      finishSshClipboardShimRequest({
        ok: true,
        mimeType: image.mimeType,
        byteLength: image.byteLength,
        sha256: image.sha256,
        data: image.buffer.toString('base64')
      });
      return true;
    }
    if (Array.isArray(result.textPastes) && result.textPastes.length > 0) {
      const textPaste = result.textPastes[0];
      finishSshClipboardShimRequest({
        ok: true,
        mimeType: textPaste.mimeType || 'text/plain',
        byteLength: textPaste.buffer.length,
        data: textPaste.buffer.toString('base64')
      });
      return true;
    }
    if (Array.isArray(result.mimeLists) && result.mimeLists.length > 0) {
      const seen = new Set();
      const mimeTypes = result.mimeLists.flat()
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .filter((value) => {
          if (seen.has(value)) return false;
          seen.add(value);
          return true;
        });
      finishSshClipboardShimRequest({ ok: true, mimeTypes });
      return true;
    }
    return false;
  }

  function consumeSshClipboardShimRequests(data) {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return data;
    if (!sshClipboardShimRequestParser) {
      sshClipboardShimRequestParser = createShimRequestParser();
    }
    // The shim parser's internal Buffer uses 'latin1' for byte-string identity.
    // Passing a UTF-8 decoded JS string directly causes Buffer.from(text,'latin1')
    // inside the parser to silently truncate each CJK/emoji code point to its low
    // byte, corrupting Chinese display over SSH. Pre-convert the string to a UTF-8
    // Buffer so the parser receives raw bytes it can round-trip through latin1 losslessly.
    const dataForParser = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const result = sshClipboardShimRequestParser.consume(dataForParser);
    if (Array.isArray(result.requests)) {
      result.requests.forEach((request) => {
        handleSshClipboardShimRequest(request);
      });
    }
    if (!result.passthrough) return null;
    return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
  }

  function startSshTerminalPasteEventsMode() {
    if (sshTerminalPasteEventsModeEnabled) return;
    if (!shouldEnableSshTerminalPasteEvents()) return;
    ensureSshTerminalClipboardParser();
    writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsSupportQuery({
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
    sshTerminalPasteEventsModeEnabled = writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsModeSequence({
      enabled: true,
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
  }

  function stopSshTerminalPasteEventsMode() {
    if (!sshTerminalPasteEventsModeEnabled) return;
    sshTerminalPasteEventsModeEnabled = false;
    writeSshTerminalClipboardSequence(buildTerminalClipboardPasteEventsModeSequence({
      enabled: false,
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
  }

  function getSshClipboardInbox() {
    const sessionKey = buildSshClipboardSessionKey({
      env: processObj.env,
      cwd: processObj.cwd(),
      provider,
      cliAccountId: getCliAccountId(),
      pid: processObj.pid
    });
    if (!sshClipboardInboxes.has(sessionKey)) {
      sshClipboardInboxes.set(sessionKey, createSshClipboardInbox({
        fs,
        sessionKey,
        maxBytes: readSshClipMaxBytes()
      }));
    }
    return sshClipboardInboxes.get(sessionKey);
  }

  function writeSshClipboardStatus(message) {
    try {
      processObj.stdout.write(`\r\n\x1b[33m[aih]\x1b[0m ${message}\r\n`);
    } catch (_error) {}
  }

  function injectSshClipboardImagePath(filePath) {
    const inbox = getSshClipboardInbox();
    const safePath = inbox.assertSafeImagePath(filePath);
    writePtyInput(safePath);
    return safePath;
  }

  function persistSshClipboardImage(image) {
    const inbox = getSshClipboardInbox();
    const normalized = normalizeImageForInjection(image, {
      fs,
      path,
      spawnSync,
      maxBytes: readSshClipMaxBytes()
    });
    return inbox.persistImage(normalized);
  }

  function formatSshClipAgentEndpoint(reason) {
    if (!reason) return '';
    if (reason.socketPath) return String(reason.socketPath);
    if (reason.url) return String(reason.url);
    return '';
  }

  function readSshTerminalClipboardTimeoutMs(defaultMs) {
    const configured = Number(processObj.env.AIH_SSH_TERMINAL_CLIPBOARD_TIMEOUT_MS);
    return Number.isInteger(configured) && configured > 0 ? configured : defaultMs;
  }

  function formatSshClipAgentStatus(reason) {
    const endpoint = formatSshClipAgentEndpoint(reason);
    const remoteForward = endpoint && endpoint.startsWith('/')
      ? ` Add SSH config: RemoteForward ${endpoint} 127.0.0.1:17652`
      : ' Add SSH config: RemoteForward /tmp/aih-clip-%r.sock 127.0.0.1:17652';
    const startAgent = ' Start aih clip-agent on the SSH client and set AIH_SSH_CLIP_AGENT=1.';
    const code = String(reason && reason.code || '');
    if (code === 'ssh_clip_agent_socket_missing') {
      return `non-zero-client clip-agent not connected${endpoint ? ` at ${endpoint}` : ''}.${startAgent}${remoteForward}`;
    }
    if (code === 'ssh_clip_agent_no_image') {
      return 'non-zero-client clip-agent reached the SSH client, but the client clipboard has no image.';
    }
    if (code === 'ssh_clip_agent_disabled') {
      return 'non-zero-client clip-agent fallback is disabled by AIH_SSH_CLIP_AGENT=0.';
    }
    if (code === 'ssh_clip_agent_timeout') {
      return `non-zero-client clip-agent timed out${endpoint ? ` at ${endpoint}` : ''}. Check the SSH RemoteForward and local agent.`;
    }
    if (code === 'ssh_clip_agent_http_status') {
      return `non-zero-client clip-agent returned HTTP ${reason.statusCode || 'error'}${endpoint ? ` at ${endpoint}` : ''}.`;
    }
    if (code) {
      return `non-zero-client clip-agent unavailable: ${code}${endpoint ? ` at ${endpoint}` : ''}.`;
    }
    return `non-zero-client clip-agent unavailable.${startAgent}${remoteForward}`;
  }

  function formatSshClipAgentOptInHint() {
    return ' Optional non-zero-client fallback is opt-in: use aih clip-agent with SSH RemoteForward and set AIH_SSH_CLIP_AGENT=1.';
  }

  function formatSshClipboardStatus(message, clipAgentReason) {
    if (!clipAgentReason) return message;
    return `${message} ${formatSshClipAgentStatus(clipAgentReason)}`;
  }

  async function tryPasteSshClipAgentImage() {
    if (!shouldEnableSshClipAgentImagePaste()) return false;
    if (sshClipAgentRequestInFlight) return false;
    sshClipAgentRequestInFlight = true;
    try {
      let clipAgentReason = null;
      const image = await fetchSshClipAgentImage({
        env: processObj.env,
        maxBytes: readSshClipMaxBytes(),
        onUnavailable: (reason) => {
          clipAgentReason = reason;
        }
      });
      if (!image) return { handled: false, reason: clipAgentReason };
      const saved = persistSshClipboardImage(image);
      injectSshClipboardImagePath(saved.filePath);
      return { handled: true };
    } catch (_error) {
      return { handled: false };
    } finally {
      sshClipAgentRequestInFlight = false;
    }
  }

  function tryPasteSshClipAgentImageOrReport(message) {
    if (!shouldEnableSshClipAgentImagePaste()) {
      writeSshClipboardStatus(`${message}${formatSshClipAgentOptInHint()}`);
      return true;
    }
    tryPasteSshClipAgentImage().then((result) => {
      if (!result || !result.handled) {
        writeSshClipboardStatus(formatSshClipboardStatus(message, result && result.reason));
      }
    });
    return true;
  }

  function consumeSshClipboardFrames(data) {
    if (!shouldEnableSshClipboardImagePaste()) return data;
    if (!sshClipboardParser) {
      sshClipboardParser = createClipboardFrameParser({
        maxBytes: readSshClipMaxBytes()
      });
    }
    const dataForParser = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const result = sshClipboardParser.consume(dataForParser);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_frame_failed');
      writeSshClipboardStatus(`SSH image paste failed: ${code}`);
    }
    if (Array.isArray(result.images)) {
      result.images.forEach((image) => {
        try {
          const saved = persistSshClipboardImage(image);
          if (image.action === 'paste') {
            injectSshClipboardImagePath(saved.filePath);
          }
        } catch (error) {
          const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_persist_failed');
          writeSshClipboardStatus(`SSH image paste failed: ${code}`);
        }
      });
    }
    if (!result.passthrough) return null;
    return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
  }

  function decodeSshBracketedPasteImage(payload) {
    const text = String(payload || '').trim();
    if (!text) return null;
    return decodeTerminalClipboardImagePayload(text, { maxBytes: readSshClipMaxBytes() })
      || decodeTerminalClipboardImagePayload(Buffer.from(text, 'utf8').toString('base64'), {
        maxBytes: readSshClipMaxBytes()
      });
  }

  function consumeSshBracketedPasteImage(data) {
    if (!shouldEnableSshClipboardImagePaste() || !isSshRuntimeSession()) return data;
    const payload = extractBracketedPastePayload(data);
    if (payload == null || payload.length === 0) return data;
    const image = decodeSshBracketedPasteImage(payload);
    if (!image) return data;
    try {
      const saved = persistSshClipboardImage(image);
      injectSshClipboardImagePath(saved.filePath);
    } catch (error) {
      const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_bracketed_paste_persist_failed');
      writeSshClipboardStatus(`SSH bracketed image paste failed: ${code}`);
    }
    return null;
  }

  function consumeSshTerminalClipboardResponse(data) {
    if (!sshTerminalClipboardParser) return data;
    const result = sshTerminalClipboardParser.consume(data);
    if (result && result.progress) {
      refreshSshTerminalClipboardTimeout();
    }
    if (result && result.pasteEventsSupport) {
      sshTerminalPasteEventsSupport = result.pasteEventsSupport.supported ? 'supported' : 'unsupported';
    }
    if (handleSshClipboardShimTerminalResult(result)) {
      if (!result.passthrough) return null;
      return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
    }
    if (Array.isArray(result.unsupportedPasteNotifications) && result.unsupportedPasteNotifications.length > 0) {
      finishSshTerminalClipboardRequest();
      const mimeTypes = formatSshTerminalMimeTypes(result.unsupportedPasteNotifications);
      const message = `SSH terminal paste event did not advertise a supported image MIME type${mimeTypes}.${formatSshTerminalClipboardReadHint()}`;
      if (requestSshTerminalClipboardOsc52ImagePaste()) {
        writeSshClipboardStatus(`${message} Trying OSC 52 fallback.`);
      } else {
        tryPasteSshClipAgentImageOrReport(message);
      }
    }
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      if (sshTerminalClipboardRequestProtocol === 'osc5522-mime-list' && requestSshTerminalClipboardOsc5522ImagePaste()) {
        if (!result.passthrough) return null;
        return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
      }
      if (sshTerminalClipboardRequestProtocol === 'osc5522' && requestSshTerminalClipboardOsc52ImagePaste()) {
        if (!result.passthrough) return null;
        return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
      }
      finishSshTerminalClipboardRequest();
      const code = String((result.errors[0] && result.errors[0].code) || result.errors[0].message || 'ssh_clip_terminal_clipboard_failed');
      tryPasteSshClipAgentImageOrReport(`SSH terminal clipboard image failed: ${code}.${formatSshTerminalClipboardReadHint()}`);
    }
    if (Array.isArray(result.images) && result.images.length > 0) {
      finishSshTerminalClipboardRequest();
      result.images.forEach((image) => {
        try {
          const saved = persistSshClipboardImage(image);
          injectSshClipboardImagePath(saved.filePath);
        } catch (error) {
          const code = String((error && error.code) || (error && error.message) || error || 'ssh_clip_terminal_clipboard_persist_failed');
          writeSshClipboardStatus(`SSH terminal clipboard image failed: ${code}`);
        }
      });
    }
    if (Array.isArray(result.textPastes) && result.textPastes.length > 0) {
      finishSshTerminalClipboardRequest();
      result.textPastes.forEach((textPaste) => {
        try {
          writePtyInput(textPaste.buffer.toString('utf8'));
        } catch (_error) {}
      });
    }
    if (Array.isArray(result.pasteRequests) && result.pasteRequests.length > 0) {
      finishSshTerminalClipboardRequest();
      result.pasteRequests.forEach((request) => {
        requestSshTerminalClipboardMimePaste(request);
      });
    }
    if (Array.isArray(result.mimeLists) && result.mimeLists.length > 0) {
      finishSshTerminalClipboardRequest();
      const mimeType = chooseSshTerminalImageMimeType(result.mimeLists.flat());
      if (mimeType) {
        requestSshTerminalClipboardMimePaste({
          mimeType,
          name: 'AIH image paste'
        });
      } else if (!requestSshTerminalClipboardOsc52ImagePaste()) {
        tryPasteSshClipAgentImageOrReport(`SSH terminal clipboard has no supported image MIME type.${formatSshTerminalClipboardReadHint()}`);
      }
    }
    if (!result.passthrough) return null;
    return Buffer.isBuffer(data) ? result.passthrough : result.passthrough.toString('utf8');
  }

  function requestSshTerminalClipboardMimePaste(request) {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
    ensureSshTerminalClipboardParser();
    const mimeType = String(request && request.mimeType || '').trim().toLowerCase();
    const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadMimeQuery({
      mimeType: request && request.mimeType,
      loc: request && request.loc,
      pw: request && request.pw,
      passwordKey: request && request.passwordKey,
      name: request && request.name,
      tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
    }));
    if (!wrote) return false;
    if (mimeType === 'text/plain') {
      startSshTerminalClipboardTimeout('osc5522-text-paste', readSshTerminalClipboardTimeoutMs(1500), () => {
        sshTerminalClipboardRequestProtocol = '';
        writeSshClipboardStatus('SSH terminal paste event did not return text clipboard data. Normal paste requires terminal OSC 5522 paste-event data support.');
      });
      return true;
    }
    startSshTerminalClipboardTimeout('osc5522', readSshTerminalClipboardTimeoutMs(5000), () => {
      if (!requestSshTerminalClipboardOsc52ImagePaste()) {
        sshTerminalClipboardRequestProtocol = '';
        tryPasteSshClipAgentImageOrReport(`SSH terminal paste event did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
      }
    });
    return true;
  }

  function startSshTerminalClipboardTimeout(protocol, timeoutMs, onTimeout) {
    sshTerminalClipboardRequestProtocol = protocol;
    clearSshTerminalClipboardPromptTimer();
    const config = { protocol, timeoutMs, onTimeout };
    sshTerminalClipboardTimeoutConfig = config;
    armSshTerminalClipboardTimeout(config);
  }

  function armSshTerminalClipboardTimeout(config) {
    const token = Symbol('ssh-terminal-clipboard-timeout');
    config.token = token;
    sshTerminalClipboardPromptTimer = setTimeout(() => {
      if (sshTerminalClipboardTimeoutConfig !== config || config.token !== token) return;
      sshTerminalClipboardPromptTimer = null;
      sshTerminalClipboardTimeoutConfig = null;
      config.onTimeout();
    }, config.timeoutMs);
    if (sshTerminalClipboardPromptTimer && typeof sshTerminalClipboardPromptTimer.unref === 'function') {
      sshTerminalClipboardPromptTimer.unref();
    }
  }

  function refreshSshTerminalClipboardTimeout() {
    const config = sshTerminalClipboardTimeoutConfig;
    if (!config || !sshTerminalClipboardPromptTimer) return;
    clearTimeout(sshTerminalClipboardPromptTimer);
    sshTerminalClipboardPromptTimer = null;
    armSshTerminalClipboardTimeout(config);
  }

  function requestSshTerminalClipboardOsc52ImagePaste() {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
    ensureSshTerminalClipboardParser();
    try {
      const wrote = writeSshTerminalClipboardSequence(buildOsc52ClipboardReadQuery({
        selection: 'c',
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) return false;
    } catch (_error) {
      return false;
    }
    startSshTerminalClipboardTimeout('osc52', readSshTerminalClipboardTimeoutMs(5000), () => {
      sshTerminalClipboardRequestProtocol = '';
      tryPasteSshClipAgentImageOrReport(`SSH terminal did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
    });
    return true;
  }

  function requestSshTerminalClipboardOsc5522ImagePaste() {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
    ensureSshTerminalClipboardParser();
    try {
      sshTerminalClipboardRequestSeq += 1;
      const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardReadImageQuery({
        id: `aih-${processObj.pid || 'pid'}-${sshTerminalClipboardRequestSeq}`,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) return false;
    } catch (_error) {
      return false;
    }
    startSshTerminalClipboardTimeout('osc5522', readSshTerminalClipboardTimeoutMs(5000), () => {
      if (!requestSshTerminalClipboardOsc52ImagePaste()) {
        sshTerminalClipboardRequestProtocol = '';
        tryPasteSshClipAgentImageOrReport(`SSH terminal did not return image clipboard data.${formatSshTerminalClipboardReadHint()}`);
      }
    });
    return true;
  }

  function requestSshTerminalClipboardOsc5522MimeList() {
    if (!shouldEnableSshTerminalClipboardImagePaste()) return false;
    ensureSshTerminalClipboardParser();
    try {
      sshTerminalClipboardRequestSeq += 1;
      const wrote = writeSshTerminalClipboardSequence(buildOsc5522ClipboardListMimeTypesQuery({
        id: `aih-${processObj.pid || 'pid'}-${sshTerminalClipboardRequestSeq}`,
        tmuxPassthrough: shouldWrapSshTerminalClipboardQueryForTmux()
      }));
      if (!wrote) return false;
    } catch (_error) {
      return false;
    }
    startSshTerminalClipboardTimeout('osc5522-mime-list', readSshTerminalClipboardTimeoutMs(900), () => {
      if (!requestSshTerminalClipboardOsc5522ImagePaste() && !requestSshTerminalClipboardOsc52ImagePaste()) {
        sshTerminalClipboardRequestProtocol = '';
        tryPasteSshClipAgentImageOrReport(`SSH terminal did not return clipboard MIME data.${formatSshTerminalClipboardReadHint()}`);
      }
    });
    return true;
  }

  function requestSshTerminalClipboardImagePaste() {
    if (sshTerminalPasteEventsSupport === 'unsupported' && requestSshTerminalClipboardOsc52ImagePaste()) {
      return true;
    }
    return requestSshTerminalClipboardOsc5522MimeList()
      || requestSshTerminalClipboardOsc5522ImagePaste()
      || requestSshTerminalClipboardOsc52ImagePaste();
  }

  function tryPasteLatestSshClipboardImage() {
    if (!shouldEnableSshClipboardImagePaste()) return false;
    try {
      const latest = getSshClipboardInbox().latestImagePath();
      if (latest) {
        injectSshClipboardImagePath(latest);
        return true;
      }
    } catch (_error) {}
    if (requestSshTerminalClipboardImagePaste()) return true;
    return tryPasteSshClipAgentImageOrReport('SSH image paste in strict zero-client mode needs terminal clipboard read support such as OSC 5522 or OSC 52 image/data-url data.');
  }
  return {
    isSshRuntimeSession,
    shouldEnableSshClipboardImagePaste,
    startSshTerminalPasteEventsMode,
    stopSshTerminalPasteEventsMode,
    clearSshTerminalClipboardPromptTimer,
    consumeSshClipboardFrames,
    consumeSshBracketedPasteImage,
    consumeSshTerminalClipboardResponse,
    consumeSshClipboardShimRequests,
    tryPasteLatestSshClipboardImage
  };
}

module.exports = {
  createSshClipboardBridge
};
