'use strict';

function createCodexSessionStreamTools(deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const getSessionStoreRoot = deps.getSessionStoreRoot;
  const looksLikeSessionId = deps.looksLikeSessionId;

  if (!fs || !path || typeof getSessionStoreRoot !== 'function' || typeof looksLikeSessionId !== 'function') {
    throw new Error('createCodexSessionStreamTools requires fs/path/getSessionStoreRoot/looksLikeSessionId.');
  }

  function toSessionEpochMs(ts) {
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) return ts > 1e12 ? ts : ts * 1000;
    if (typeof ts === 'string') {
      const n = Number(ts);
      if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
      const parsed = Date.parse(ts);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  function formatSessionTs(ts) {
    const ms = toSessionEpochMs(ts);
    if (!ms) return '';
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
  }

  function printSessionEvent(event, raw = false) {
    if (!event) return;
    if (raw) {
      if (event.rawLine) console.log(event.rawLine);
      return;
    }
    const text = String(event.text || '').trim();
    if (!text) return;
    const tsLabel = formatSessionTs(event.ts);
    const role = String(event.role || '').trim().toLowerCase();
    const roleLabel = role ? `${role}: ` : '';
    if (tsLabel) console.log(`[${tsLabel}] ${roleLabel}${text}`);
    else console.log(`${roleLabel}${text}`);
  }

  function parseSessionHistoryOptions(argv) {
    const options = { once: false, raw: false, limit: 80, selfOnly: false, timeoutSec: 0 };
    const arr = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < arr.length; i++) {
      const cur = String(arr[i] || '').trim();
      if (!cur) continue;
      if (cur === '--once' || cur === '--no-follow') {
        options.once = true;
        continue;
      }
      if (cur === '--raw' || cur === '--json') {
        options.raw = true;
        continue;
      }
      if (cur === '--self-only' || cur === '--strict') {
        options.selfOnly = true;
        continue;
      }
      if ((cur === '--limit' || cur === '-n') && i + 1 < arr.length && /^\d+$/.test(String(arr[i + 1] || ''))) {
        options.limit = Math.max(1, Number(arr[i + 1]));
        i += 1;
        continue;
      }
      if (cur.startsWith('--limit=')) {
        const v = cur.slice('--limit='.length);
        if (/^\d+$/.test(v)) options.limit = Math.max(1, Number(v));
      }
      if ((cur === '--timeout' || cur === '--timeout-sec') && i + 1 < arr.length && /^\d+$/.test(String(arr[i + 1] || ''))) {
        options.timeoutSec = Math.max(0, Number(arr[i + 1]));
        i += 1;
        continue;
      }
      if (cur.startsWith('--timeout=')) {
        const v = cur.slice('--timeout='.length);
        if (/^\d+$/.test(v)) options.timeoutSec = Math.max(0, Number(v));
      }
    }
    return options;
  }

  function extractSessionIdsFromText(text) {
    const t = String(text || '');
    const m = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) || [];
    return Array.from(new Set(m.map((x) => x.toLowerCase())));
  }

  function parseHistorySessionLine(line, sid) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (String(parsed.session_id || '').trim() !== sid) return [];
      const text = String(parsed.text || '').trim();
      if (!text) return [];
      return [{
        source: 'history',
        ts: parsed.ts,
        role: 'user',
        text,
        rawLine: JSON.stringify(parsed),
        key: `h|${String(parsed.ts || '')}|${text}`
      }];
    } catch (e) {
      return [];
    }
  }

  function parseCodexSessionLogLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return [];
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return [];
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const out = [];
    const topType = String(parsed.type || '').trim();
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : null;
    const ts = parsed.timestamp || '';

    if (topType === 'response_item' && payload && String(payload.type || '') === 'message') {
      const role = String(payload.role || 'assistant').trim().toLowerCase() || 'assistant';
      const content = Array.isArray(payload.content) ? payload.content : [];
      content.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const text = String(item.text || '').trim();
        if (!text) return;
        out.push({
          source: 'session_log',
          ts,
          role,
          text,
          rawLine: trimmed,
          key: `s|msg|${String(ts)}|${role}|${idx}|${text}`
        });
      });
      return out;
    }

    if (topType === 'event_msg' && payload && String(payload.type || '') === 'agent_message') {
      const text = String(payload.message || '').trim();
      if (!text) return [];
      const phase = String(payload.phase || '').trim().toLowerCase();
      out.push({
        source: 'session_log',
        ts,
        role: 'assistant',
        text,
        rawLine: trimmed,
        key: `s|agent|${String(ts)}|${phase}|${text}`
      });
      return out;
    }
    return [];
  }

  function findCodexSessionLogFiles(sessionId) {
    const sid = String(sessionId || '').trim();
    const sessionsRoot = path.join(getSessionStoreRoot('codex'), 'sessions');
    if (!sid || !fs.existsSync(sessionsRoot)) return [];
    const out = [];
    const stack = [sessionsRoot];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        continue;
      }
      entries.forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          return;
        }
        if (!entry.isFile()) return;
        if (!entry.name.endsWith('.jsonl')) return;
        if (!entry.name.includes(sid)) return;
        out.push(full);
      });
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  function showCodexSessionStream(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!looksLikeSessionId(sid)) {
      console.error('\x1b[31m[aih] Invalid session_id. Usage: aih codex session <session_id> [--once] [--limit N] [--raw]\x1b[0m');
      process.exit(1);
    }
    const opts = {
      once: options.once === true,
      raw: options.raw === true,
      limit: Math.max(1, Number(options.limit) || 80),
      selfOnly: options.selfOnly === true,
      timeoutSec: Math.max(0, Number(options.timeoutSec) || 0)
    };
    const historyPath = path.join(getSessionStoreRoot('codex'), 'history.jsonl');
    const sessionLogFiles = findCodexSessionLogFiles(sid);
    const bootstrapEvents = [];

    if (fs.existsSync(historyPath)) {
      try {
        const content = fs.readFileSync(historyPath, 'utf8');
        content.split('\n').forEach((line) => {
          parseHistorySessionLine(line, sid).forEach((ev) => bootstrapEvents.push(ev));
        });
      } catch (e) {}
    }

    sessionLogFiles.forEach((filePath) => {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        content.split('\n').forEach((line) => {
          parseCodexSessionLogLine(line).forEach((ev) => bootstrapEvents.push(ev));
        });
      } catch (e) {}
    });

    bootstrapEvents.sort((a, b) => {
      const ta = toSessionEpochMs(a.ts);
      const tb = toSessionEpochMs(b.ts);
      if (ta !== tb) return ta - tb;
      return String(a.key || '').localeCompare(String(b.key || ''));
    });
    const seen = new Set();
    const seenKeyFor = (event) => {
      if (opts.raw) return String(event.key || '');
      return `${formatSessionTs(event.ts)}|${String(event.text || '').trim()}`;
    };
    const passSelfOnly = (event) => {
      if (!opts.selfOnly) return true;
      const ids = extractSessionIdsFromText(event && event.text);
      if (ids.length === 0) return true;
      return ids.every((id) => id === sid.toLowerCase());
    };
    const bootSlice = bootstrapEvents.slice(-opts.limit);
    if (bootSlice.length === 0) {
      console.log(`\x1b[90m[aih]\x1b[0m No message events found for session ${sid}.`);
    } else if (!opts.raw) {
      console.log(`\x1b[36m[aih]\x1b[0m session ${sid} stream (${bootSlice.length}/${bootstrapEvents.length})`);
    }
    bootSlice.forEach((event) => {
      if (!passSelfOnly(event)) return;
      const k = seenKeyFor(event);
      if (!k || seen.has(k)) return;
      seen.add(k);
      printSessionEvent(event, opts.raw);
    });
    if (opts.once) return;

    let historyCursor = 0;
    let historyPending = '';
    try {
      historyCursor = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;
    } catch (e) {
      historyCursor = 0;
    }

    const sessionStates = new Map();
    sessionLogFiles.forEach((filePath) => {
      try {
        const size = fs.statSync(filePath).size;
        sessionStates.set(filePath, { cursor: size, pending: '' });
      } catch (e) {
        sessionStates.set(filePath, { cursor: 0, pending: '' });
      }
    });

    if (!opts.raw) {
      const timeoutText = opts.timeoutSec > 0 ? `, timeout=${opts.timeoutSec}s` : '';
      const filterText = opts.selfOnly ? ', self-only=true' : '';
      console.log(`\x1b[90m[aih]\x1b[0m Following session stream for ${sid}${timeoutText}${filterText} ... (Ctrl+C to stop)`);
    }

    const emitEvents = (events) => {
      events.forEach((event) => {
        if (!event || !event.key) return;
        if (!passSelfOnly(event)) return;
        const k = seenKeyFor(event);
        if (!k || seen.has(k)) return;
        seen.add(k);
        printSessionEvent(event, opts.raw);
      });
    };

    const readDelta = (filePath, state, parseLineToEvents) => {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch (e) {
        return state;
      }
      if (!stat || !Number.isFinite(stat.size)) return;
      let cursor = Number(state.cursor) || 0;
      let pending = String(state.pending || '');
      if (stat.size < cursor) {
        cursor = 0;
        pending = '';
      }
      if (stat.size === cursor) return;
      const chunkSize = stat.size - cursor;
      if (chunkSize <= 0) return { cursor, pending };
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(chunkSize);
        fs.readSync(fd, buf, 0, chunkSize, cursor);
        cursor = stat.size;
        const merged = String(pending || '') + buf.toString('utf8');
        const lines = merged.split('\n');
        pending = lines.pop() || '';
        const events = [];
        lines.forEach((line) => {
          parseLineToEvents(line).forEach((ev) => events.push(ev));
        });
        emitEvents(events);
      } finally {
        fs.closeSync(fd);
      }
      return { cursor, pending };
    };

    let scanTick = 0;
    const pump = () => {
      if (fs.existsSync(historyPath)) {
        const next = readDelta(historyPath, { cursor: historyCursor, pending: historyPending }, (line) => parseHistorySessionLine(line, sid));
        if (next) {
          historyCursor = Number(next.cursor) || 0;
          historyPending = String(next.pending || '');
        }
      }

      scanTick += 1;
      if (scanTick % 5 === 0) {
        const latestFiles = findCodexSessionLogFiles(sid);
        latestFiles.forEach((filePath) => {
          if (sessionStates.has(filePath)) return;
          sessionStates.set(filePath, { cursor: 0, pending: '' });
        });
      }

      Array.from(sessionStates.entries()).forEach(([filePath, state]) => {
        const next = readDelta(filePath, state, parseCodexSessionLogLine);
        if (next) sessionStates.set(filePath, next);
      });
    };

    const timer = setInterval(pump, 1000);
    let timeoutTimer = null;
    if (opts.timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        clearInterval(timer);
        process.exit(0);
      }, opts.timeoutSec * 1000);
    }
    process.on('SIGINT', () => {
      clearInterval(timer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      process.exit(0);
    });
  }

  return {
    parseSessionHistoryOptions,
    showCodexSessionStream
  };
}

module.exports = {
  createCodexSessionStreamTools
};
