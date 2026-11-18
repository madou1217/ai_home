'use strict';

const { createHash } = require('node:crypto');
const nodePath = require('node:path');
const { writeFileAtomic } = require('../../../runtime/atomic-file-write');
const { PROBE_DELAYS_MS, SUCCESS_COOLDOWN_MS, CLAIM_RESERVATION_MS } = require('./delivery-policy');

function targetKey(party = {}) {
  const text = (value) => String(value == null ? '' : value).trim();
  const delivery = party.delivery || {};
  const suffix = text(delivery.sessionName)
    ? [delivery.cliName, delivery.runtimeScope, delivery.sessionName].map(text).join('\0')
    : text(party.sessionId) || text(party.address) || text(party.name);
  return createHash('sha256').update(`${text(party.channel)}\0${text(party.provider)}\0${suffix}`, 'utf8').digest('hex');
}

function sameParty(left, right) {
  return !!(left && right && targetKey(left) === targetKey(right));
}

function sameSender(left, right) {
  if (!left || !right) return false;
  const normalize = (party) => {
    const result = {};
    for (const field of ['channel', 'provider', 'name', 'address', 'sessionId']) result[field] = String(party[field] || '').trim();
    const delivery = {};
    for (const key of Object.keys(party.delivery || {}).sort()) {
      const value = String(party.delivery[key] || '').trim();
      if (value) delivery[key] = value;
    }
    if (Object.keys(delivery).length) result.delivery = delivery;
    return result;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

// Call all mutations only while holding the shared records lock.
function createTargetGates(fs, root) {
  function read(party) {
    const key = targetKey(party);
    const empty = { v: 1, targetKey: key, busySince: 0, probeCount: 0, nextProbeAt: 0,
      lastReason: '', lastProbeAt: 0, lastDeliveredAt: 0, lastMessageId: '', failureCount: 0 };
    try {
      const file = nodePath.join(root, 'targets', `${key}.json`);
      if (!fs.lstatSync(file).isFile()) throw new Error('invalid_target_gate');
      const value = JSON.parse(fs.readFileSync(nodePath.join(root, 'targets', `${key}.json`), 'utf8'));
      if (!value || value.v !== 1 || value.targetKey !== key) throw new Error('invalid_target_gate');
      for (const field of ['busySince', 'probeCount', 'nextProbeAt', 'lastProbeAt', 'lastDeliveredAt']) {
        if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error('invalid_target_gate');
      }
      if (value.failureCount != null && (!Number.isSafeInteger(value.failureCount) || value.failureCount < 0)) throw new Error('invalid_target_gate');
      return { ...empty, ...value };
    } catch (error) {
      if (error.code === 'ENOENT') return empty;
      throw error;
    }
  }
  function write(party, patch) {
    const gate = { ...read(party), ...patch, v: 1, targetKey: targetKey(party) };
    writeFileAtomic(fs, nodePath.join(root, 'targets', `${gate.targetKey}.json`), `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
    return gate;
  }
  function reserve(party, at, id, leaseMs = CLAIM_RESERVATION_MS) {
    return write(party, { nextProbeAt: at + leaseMs, lastProbeAt: at, lastMessageId: id, lastReason: 'target_inflight' });
  }
  function waiting(party, at, id, reason) {
    const previous = read(party);
    const probeCount = previous.probeCount + 1;
    return write(party, { busySince: previous.busySince || at, probeCount, lastProbeAt: at,
      nextProbeAt: at + PROBE_DELAYS_MS[Math.min(probeCount - 1, PROBE_DELAYS_MS.length - 1)],
      lastReason: reason, lastMessageId: id });
  }
  function delivered(party, at, id) {
    return write(party, { busySince: 0, probeCount: 0, failureCount: 0, nextProbeAt: at + SUCCESS_COOLDOWN_MS,
      lastReason: 'target_cooldown', lastDeliveredAt: at, lastMessageId: id });
  }
  return { read, write, reserve, waiting, delivered };
}

module.exports = { targetKey, sameParty, sameSender, createTargetGates };
