const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadDictationSession() {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'composer',
    'dictation-session.js'
  )).href);
}

function createRecognitionClass(startImplementation = () => {}) {
  return class FakeRecognition {
    constructor() {
      FakeRecognition.instance = this;
      this.onstart = null;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
    }

    start() {
      startImplementation();
    }

    stop() {}

    abort() {}
  };
}

test('dictation session never reports recording when recognition start throws', async () => {
  const { beginDictationSession } = await loadDictationSession();
  const events = [];
  const Recognition = createRecognitionClass(() => {
    throw new Error('permission denied');
  });

  const result = beginDictationSession({
    Recognition,
    baseText: '',
    onReady: () => events.push('ready'),
    onStart: () => events.push('started'),
    onTranscript: () => events.push('transcript'),
    onFinish: () => events.push('finished'),
  });

  assert.equal(result, null);
  assert.deepEqual(events, ['ready', 'finished']);
});

test('dictation session starts on the browser event and finishes idempotently', async () => {
  const { beginDictationSession } = await loadDictationSession();
  const events = [];
  const Recognition = createRecognitionClass();
  const recognition = beginDictationSession({
    Recognition,
    baseText: '已有内容',
    onReady: () => events.push('ready'),
    onStart: () => events.push('started'),
    onTranscript: (text) => events.push(text),
    onFinish: () => events.push('finished'),
  });

  recognition.onstart();
  recognition.onresult({
    results: {
      length: 2,
      0: [{ transcript: '新增' }],
      1: [{ transcript: '语音' }],
    },
  });
  recognition.onerror();
  recognition.onend();

  assert.deepEqual(events, ['ready', 'started', '已有内容 新增语音', 'finished']);
});
