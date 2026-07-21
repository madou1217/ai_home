'use strict';

function normalizeSseSequence(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function encodeSseEvent(event) {
  const seq = normalizeSseSequence(event && event.seq);
  const type = String((event && event.type) || 'message').trim() || 'message';
  const id = seq > 0 ? `id: ${seq}\n` : '';
  return `${id}event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function writeSseEvent(res, event) {
  if (!isWritable(res)) return false;
  try {
    return res.write(encodeSseEvent(event));
  } catch (_error) {
    return false;
  }
}

function openSseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

class BoundedSseWriter {
  constructor(res, options = {}) {
    this.res = res;
    this.limit = options.limit;
    this.onOverflow = options.onOverflow || (() => {});
    this.onFailure = options.onFailure || (() => {});
    this.pending = [];
    this.blocked = false;
    this.closed = false;
    this.handleDrain = this.handleDrain.bind(this);
  }

  send(frame) {
    if (this.closed) return false;
    if (!isWritable(this.res)) {
      this.onFailure();
      return false;
    }
    if (this.blocked) return this.enqueue(frame);
    return this.writeFrame(frame);
  }

  enqueue(frame) {
    if (this.pending.length >= this.limit) {
      this.onOverflow();
      return false;
    }
    this.pending.push(frame);
    return true;
  }

  writeFrame(frame) {
    try {
      if (this.res.write(frame) === false) {
        this.blocked = true;
        this.res.once('drain', this.handleDrain);
      }
      return true;
    } catch (error) {
      this.onFailure(error);
      return false;
    }
  }

  handleDrain() {
    if (this.closed) return;
    this.blocked = false;
    while (!this.blocked && this.pending.length > 0) {
      this.writeFrame(this.pending.shift());
    }
  }

  fail(frame) {
    if (this.closed) return;
    this.detach();
    this.closed = true;
    this.pending.length = 0;
    if (!isWritable(this.res)) return;
    try {
      this.res.end(frame);
    } catch (_error) {
      try { this.res.end(); } catch (_endError) {}
    }
  }

  close() {
    if (this.closed) return;
    this.detach();
    this.closed = true;
    this.pending.length = 0;
  }

  detach() {
    if (this.blocked && typeof this.res.removeListener === 'function') {
      this.res.removeListener('drain', this.handleDrain);
    }
    this.blocked = false;
  }
}

function isWritable(res) {
  return Boolean(res && !res.destroyed && !res.writableEnded);
}

module.exports = {
  BoundedSseWriter,
  encodeSseEvent,
  normalizeSseSequence,
  openSseHeaders,
  writeSseEvent
};
