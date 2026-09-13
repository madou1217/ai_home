'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { ChatRuntimeError } = require('./contracts');
const { CodexUserMessageLink } = require('./codex-user-message-link');

// Positive disk evidence for threads resumed/forked without raw notifications.
// Read only a verified account's exact native thread, bounded by persisted
// task_started/task_complete records. Never use a typed summary as raw history.
async function readCodexRolloutTurn({ codexHome, runtimeHomeHash, rolloutPath, threadId, turnId }) {
  const home = await fs.promises.realpath(codexHome);
  const identityPath = process.platform === 'win32' ? home.toLowerCase() : home;
  if (crypto.createHash('sha256').update(identityPath).digest('hex') !== runtimeHomeHash) throw unavailable();
  const real = await fs.promises.realpath(rolloutPath);
  if ((await fs.promises.lstat(rolloutPath)).isSymbolicLink()) throw unavailable();
  const relative = path.relative(home, real).split(path.sep);
  if (!['sessions', 'archived_sessions'].includes(relative[0]) || relative.includes('..')
    || !relative.at(-1).endsWith(`-${threadId}.jsonl`)) throw unavailable();
  let current = home;
  for (const part of relative) {
    current = path.join(current, part);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) throw unavailable();
  }
  let handle;
  let lines;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size) throw unavailable();
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, stat.size - 1);
    if (last[0] !== 10) throw unavailable();
    lines = readline.createInterface({ input: handle.createReadStream({ autoClose: false, end: stat.size - 1 }), crlfDelay: Infinity });
    let header = true;
    let started = false;
    let completed = false;
    const items = [];
    const ids = new Set();
    const links = new Map();
    const mapper = new CodexUserMessageLink();
    for await (const line of lines) {
      const record = JSON.parse(line);
      const payload = record.payload;
      if (header) {
        header = false;
        if (record.type !== 'session_meta' || payload.id !== threadId) throw unavailable();
        continue;
      }
      if (record.type === 'event_msg' && payload.type === 'thread_rolled_back') throw unavailable();
      if (record.type === 'event_msg' && payload.type === 'task_started' && payload.turn_id === turnId) {
        if (started) throw unavailable();
        started = true;
        continue;
      }
      if (!started || completed) continue;
      if (record.type === 'event_msg' && payload.type === 'task_started') throw unavailable();
      if (record.type === 'event_msg' && payload.type === 'task_complete' && payload.turn_id === turnId) {
        completed = true;
        continue;
      }
      if (record.type === 'compacted') throw unavailable();
      if (record.type === 'response_item') {
        if (!payload.id || ids.has(payload.id)) throw unavailable();
        ids.add(payload.id);
        items.push(payload);
        mapper.observe({ method: 'rawResponseItem/completed', params: { threadId, turnId, item: payload } });
      } else if (record.type === 'event_msg' && payload.type === 'item_completed'
        && payload.turn_id === turnId && payload.item?.type === 'UserMessage') {
        const rawMessageId = mapper.observe({ method: 'item/started', params: {
          threadId, turnId, item: { ...payload.item, type: 'userMessage' }
        } });
        if (rawMessageId) links.set(payload.item.id, rawMessageId);
      }
    }
    if (!started || !completed || !items.length) throw unavailable();
    return { items, links };
  } catch (_error) { throw unavailable(); }
  finally { lines?.close(); await handle?.close(); }
}

function unavailable() { return new ChatRuntimeError('codex_rollout_turn_evidence_unavailable', 409); }
module.exports = { readCodexRolloutTurn };
