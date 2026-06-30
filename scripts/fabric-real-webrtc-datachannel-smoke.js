#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright } = require('./playwright-require');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_PAGE_PATH = '/ui/fabric/webrtc-diagnostics';
const DEFAULT_ICE_SERVERS = ['stun:stun.l.google.com:19302'];
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_SAMPLE_COUNT = 5;
const DEFAULT_RPC_SAMPLE_COUNT = 3;
const DEFAULT_BROWSER_CHANNEL = 'chrome';
const DEFAULT_ICE_TRANSPORT_POLICY = 'all';

function showHelp() {
  console.log(`AIH Fabric real WebRTC DataChannel smoke

Usage:
  npx --yes --package playwright node scripts/fabric-real-webrtc-datachannel-smoke.js [options]

Options:
  --endpoint <url>        AWS/current signaling endpoint, default ${DEFAULT_ENDPOINT}.
  --page-url <url>        Browser page URL, default <endpoint>${DEFAULT_PAGE_PATH}.
  --ice-server <url>      ICE server URL. Can be passed multiple times.
  --ice-username <value>  Optional TURN username applied to turn:/turns: servers.
  --ice-credential <v>    Optional TURN credential applied to turn:/turns: servers.
  --ice-transport-policy <all|relay>
                          RTCPeerConnection iceTransportPolicy, default ${DEFAULT_ICE_TRANSPORT_POLICY}.
  --no-default-stun       Do not add the default public STUN server.
  --sample-count <n>      Ping/pong RTT samples, default ${DEFAULT_SAMPLE_COUNT}.
  --rpc-sample-count <n>  DataChannel RPC echo samples, default ${DEFAULT_RPC_SAMPLE_COUNT}.
  --timeout-ms <n>        End-to-end timeout, default ${DEFAULT_TIMEOUT_MS}.
  --diagnostics-file <p>  Optional sanitized JSON export path.
  --browser-channel <c>   Playwright browser channel, default ${DEFAULT_BROWSER_CHANNEL}; use bundled for Playwright Chromium.
  --create-room-only      Create a signaling room and exit.
  --room-id <id>          Existing signaling room for single-peer mode.
  --peer-role <role>      Run one peer only: offerer or answerer.
  --peer-id <id>          Stable peer id for single-peer mode.
  --headed                Show the browser window.
  -h, --help              Show this help.

This smoke opens two real Chromium pages, creates one real Fabric WebRTC
signaling room on the configured endpoint, exchanges offer/answer/candidates
through the server, opens a real RTCDataChannel, and records application-level
RTT samples. It does not open a new product port and does not touch old VPS
targets.
`);
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

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
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

function normalizeIceServerUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^(stun|stuns|turn|turns):/i.test(raw)) {
    throw new Error('--ice-server must start with stun:, stuns:, turn:, or turns:');
  }
  return raw;
}

function normalizeIceServerList(values = [], options = {}) {
  const urls = [];
  if (options.useDefaultStun !== false) urls.push(...DEFAULT_ICE_SERVERS);
  for (const value of values) {
    for (const part of String(value || '').split(/[\n,]+/)) {
      const normalized = normalizeIceServerUrl(part);
      if (normalized) urls.push(normalized);
    }
  }
  return Array.from(new Set(urls));
}

function normalizeIceTransportPolicy(value, flag = '--ice-transport-policy') {
  const normalized = String(value || DEFAULT_ICE_TRANSPORT_POLICY).trim().toLowerCase();
  if (normalized === 'all' || normalized === 'relay') return normalized;
  throw new Error(`${flag} must be all or relay`);
}

function normalizeBrowserChannel(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function normalizePeerRole(value, flag = '--peer-role') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'offerer' || normalized === 'answerer') return normalized;
  throw new Error(`${flag} must be offerer or answerer`);
}

function normalizeSimpleId(value, flag) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${flag} requires a value`);
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(normalized)) {
    throw new Error(`${flag} must contain only letters, numbers, dot, underscore, colon, or dash`);
  }
  return normalized;
}

function buildRtcIceServers(urls = [], options = {}) {
  const username = String(options.username || '').trim();
  const credential = String(options.credential || '');
  return urls.map((url) => {
    const server = { urls: url };
    if (/^turns?:/i.test(String(url || '')) && username && credential) {
      server.username = username;
      server.credential = credential;
    }
    return server;
  });
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    pageUrl: '',
    iceServerUrls: [],
    iceUsername: '',
    iceCredential: '',
    iceTransportPolicy: DEFAULT_ICE_TRANSPORT_POLICY,
    useDefaultStun: true,
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    createRoomOnly: false,
    roomId: '',
    peerRole: '',
    peerId: '',
    headed: false
  };

  for (let index = 0; index < argv.length;) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--no-default-stun') {
      options.useDefaultStun = false;
      index += 1;
      continue;
    }
    if (token === '--create-room-only') {
      options.createRoomOnly = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--page-url' || token.startsWith('--page-url=')) {
      const next = readOptionValue(argv, index, '--page-url');
      options.pageUrl = normalizeHttpEndpoint(next.value, '--page-url');
      index += next.consumed;
      continue;
    }
    if (token === '--ice-server' || token.startsWith('--ice-server=')) {
      const next = readOptionValue(argv, index, '--ice-server');
      options.iceServerUrls.push(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--ice-username' || token.startsWith('--ice-username=')) {
      const next = readOptionValue(argv, index, '--ice-username');
      options.iceUsername = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--ice-credential' || token.startsWith('--ice-credential=')) {
      const next = readOptionValue(argv, index, '--ice-credential');
      options.iceCredential = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--ice-transport-policy' || token.startsWith('--ice-transport-policy=')) {
      const next = readOptionValue(argv, index, '--ice-transport-policy');
      options.iceTransportPolicy = normalizeIceTransportPolicy(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--sample-count' || token.startsWith('--sample-count=')) {
      const next = readOptionValue(argv, index, '--sample-count');
      options.sampleCount = parsePositiveInteger(next.value, '--sample-count', DEFAULT_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--rpc-sample-count' || token.startsWith('--rpc-sample-count=')) {
      const next = readOptionValue(argv, index, '--rpc-sample-count');
      options.rpcSampleCount = parsePositiveInteger(next.value, '--rpc-sample-count', DEFAULT_RPC_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 1000, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--browser-channel' || token.startsWith('--browser-channel=')) {
      const next = readOptionValue(argv, index, '--browser-channel');
      options.browserChannel = normalizeBrowserChannel(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--room-id' || token.startsWith('--room-id=')) {
      const next = readOptionValue(argv, index, '--room-id');
      options.roomId = normalizeSimpleId(next.value, '--room-id');
      index += next.consumed;
      continue;
    }
    if (token === '--peer-role' || token.startsWith('--peer-role=')) {
      const next = readOptionValue(argv, index, '--peer-role');
      options.peerRole = normalizePeerRole(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--peer-id' || token.startsWith('--peer-id=')) {
      const next = readOptionValue(argv, index, '--peer-id');
      options.peerId = normalizeSimpleId(next.value, '--peer-id');
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.iceServerUrls = normalizeIceServerList(options.iceServerUrls, {
    useDefaultStun: options.useDefaultStun
  });
  if (!options.help && options.iceServerUrls.length === 0) {
    throw new Error('at least one --ice-server is required when --no-default-stun is set');
  }
  if (!options.help && options.createRoomOnly && options.peerRole) {
    throw new Error('--create-room-only cannot be combined with --peer-role');
  }
  if (!options.help && options.peerRole && !options.roomId) {
    throw new Error('--room-id is required with --peer-role');
  }
  if (!options.help && options.peerId && !options.peerRole) {
    throw new Error('--peer-id requires --peer-role');
  }
  if (!options.help && Boolean(options.iceUsername) !== Boolean(options.iceCredential)) {
    throw new Error('--ice-username and --ice-credential must be provided together');
  }
  if (!options.pageUrl) options.pageUrl = `${options.endpoint}${DEFAULT_PAGE_PATH}`;
  return options;
}

function summarizeRtt(samples = []) {
  const values = samples
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (values.length === 0) return { count: 0, avg: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sum = values.reduce((total, value) => total + value, 0);
  const pick = (rank) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * rank) - 1))];
  return {
    count: values.length,
    avg: Math.round((sum / values.length) * 100) / 100,
    p50: pick(0.50),
    p95: pick(0.95),
    min: values[0],
    max: values[values.length - 1]
  };
}

function candidateKind(line) {
  const text = String(line || '');
  if (text.includes(' typ relay ')) return 'relay';
  if (text.includes(' typ srflx ')) return 'srflx';
  if (text.includes(' typ prflx ')) return 'prflx';
  if (text.includes(' typ host ')) return 'host';
  return text ? 'other' : 'empty';
}

function summarizeCandidateKinds(lines = []) {
  const counts = {};
  for (const line of lines) {
    if (!line) continue;
    const kind = candidateKind(line);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function sanitizeIceServerUrls(urls = []) {
  return urls.map((url) => {
    const raw = String(url || '');
    if (/^turns?:/i.test(raw) && raw.includes('@')) {
      return raw.replace(/\/\/[^@]+@/, '//<redacted>@');
    }
    return raw;
  });
}

function summarizeIceServerAuth(options = {}) {
  return {
    username: options.iceUsername ? '<set>' : '',
    credential: options.iceCredential ? '<redacted>' : ''
  };
}

function getRpcSampleCount(options = {}) {
  const value = Number(options.rpcSampleCount);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function summarizeRpcAdapter(options = {}, peer = {}, responder = {}) {
  const sampleCount = getRpcSampleCount(options);
  const rtt = summarizeRtt(peer.rpcRttSamples || []);
  const responses = Number(peer.rpcResponses || 0);
  const requestsHandled = Number(responder.rpcRequestsHandled || peer.rpcRequestsHandled || 0);
  const ok = sampleCount === 0 || (responses >= sampleCount && requestsHandled >= sampleCount && rtt.count >= sampleCount);
  return {
    adapter: 'datachannel-json-rpc-echo',
    sampleCount,
    ok,
    responses,
    requestsHandled,
    rtt
  };
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { parseError: true, raw: text };
  }
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  const response = await fetchImpl(url, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal || timeoutSignal(options.timeoutMs || 10000)
  });
  const payload = await readJsonResponse(response);
  return {
    status: response.status,
    ok: response.ok && payload && payload.ok !== false,
    payload
  };
}

async function createSignalingRoom(endpoint, deps = {}) {
  const response = await fetchJson(`${endpoint}/v0/fabric/webrtc/signaling/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'AIH Fabric WebRTC DataChannel Smoke' }),
    timeoutMs: 10000,
    fetchImpl: deps.fetchImpl
  });
  if (!response.ok || !response.payload || !response.payload.result || !response.payload.result.roomId) {
    const error = new Error(String(response.payload && response.payload.error || `room_create_http_${response.status}`));
    error.response = response;
    throw error;
  }
  return response.payload.result;
}

async function readRoomMessages(endpoint, roomId, deps = {}) {
  const response = await fetchJson(`${endpoint}/v0/fabric/webrtc/signaling/rooms/${encodeURIComponent(roomId)}/messages?since=0&limit=200`, {
    timeoutMs: 10000,
    fetchImpl: deps.fetchImpl
  });
  if (!response.ok || !response.payload || !response.payload.result) return [];
  return Array.isArray(response.payload.result.messages) ? response.payload.result.messages : [];
}

async function webrtcPeerEvaluate(input) {
  const endpoint = String(input.endpoint || '').replace(/\/+$/, '');
  const peerId = String(input.peerId || '');
  const roomId = String(input.roomId || '');
  const role = input.role === 'answerer' ? 'answerer' : 'offerer';
  const sampleCount = Math.max(1, Number(input.sampleCount) || 5);
  const rpcSampleCount = Math.max(1, Number(input.rpcSampleCount) || 3);
  const timeoutMs = Math.max(1000, Number(input.timeoutMs) || 30000);
  const iceServers = Array.isArray(input.iceServers) ? input.iceServers : [];
  const iceTransportPolicy = input.iceTransportPolicy === 'relay' ? 'relay' : 'all';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const localCandidates = [];
  const remoteCandidates = [];
  const events = [];
  const rttSamples = [];
  const rpcRttSamples = [];
  const handledSeqs = new Set();
  const pendingPings = new Map();
  const pendingRpcs = new Map();
  let lastSeq = 0;
  let channelOpenedAt = 0;
  let pongs = 0;
  let pingsHandled = 0;
  let rpcResponses = 0;
  let rpcRequestsHandled = 0;
  let pc;
  let channel;

  const localCandidateKind = (line) => {
    const text = String(line || '');
    if (text.includes(' typ relay ')) return 'relay';
    if (text.includes(' typ srflx ')) return 'srflx';
    if (text.includes(' typ prflx ')) return 'prflx';
    if (text.includes(' typ host ')) return 'host';
    return text ? 'other' : 'empty';
  };

  const countCandidateKinds = (lines) => {
    const counts = {};
    for (const line of lines || []) {
      if (!line) continue;
      const kind = localCandidateKind(line);
      counts[kind] = (counts[kind] || 0) + 1;
    }
    return counts;
  };

  const record = (event) => {
    events.push({
      t: Date.now(),
      ...event
    });
  };

  const sendSignal = async (type, payload) => {
    const response = await fetch(`${endpoint}/v0/fabric/webrtc/signaling/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peerId, type, payload })
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(String(body && body.error || `signal_${type}_http_${response.status}`));
    return body.result;
  };

  const listSignals = async () => {
    const response = await fetch(`${endpoint}/v0/fabric/webrtc/signaling/rooms/${encodeURIComponent(roomId)}/messages?since=${lastSeq}&limit=100`);
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(String(body && body.error || `signals_http_${response.status}`));
    return body.result || { messages: [], nextSeq: lastSeq };
  };

  const waitGatheringComplete = () => new Promise((resolve) => {
    if (!pc || pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.min(8000, timeoutMs));
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  const flushRemoteCandidate = async (candidate) => {
    if (!pc || !candidate) return;
    if (!pc.remoteDescription) {
      remoteCandidates.push({ queued: true, candidate: candidate.candidate || '' });
      return;
    }
    await pc.addIceCandidate(candidate);
    remoteCandidates.push({ queued: false, candidate: candidate.candidate || '' });
  };

  const handleSignals = async () => {
    const result = await listSignals();
    for (const signal of result.messages || []) {
      lastSeq = Math.max(lastSeq, Number(signal.seq) || lastSeq);
      if (!signal || signal.peerId === peerId || handledSeqs.has(signal.seq)) continue;
      handledSeqs.add(signal.seq);
      if (signal.type === 'offer' && role === 'answerer') {
        if (pc.remoteDescription) continue;
        await pc.setRemoteDescription({ type: 'offer', sdp: String(signal.payload && signal.payload.sdp || '') });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await sendSignal('answer', {
          type: pc.localDescription && pc.localDescription.type || 'answer',
          sdp: pc.localDescription && pc.localDescription.sdp || ''
        });
        record({ type: 'answer_sent', seq: signal.seq });
        continue;
      }
      if (signal.type === 'answer' && role === 'offerer') {
        if (pc.remoteDescription) continue;
        await pc.setRemoteDescription({ type: 'answer', sdp: String(signal.payload && signal.payload.sdp || '') });
        record({ type: 'answer_received', seq: signal.seq });
        continue;
      }
      if (signal.type === 'candidate') {
        const candidate = signal.payload && signal.payload.candidate;
        if (candidate) await flushRemoteCandidate(candidate);
      }
    }
    lastSeq = Math.max(lastSeq, Number(result.nextSeq) || lastSeq);
  };

  const setupChannel = (nextChannel) => {
    channel = nextChannel;
    record({ type: 'channel_state', state: channel.readyState });
    channel.onopen = () => {
      channelOpenedAt = Date.now();
      record({ type: 'channel_open' });
    };
    channel.onclose = () => record({ type: 'channel_close' });
    channel.onerror = () => record({ type: 'channel_error' });
    channel.onmessage = (event) => {
      let payload = {};
      try {
        payload = JSON.parse(String(event.data || '{}'));
      } catch (_error) {
        record({ type: 'message_parse_error' });
        return;
      }
      if (payload.kind === 'ping' && payload.id) {
        pingsHandled += 1;
        channel.send(JSON.stringify({ kind: 'pong', id: payload.id, sentAt: payload.sentAt }));
        return;
      }
      if (payload.kind === 'pong' && payload.id) {
        const pending = pendingPings.get(payload.id);
        if (!pending) return;
        pendingPings.delete(payload.id);
        pongs += 1;
        rttSamples.push(Math.max(0, Math.round((performance.now() - pending.sentAt) * 100) / 100));
        return;
      }
      if (payload.kind === 'rpc_request' && payload.id) {
        rpcRequestsHandled += 1;
        const result = payload.method === 'fabric.webrtc.echo'
          ? {
            echo: payload.params && payload.params.echo || '',
            handledBy: peerId
          }
          : null;
        channel.send(JSON.stringify({
          kind: 'rpc_response',
          id: payload.id,
          ok: Boolean(result),
          result,
          error: result ? '' : 'unknown_rpc_method'
        }));
        return;
      }
      if (payload.kind === 'rpc_response' && payload.id) {
        const pending = pendingRpcs.get(payload.id);
        if (!pending) return;
        pendingRpcs.delete(payload.id);
        if (payload.ok && payload.result && payload.result.echo === pending.echo) {
          rpcResponses += 1;
          rpcRttSamples.push(Math.max(0, Math.round((performance.now() - pending.sentAt) * 100) / 100));
        }
      }
    };
  };

  const sendPing = () => {
    if (!channel || channel.readyState !== 'open') return;
    const id = `${peerId}-ping-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sentAt = performance.now();
    pendingPings.set(id, { sentAt });
    channel.send(JSON.stringify({ kind: 'ping', id, sentAt }));
  };

  const sendRpcRequest = () => {
    if (!channel || channel.readyState !== 'open') return;
    const id = `${peerId}-rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const echo = `aih-webrtc-rpc-${id}`;
    const sentAt = performance.now();
    pendingRpcs.set(id, { sentAt, echo });
    channel.send(JSON.stringify({
      kind: 'rpc_request',
      id,
      method: 'fabric.webrtc.echo',
      params: { echo }
    }));
  };

  try {
    pc = new RTCPeerConnection({ iceServers, iceTransportPolicy });
    pc.onconnectionstatechange = () => record({ type: 'connection', state: pc.connectionState, ice: pc.iceConnectionState });
    pc.oniceconnectionstatechange = () => record({ type: 'ice', state: pc.iceConnectionState, connection: pc.connectionState });
    pc.onicegatheringstatechange = () => record({ type: 'gathering', state: pc.iceGatheringState });
    pc.onicecandidateerror = (event) => {
      record({
        type: 'ice_candidate_error',
        address: event.address || '',
        port: event.port || 0,
        url: event.url || '',
        errorCode: event.errorCode || 0,
        errorText: event.errorText || ''
      });
    };
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        localCandidates.push('');
        return;
      }
      localCandidates.push(event.candidate.candidate || '');
      sendSignal('candidate', { candidate: event.candidate.toJSON() })
        .catch((error) => record({ type: 'candidate_send_error', message: String(error && error.message || error) }));
    };
    pc.ondatachannel = (event) => setupChannel(event.channel);

    if (role === 'offerer') {
      setupChannel(pc.createDataChannel('aih-fabric-datachannel-smoke', { ordered: true }));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendSignal('offer', {
        type: pc.localDescription && pc.localDescription.type || 'offer',
        sdp: pc.localDescription && pc.localDescription.sdp || ''
      });
      record({ type: 'offer_sent' });
    } else {
      await sendSignal('ready', { role: 'answerer' });
      record({ type: 'ready_sent' });
    }

    let nextPingAt = 0;
    let nextRpcAt = 0;
    while (Date.now() < deadline) {
      await handleSignals();
      if (role === 'offerer' && channel && channel.readyState === 'open' && pongs < sampleCount) {
        const now = Date.now();
        if (now >= nextPingAt) {
          sendPing();
          nextPingAt = now + 160;
        }
      }
      if (role === 'offerer' && channel && channel.readyState === 'open' && rpcResponses < rpcSampleCount) {
        const now = Date.now();
        if (now >= nextRpcAt) {
          sendRpcRequest();
          nextRpcAt = now + 180;
        }
      }
      const offererDone = role === 'offerer' && pongs >= sampleCount && rpcResponses >= rpcSampleCount;
      const answererDone = role === 'answerer'
        && pingsHandled >= sampleCount
        && rpcRequestsHandled >= rpcSampleCount
        && channel
        && channel.readyState === 'open';
      if (offererDone || answererDone) break;
      if (pc.connectionState === 'failed') break;
      await sleep(100);
    }
    await waitGatheringComplete();

    let selectedCandidatePair = null;
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((item) => {
        if (item.type === 'candidate-pair' && (item.selected || item.state === 'succeeded')) pair = item;
      });
      if (pair) {
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        selectedCandidatePair = {
          state: pair.state || '',
          nominated: pair.nominated === true,
          localCandidateType: local && local.candidateType || '',
          remoteCandidateType: remote && remote.candidateType || '',
          currentRoundTripTime: Number.isFinite(pair.currentRoundTripTime) ? pair.currentRoundTripTime : null
        };
      }
    } catch (error) {
      record({ type: 'stats_error', message: String(error && error.message || error) });
    }

    return {
      ok: role === 'offerer'
        ? rttSamples.length >= sampleCount
        : Boolean(channelOpenedAt && pingsHandled >= sampleCount),
      role,
      peerId,
      startedAt,
      durationMs: Date.now() - startedAt,
      channelState: channel ? channel.readyState : 'missing',
      channelOpened: Boolean(channelOpenedAt),
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      localCandidateKinds: countCandidateKinds(localCandidates),
      remoteCandidateKinds: countCandidateKinds(remoteCandidates.map((item) => item.candidate || '')),
      localCandidateCount: localCandidates.filter(Boolean).length,
      remoteCandidateCount: remoteCandidates.length,
      rttSamples,
      pongs,
      pingsHandled,
      rpcSampleCount,
      rpcRttSamples,
      rpcResponses,
      rpcRequestsHandled,
      selectedCandidatePair,
      signalSeq: lastSeq,
      events: events.slice(-80)
    };
  } finally {
    if (channel) channel.close();
    if (pc) pc.close();
  }
}

function buildReport(options, details) {
  const offerer = details.offerer || {};
  const answerer = details.answerer || {};
  const rtt = summarizeRtt(offerer.rttSamples || []);
  const rpc = summarizeRpcAdapter(options, offerer, answerer);
  const ok = Boolean(
    offerer.ok &&
    answerer.ok &&
    offerer.channelOpened &&
    answerer.channelOpened &&
    rtt.count >= options.sampleCount &&
    rpc.ok
  );
  return {
    ok,
    mode: 'webrtc-datachannel-smoke',
    endpoint: options.endpoint,
    pageUrl: options.pageUrl,
    roomId: details.room && details.room.roomId || '',
    browser: details.browser || {},
    iceServers: sanitizeIceServerUrls(options.iceServerUrls),
    iceServerAuth: summarizeIceServerAuth(options),
    iceTransportPolicy: options.iceTransportPolicy,
    sampleCount: options.sampleCount,
    rpcSampleCount: getRpcSampleCount(options),
    timeoutMs: options.timeoutMs,
    rtt,
    rpc,
    offerer,
    answerer,
    signaling: {
      messages: (details.roomMessages || []).map((item) => ({
        seq: item.seq,
        type: item.type,
        peerId: String(item.peerId || '').startsWith('peer-') ? 'peer-<redacted>' : String(item.peerId || '')
      }))
    },
    console: details.console || {}
  };
}

function buildRoomReport(options, room) {
  return {
    ok: Boolean(room && room.roomId),
    mode: 'webrtc-signaling-room-create',
    endpoint: options.endpoint,
    pageUrl: options.pageUrl,
    room
  };
}

function buildPeerReport(options, details) {
  const peer = details.peer || {};
  const rtt = summarizeRtt(peer.rttSamples || []);
  const role = options.peerRole || peer.role || '';
  const roleComplete = role === 'offerer'
    ? rtt.count >= options.sampleCount
    : Number(peer.pingsHandled || 0) >= options.sampleCount;
  const rpc = summarizeRpcAdapter(options, peer, peer);
  const rpcComplete = getRpcSampleCount(options) === 0 || (
    role === 'offerer'
      ? rpc.responses >= getRpcSampleCount(options) && rpc.rtt.count >= getRpcSampleCount(options)
      : rpc.requestsHandled >= getRpcSampleCount(options)
  );
  rpc.ok = rpcComplete;
  const ok = Boolean(peer.ok && peer.channelOpened && roleComplete && rpcComplete);
  return {
    ok,
    mode: 'webrtc-datachannel-peer-smoke',
    endpoint: options.endpoint,
    pageUrl: options.pageUrl,
    roomId: options.roomId,
    role,
    peerId: peer.peerId || options.peerId || '',
    browser: details.browser || {},
    iceServers: sanitizeIceServerUrls(options.iceServerUrls),
    iceServerAuth: summarizeIceServerAuth(options),
    iceTransportPolicy: options.iceTransportPolicy,
    sampleCount: options.sampleCount,
    rpcSampleCount: getRpcSampleCount(options),
    timeoutMs: options.timeoutMs,
    rtt,
    rpc,
    peer,
    signaling: {
      messages: (details.roomMessages || []).map((item) => ({
        seq: item.seq,
        type: item.type,
        peerId: String(item.peerId || '').startsWith('peer-') ? 'peer-<redacted>' : String(item.peerId || '')
      }))
    },
    console: details.console || {}
  };
}

async function writeDiagnosticsFile(filePath, report) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function createBrowserLaunchOptions(options = {}) {
  const launchOptions = { headless: !options.headed };
  if (options.browserChannel) launchOptions.channel = options.browserChannel;
  return launchOptions;
}

async function runWebrtcDatachannelSmoke(options = {}, deps = {}) {
  const playwright = deps.playwright || loadPlaywright();
  const room = await createSignalingRoom(options.endpoint, deps);
  const browser = await playwright.chromium.launch(createBrowserLaunchOptions(options));
  const consoleMessages = [];
  const pageErrors = [];
  const startedAt = Date.now();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const offerPage = await context.newPage();
    const answerPage = await context.newPage();
    for (const [label, page] of [['offerer', offerPage], ['answerer', answerPage]]) {
      page.on('console', (message) => {
        consoleMessages.push({ page: label, type: message.type(), text: message.text() });
      });
      page.on('pageerror', (error) => {
        pageErrors.push({ page: label, message: String(error && error.message || error) });
      });
      await page.goto(options.pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(options.timeoutMs, 30000) });
    }

    const iceServers = buildRtcIceServers(options.iceServerUrls, {
      username: options.iceUsername,
      credential: options.iceCredential
    });
    const baseInput = {
      endpoint: options.endpoint,
      roomId: room.roomId,
      iceServers,
      iceTransportPolicy: options.iceTransportPolicy,
      sampleCount: options.sampleCount,
      rpcSampleCount: options.rpcSampleCount,
      timeoutMs: options.timeoutMs
    };
    const [offerer, answerer] = await Promise.all([
      offerPage.evaluate(webrtcPeerEvaluate, { ...baseInput, peerId: `peer-offer-${Date.now()}`, role: 'offerer' }),
      answerPage.evaluate(webrtcPeerEvaluate, { ...baseInput, peerId: `peer-answer-${Date.now()}`, role: 'answerer' })
    ]);
    const roomMessages = await readRoomMessages(options.endpoint, room.roomId, deps);
    await context.close();
    const report = buildReport(options, {
      room,
      roomMessages,
      offerer,
      answerer,
      browser: {
        engine: 'chromium',
        channel: options.browserChannel || 'bundled',
        headed: options.headed === true,
        durationMs: Date.now() - startedAt
      },
      console: {
        errors: consoleMessages.filter((item) => item.type === 'error').length,
        warnings: consoleMessages.filter((item) => item.type === 'warning').length,
        pageErrors
      }
    });
    await writeDiagnosticsFile(options.diagnosticsFile, report);
    return report;
  } finally {
    await browser.close();
  }
}

async function runWebrtcCreateRoom(options = {}, deps = {}) {
  const room = await createSignalingRoom(options.endpoint, deps);
  const report = buildRoomReport(options, room);
  await writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function runWebrtcPeerSmoke(options = {}, deps = {}) {
  const playwright = deps.playwright || loadPlaywright();
  const browser = await playwright.chromium.launch(createBrowserLaunchOptions(options));
  const consoleMessages = [];
  const pageErrors = [];
  const startedAt = Date.now();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on('pageerror', (error) => {
      pageErrors.push({ message: String(error && error.message || error) });
    });
    await page.goto(options.pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(options.timeoutMs, 30000) });

    const peerId = options.peerId || `peer-${options.peerRole}-${Date.now()}`;
    const peer = await page.evaluate(webrtcPeerEvaluate, {
      endpoint: options.endpoint,
      roomId: options.roomId,
      peerId,
      role: options.peerRole,
      iceServers: buildRtcIceServers(options.iceServerUrls, {
        username: options.iceUsername,
        credential: options.iceCredential
      }),
      iceTransportPolicy: options.iceTransportPolicy,
      sampleCount: options.sampleCount,
      rpcSampleCount: options.rpcSampleCount,
      timeoutMs: options.timeoutMs
    });
    const roomMessages = await readRoomMessages(options.endpoint, options.roomId, deps);
    await context.close();
    const report = buildPeerReport(options, {
      roomMessages,
      peer,
      browser: {
        engine: 'chromium',
        channel: options.browserChannel || 'bundled',
        headed: options.headed === true,
        durationMs: Date.now() - startedAt
      },
      console: {
        errors: consoleMessages.filter((item) => item.type === 'error').length,
        warnings: consoleMessages.filter((item) => item.type === 'warning').length,
        pageErrors
      }
    });
    await writeDiagnosticsFile(options.diagnosticsFile, report);
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      showHelp();
      return;
    }
    const result = options.createRoomOnly
      ? await runWebrtcCreateRoom(options)
      : options.peerRole
        ? await runWebrtcPeerSmoke(options)
        : await runWebrtcDatachannelSmoke(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`\x1b[31m[aih] fabric real webrtc datachannel smoke failed: ${String(error && error.message || error)}\x1b[0m`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_ICE_SERVERS,
  DEFAULT_ICE_TRANSPORT_POLICY,
  DEFAULT_RPC_SAMPLE_COUNT,
  buildPeerReport,
  buildReport,
  buildRoomReport,
  buildRtcIceServers,
  candidateKind,
  createBrowserLaunchOptions,
  createSignalingRoom,
  loadPlaywright,
  normalizeIceServerList,
  normalizeIceTransportPolicy,
  parseArgs,
  runWebrtcCreateRoom,
  runWebrtcDatachannelSmoke,
  runWebrtcPeerSmoke,
  sanitizeIceServerUrls,
  summarizeCandidateKinds,
  summarizeRtt,
  webrtcPeerEvaluate,
  writeDiagnosticsFile
};
