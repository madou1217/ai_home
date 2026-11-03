'use strict';

const RAW_ITEM_METHOD = 'rawResponseItem/completed';
const RAW_RESPONSE_METHOD = 'rawResponse/completed';
const ORDERED_KINDS = new Set(['tool', 'shell', 'file_change']);
const RAW_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'tool_search_call',
  'web_search_call',
  'image_generation_call'
]);
const RAW_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'tool_search_output'
]);

// Codex preserves model-order when it commits tool results back to Responses,
// but typed item lifecycle notifications follow actual executor scheduling.
// Raw response items arrive in model order before those executors run. Keep the
// raw payload private and use only its call identity to order the first public
// lifecycle event for each canonical item.
class CodexToolOrderCoordinator {
  constructor() {
    this.calls = new Map();
    this.order = [];
    this.cursor = 0;
    this.outputsBeforeCalls = new Set();
    this.aliases = new Map();
    this.nextSlot = 1;
  }

  accepts(message = {}) {
    return message.id === undefined
      && [RAW_ITEM_METHOD, RAW_RESPONSE_METHOD].includes(String(message.method || ''));
  }

  observe(message, route) {
    if (message.method !== RAW_ITEM_METHOD) return Promise.resolve();
    const item = record(message.params).item;
    const identity = rawToolIdentity(item);
    if (identity.aliases.length === 0) return Promise.resolve();
    if (identity.stage === 'call') this.register(identity.aliases, identity.sourceId);
    else if (identity.stage === 'output') this.noteOutput(identity.aliases);
    return this.drain(route);
  }

  schedule(event, route) {
    const call = this.resolve(canonicalCallId(event));
    if (!call || call.released || call.ambiguous) return route(event);
    const pending = deferred();
    call.events.push({ event, pending });
    // The event-specific promise carries route failures to the caller. The
    // aggregate drain promise is only an internal wake-up and must not become
    // an unhandled rejection when several events are released together.
    this.drain(route).catch(() => {});
    return pending.promise;
  }

  flush(route) {
    for (let index = this.cursor; index < this.order.length; index += 1) {
      const call = this.calls.get(this.order[index]);
      if (call) call.flush = true;
    }
    return this.drain(route);
  }

  // A typed lifecycle can arrive after the response has already been marked
  // terminal. Cleanup must wait for every deferred route, including a sink
  // that rejects, before the driver releases the native binding.
  pending() {
    return [...this.calls.values()].flatMap((call) => call.events.map((queued) => queued.pending.promise));
  }

  register(callId, sourceId = '') {
    const aliases = unique(callId);
    if (aliases.length === 0) return;
    const existing = new Set();
    for (const alias of aliases) {
      const owner = this.aliases.get(alias);
      if (owner && owner !== AMBIGUOUS) existing.add(owner);
    }
    const prior = existing.size === 1 ? [...existing][0] : null;
    const source = text(sourceId);
    const samePrimary = prior && prior.primary === aliases[0];
    const sourceConflict = samePrimary && source && prior.sourceIds.size > 0
      && !prior.sourceIds.has(source);
    if (samePrimary && !sourceConflict && aliases.every((alias) => {
      const owner = this.aliases.get(alias);
      return !owner || owner === prior;
    })) {
      for (const alias of aliases) this.bindAlias(alias, prior);
      if (source) prior.sourceIds.add(source);
      return;
    }

    const call = {
      slot: `tool-${this.nextSlot++}`,
      primary: aliases[0],
      sourceIds: source ? new Set([source]) : new Set(),
      aliases,
      events: [],
      flush: false,
      outputSeen: aliases.some((alias) => this.outputsBeforeCalls.has(alias)),
      ambiguous: false,
      released: false
    };
    this.calls.set(call.slot, call);
    this.order.push(call.slot);
    for (const alias of aliases) this.bindAlias(alias, call);
    for (const alias of aliases) this.outputsBeforeCalls.delete(alias);
  }

  noteOutput(aliases) {
    const identities = unique(aliases);
    for (const alias of identities) {
      const owner = this.aliases.get(alias);
      if (owner && owner !== AMBIGUOUS) owner.outputSeen = true;
      else if (!owner) this.outputsBeforeCalls.add(alias);
    }
  }

  drain(route) {
    const writes = [];
    while (this.cursor < this.order.length) {
      const call = this.calls.get(this.order[this.cursor]);
      if (!call) {
        this.cursor += 1;
        continue;
      }
      if (call.ambiguous) {
        call.released = true;
        this.cursor += 1;
        for (const queued of call.events.splice(0)) {
          let write;
          try {
            write = Promise.resolve(route(queued.event));
          } catch (error) {
            write = Promise.reject(error);
          }
          write.then(queued.pending.resolve, queued.pending.reject);
          writes.push(write);
        }
        continue;
      }
      if (call.events.length === 0 && !call.outputSeen && !call.flush) break;
      call.released = true;
      this.cursor += 1;
      for (const queued of call.events.splice(0)) {
        let write;
        try {
          write = Promise.resolve(route(queued.event));
        } catch (error) {
          write = Promise.reject(error);
        }
        write.then(queued.pending.resolve, queued.pending.reject);
        writes.push(write);
      }
    }
    return Promise.all(writes);
  }

  resolve(alias) {
    const value = text(alias);
    if (!value) return null;
    const owner = this.aliases.get(value);
    return owner && owner !== AMBIGUOUS ? owner : null;
  }

  bindAlias(alias, call) {
    const existing = this.aliases.get(alias);
    if (!existing) {
      this.aliases.set(alias, call);
      return;
    }
    if (existing === call || existing === AMBIGUOUS) {
      if (existing === AMBIGUOUS) call.ambiguous = true;
      return;
    }
    existing.ambiguous = true;
    call.ambiguous = true;
    this.aliases.set(alias, AMBIGUOUS);
  }
}

function rawToolIdentity(input) {
  const item = record(input);
  const type = String(item.type || '');
  if (RAW_CALL_TYPES.has(type)) {
    return { aliases: rawCallAliases(item), sourceId: text(item.id), stage: 'call' };
  }
  if (RAW_OUTPUT_TYPES.has(type)) {
    return { aliases: rawOutputAliases(item), stage: 'output' };
  }
  return { aliases: [], stage: '' };
}

function rawCallAliases(item) {
  const callId = text(item.call_id);
  const itemId = text(item.id);
  if (item.type === 'tool_search_call' && !callId) return [];
  if (['function_call', 'custom_tool_call'].includes(item.type) && !callId) return [];
  const primary = callId || itemId;
  if (!primary) return [];
  return unique([primary, callId, itemId]);
}

function rawOutputAliases(item) {
  const callId = text(item.call_id);
  return callId ? [callId] : [];
}

function canonicalCallId(event = {}) {
  if (!['timeline.item.started', 'timeline.item.updated', 'timeline.item.completed'].includes(event.type)) {
    return '';
  }
  const item = record(record(event.payload).item);
  if (!ORDERED_KINDS.has(item.kind)) return '';
  return text(record(item.detail).callId);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function unique(values) {
  const entries = Array.isArray(values) ? values : [values];
  return [...new Set(entries.map(text).filter(Boolean))];
}

const AMBIGUOUS = Symbol('ambiguous_tool_alias');

module.exports = {
  CodexToolOrderCoordinator,
  RAW_ITEM_METHOD,
  RAW_RESPONSE_METHOD
};
