'use strict';

const TERMINAL_EVENTS = new Set([
  'turn.completed', 'turn.failed', 'turn.interrupted'
]);
const VISIBLE_EVENTS = new Set([
  'timeline.item.started', 'timeline.item.updated', 'timeline.item.completed',
  'interaction.requested'
]);
const MESSAGE_ITEM_EVENTS = new Set([
  'timeline.item.updated', 'timeline.item.completed'
]);

class ChatRuntimeTraceLifecycle {
  constructor(options) {
    this.traceFactory = options.traceFactory;
    this.traceSink = options.traceSink;
    this.byCommand = new Map();
    this.byRun = new Map();
    this.records = new Set();
  }

  start(attributes = {}) {
    const commandId = text(attributes.commandId);
    const record = new ChatRuntimeTraceRecord(
      this,
      this.traceFactory(attributes),
      commandId
    );
    this.records.add(record);
    if (commandId && !this.byCommand.has(commandId)) {
      this.byCommand.set(commandId, record);
    }
    return record;
  }

  markCommandPersisted(commandId, record) {
    const target = record || this.byCommand.get(text(commandId));
    if (target) target.mark('commandPersisted');
  }

  observePublishedEvent(event = {}) {
    const record = this.byRun.get(text(event.runId));
    if (record) record.observePublishedEvent(event);
  }

  bindRun(record, runId) {
    const id = text(runId);
    if (!id || record.finished) return;
    if (record.runId) this.byRun.delete(record.runId);
    record.runId = id;
    this.byRun.set(id, record);
  }

  finish(record) {
    this.records.delete(record);
    if (this.byCommand.get(record.commandId) === record) {
      this.byCommand.delete(record.commandId);
    }
    if (this.byRun.get(record.runId) === record) this.byRun.delete(record.runId);
    try {
      this.traceSink({ ...record.trace.snapshot(), ...(record.runId ? { runId: record.runId } : {}) });
    } catch (_error) {}
  }

  close() {
    for (const record of [...this.records]) {
      record.finish({ status: 'closed', errorCode: 'chat_runtime_closed' });
    }
  }
}

class ChatRuntimeTraceRecord {
  constructor(lifecycle, trace, commandId) {
    this.lifecycle = lifecycle;
    this.trace = trace;
    this.commandId = commandId;
    this.runId = '';
    this.finished = false;
  }

  mark(stage, details) {
    if (!this.finished) this.trace.mark(stage, details);
  }

  bindRun(runId) {
    this.lifecycle.bindRun(this, runId);
  }

  isRunBound() {
    return Boolean(this.runId);
  }

  observeProviderEvent(event = {}) {
    this.mark('firstProviderEvent', sourceDetails(event));
  }

  observePublishedEvent(event = {}) {
    this.markVisibleEvent(event);
    if (TERMINAL_EVENTS.has(event.type)) {
      const error = event.payload && event.payload.error;
      this.finish({
        status: event.type.replace('turn.', ''),
        ...(error && error.code ? { errorCode: String(error.code) } : {})
      });
    }
  }

  markVisibleEvent(event) {
    if (VISIBLE_EVENTS.has(event.type)) this.mark('firstVisibleItem');
    if (hasAssistantText(event)) this.mark('firstTextDelta');
  }

  finish(details = {}) {
    if (this.finished) return;
    this.trace.mark('completed', details);
    this.finished = true;
    this.lifecycle.finish(this);
  }
}

function hasAssistantText(event = {}) {
  const payload = event.payload || {};
  if (event.type === 'timeline.item.delta') return hasVisibleTextDelta(payload);
  if (!MESSAGE_ITEM_EVENTS.has(event.type)) return false;
  return isAssistantMessage(payload.item);
}

function hasVisibleTextDelta(payload) {
  const detail = payload.detail || {};
  if (detail.channel) return false;
  return Boolean(String(payload.chunk || ''));
}

function isAssistantMessage(value) {
  const item = value || {};
  const detail = item.detail || {};
  return item.kind === 'message'
    && detail.role === 'assistant'
    && Boolean(String(item.content || ''));
}

function sourceDetails(event) {
  const source = event && event.source || {};
  return source.runtimeId ? { runtimeId: String(source.runtimeId) } : {};
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

module.exports = { ChatRuntimeTraceLifecycle };
