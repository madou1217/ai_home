'use strict';

// GET /v0/webui/peer/messages：`aih peer` 消息的**只读**可视化数据源。
//
// 背景：peer 消息一直只有 CLI（`aih peer inbox` / `aih peer read`）能看，
// WebUI 里没有任何入口。用户要的是「发了什么、收了什么、回了什么」一屏可见，
// 所以这里直接把 `<aiHome>/run/peer/{pending,inflight,archive}` 的记录摊平成 JSON。
//
// 只读：不 claim、不投递、不改 state —— 读接口绝不能影响补投语义（claim 是 rename，
// 一次误抢就会让真正的投递者拿不到消息）。

const fs = require('node:fs');
const path = require('node:path');
const { createPeerStore, shortMessageId } = require('../cli/services/peer/store');
const { openSseStream, writeSseJson, writeSseComment } = require('./webui-sse-broadcaster');

const MESSAGE_STATES = new Set(['all', 'pending', 'delivered', 'read', 'failed']);
const PEER_WATCH_ROUTE = '/v0/webui/peer/messages/watch';

function normalizeState(value) {
  const state = String(value || '').trim().toLowerCase();
  return MESSAGE_STATES.has(state) ? state : 'all';
}

function describeParty(party) {
  const source = party && typeof party === 'object' ? party : {};
  return {
    channel: String(source.channel || '').trim(),
    provider: String(source.provider || '').trim(),
    name: String(source.name || '').trim(),
    address: String(source.address || '').trim(),
    sessionId: String(source.sessionId || '').trim()
  };
}

function projectMessage(record) {
  return {
    id: String(record.id || ''),
    shortId: shortMessageId(record.id),
    from: describeParty(record.from),
    to: describeParty(record.to),
    replyTo: String(record.replyTo || ''),
    replyToShort: record.replyTo ? shortMessageId(record.replyTo) : '',
    body: String(record.body || ''),
    state: String(record.state || 'pending'),
    createdAt: Number(record.createdAt) || 0,
    deliveredAt: Number(record.deliveredAt) || 0,
    readAt: Number(record.readAt) || 0,
    nextAttemptAt: Number(record.nextAttemptAt) || 0,
    attemptCount: Number(record.attemptCount) || 0,
    error: String(record.error || ''),
    lastAttemptError: (() => {
      const attempts = Array.isArray(record.attempts) ? record.attempts : [];
      const failed = attempts.filter((attempt) => attempt && attempt.ok === false).pop();
      return String(failed && failed.error || '');
    })()
  };
}

function handleWebUiPeerRoutes(ctx) {
  const { method, pathname, res, deps = {} } = ctx;
  if (method !== 'GET' || (pathname !== '/v0/webui/peer/messages' && pathname !== PEER_WATCH_ROUTE)) return false;
  const writeJson = ctx.writeJson || deps.writeJson;
  const aiHomeDir = String(ctx.aiHomeDir || deps.aiHomeDir || '').trim();
  if (!aiHomeDir) {
    writeJson(res, 503, { ok: false, error: 'peer_store_unavailable' });
    return true;
  }
  if (pathname === PEER_WATCH_ROUTE) {
    openSseStream(res);
    let stopWatchers = null;
    const cleanup = () => {
      if (stopWatchers) stopWatchers();
      stopWatchers = null;
    };
    const root = path.join(aiHomeDir, 'run', 'peer');
    const directories = ['pending', 'inflight', 'archive']
      .map((name) => path.join(root, name))
      .filter((directory) => {
        try { return fs.statSync(directory).isDirectory(); } catch (_error) { return false; }
      });
    if (!directories.length) {
      writeSseJson(res, { type: 'peer-unavailable' });
    } else {
      let debounce = null;
      const notify = () => {
        if (debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          writeSseJson(res, { type: 'peer-changed', at: Date.now() });
        }, 120);
      };
      const watchers = directories.map((directory) => {
        try { return fs.watch(directory, { persistent: false }, notify); } catch (_error) { return null; }
      }).filter(Boolean);
      stopWatchers = () => {
        if (debounce) { clearTimeout(debounce); debounce = null; }
        watchers.forEach((watcher) => { try { watcher.close(); } catch (_error) {} });
      };
      writeSseJson(res, { type: 'ready', at: Date.now() });
    }
    const heartbeat = setInterval(() => writeSseComment(res, 'heartbeat'), 30_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    const close = () => { clearInterval(heartbeat); cleanup(); };
    if (typeof res.on === 'function') res.on('close', close);
    if (typeof ctx.req !== 'undefined' && ctx.req && typeof ctx.req.on === 'function') ctx.req.on('close', close);
    return true;
  }

  const url = ctx.url;
  const state = normalizeState(url && url.searchParams && url.searchParams.get('state'));
  const limitRaw = Number(url && url.searchParams && url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 1000) : 500;

  let records = [];
  try {
    const store = createPeerStore({ aiHomeDir });
    records = store.listMessages({ state, limit });
  } catch (_error) {
    writeJson(res, 503, { ok: false, error: 'peer_store_unavailable' });
    return true;
  }

  // 收件箱按「最新在上」：store 的 listMessages 是时间正序（补投按顺序读更自然），
  // 但人看消息要反过来。
  const messages = records.map(projectMessage).reverse();
  const counts = { total: messages.length, pending: 0, delivered: 0, read: 0, failed: 0 };
  for (const message of messages) {
    if (counts[message.state] != null) counts[message.state] += 1;
  }

  writeJson(res, 200, {
    ok: true,
    messages,
    counts,
    store: { state, limit }
  });
  return true;
}

module.exports = { handleWebUiPeerRoutes };
