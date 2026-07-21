'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const {
  AIH_MDNS_SERVICE,
  MDNS_ADDRESS,
  MDNS_PORT,
  buildMdnsAnnouncement,
  decodeMdnsPacket,
  packetQueriesName
} = require('./mdns-packet');
const { loadOrCreateServerIdentity } = require('./server-identity');

const ANNOUNCEMENT_TTL_SECONDS = 120;
const ANNOUNCEMENT_INTERVAL_MS = 60_000;

function normalizeLabel(value, fallback) {
  const text = String(value || '').trim()
    .replace(/[^a-zA-Z0-9 _-]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '');
  return (text || fallback).slice(0, 63);
}

function listIpv4Addresses(networkInterfaces) {
  return Object.values(networkInterfaces || {})
    .flatMap((entries) => Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && !entry.internal && (entry.family === 'IPv4' || entry.family === 4))
    .map((entry) => String(entry.address || '').trim())
    .filter(Boolean);
}

function buildAdvertisedMetadata(options, networkInterfaces, ttl = ANNOUNCEMENT_TTL_SECONDS) {
  const serverId = String(options.serverId || '').trim().toLowerCase();
  const name = String(options.name || 'AI Home Server').trim().slice(0, 120) || 'AI Home Server';
  const instanceLabel = normalizeLabel(`${name}-${serverId.slice(-8)}`, 'AI Home Server');
  const targetLabel = normalizeLabel(`aih-${serverId}`, 'aih-server').replace(/\s+/g, '-').toLowerCase();
  const capabilities = Array.from(new Set((Array.isArray(options.capabilities) ? options.capabilities : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)));
  return {
    service: AIH_MDNS_SERVICE,
    instance: `${instanceLabel}.${AIH_MDNS_SERVICE}`,
    target: `${targetLabel}.local`,
    port: Number(options.port) || 0,
    ttl,
    txt: [
      `id=${serverId}`,
      `name=${name}`,
      'version=1',
      `capabilities=${capabilities.join(',')}`
    ],
    addresses: listIpv4Addresses(networkInterfaces)
  };
}

function createServerMdnsAdvertiser(options = {}, deps = {}) {
  const createSocket = deps.createSocket || ((socketOptions) => dgram.createSocket(socketOptions));
  const getNetworkInterfaces = deps.networkInterfaces || os.networkInterfaces;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  const logWarn = deps.logWarn || (() => {});
  let socket = null;
  let interval = null;
  let startPromise = null;
  let active = false;

  function packet(ttl = ANNOUNCEMENT_TTL_SECONDS) {
    return buildMdnsAnnouncement(buildAdvertisedMetadata(options, getNetworkInterfaces(), ttl));
  }

  function send(buffer, port = MDNS_PORT, address = MDNS_ADDRESS) {
    if (!socket || !active) return;
    try {
      socket.send(buffer, port, address, (error) => {
        if (error) logWarn(`mDNS send failed: ${error.message || error}`);
      });
    } catch (error) {
      logWarn(`mDNS send failed: ${error.message || error}`);
    }
  }

  function handleMessage(message, remote) {
    try {
      const query = decodeMdnsPacket(message);
      const metadata = buildAdvertisedMetadata(options, getNetworkInterfaces());
      if (!packetQueriesName(query, [metadata.service, metadata.instance])) return;
      const remotePort = Number(remote && remote.port) || MDNS_PORT;
      const remoteAddress = String(remote && remote.address || MDNS_ADDRESS);
      const direct = remotePort !== MDNS_PORT;
      send(packet(), direct ? remotePort : MDNS_PORT, direct ? remoteAddress : MDNS_ADDRESS);
    } catch (_error) {
      // Other multicast traffic and malformed datagrams are intentionally ignored.
    }
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        socket = createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('message', handleMessage);
        socket.once('error', (error) => {
          logWarn(`mDNS unavailable: ${error.message || error}`);
          active = false;
          finish({ ok: false, reason: 'mdns_socket_error' });
        });
        socket.bind(MDNS_PORT, '0.0.0.0', () => {
          try {
            socket.addMembership(MDNS_ADDRESS);
            socket.setMulticastTTL(255);
            socket.setMulticastLoopback(true);
            active = true;
            send(packet());
            interval = setIntervalImpl(() => send(packet()), ANNOUNCEMENT_INTERVAL_MS);
            if (interval && typeof interval.unref === 'function') interval.unref();
            finish({ ok: true });
          } catch (error) {
            logWarn(`mDNS unavailable: ${error.message || error}`);
            active = false;
            finish({ ok: false, reason: 'mdns_socket_error' });
          }
        });
      } catch (error) {
        logWarn(`mDNS unavailable: ${error.message || error}`);
        finish({ ok: false, reason: 'mdns_socket_error' });
      }
    });
    return startPromise;
  }

  function stop() {
    if (interval) {
      clearIntervalImpl(interval);
      interval = null;
    }
    if (socket) {
      if (active) send(packet(0));
      active = false;
      try { socket.close(); } catch (_error) {}
      socket = null;
    }
  }

  return { start, stop };
}

async function startServerMdnsDiscovery(input = {}, deps = {}) {
  const loadIdentity = deps.loadOrCreateServerIdentity || loadOrCreateServerIdentity;
  const createAdvertiser = deps.createServerMdnsAdvertiser || createServerMdnsAdvertiser;
  const logWarn = deps.logWarn || (() => {});
  let identity = null;
  let advertiser = null;
  try {
    identity = loadIdentity({ fs: input.fs, aiHomeDir: input.aiHomeDir });
    if (input.advertise === false) {
      return {
        identity,
        status: { ok: true, advertised: false, reason: 'loopback_only' },
        stop() {}
      };
    }
    advertiser = createAdvertiser({
      serverId: identity.id,
      name: identity.name,
      port: Number(input.port) || 0,
      capabilities: ['client-api', 'stream', 'blob']
    });
    const status = await advertiser.start();
    return {
      identity,
      status,
      stop: () => advertiser.stop()
    };
  } catch (error) {
    logWarn(`mDNS discovery unavailable: ${error.message || error}`);
    if (advertiser) {
      try { advertiser.stop(); } catch (_stopError) {}
    }
    return {
      identity,
      status: { ok: false, reason: 'mdns_start_failed' },
      stop() {}
    };
  }
}

module.exports = {
  ANNOUNCEMENT_INTERVAL_MS,
  ANNOUNCEMENT_TTL_SECONDS,
  buildAdvertisedMetadata,
  createServerMdnsAdvertiser,
  listIpv4Addresses,
  startServerMdnsDiscovery
};
