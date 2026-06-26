'use strict';

function parseJsonData(value) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function parseOpenAISseChunks(rawText) {
  const chunks = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (!data || data === '[DONE]') return;
    const parsed = parseJsonData(data);
    if (parsed) chunks.push(parsed);
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return chunks;
}

function parseAnthropicSseEvents(rawText) {
  const events = [];
  let eventName = '';
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) {
      eventName = '';
      return;
    }
    const data = dataLines.join('\n').trim();
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (!data) return;
    const parsed = parseJsonData(data);
    if (parsed) events.push({ event: name, data: parsed });
  };
  String(rawText || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) {
      flush();
      return;
    }
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  });
  flush();
  return events;
}

module.exports = {
  parseAnthropicSseEvents,
  parseOpenAISseChunks,
  __private: {
    parseJsonData
  }
};
