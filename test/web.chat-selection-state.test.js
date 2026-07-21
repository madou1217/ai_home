const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadChatSelectionState() {
  const modulePath = pathToFileURL(path.join(
    __dirname,
    '..',
    'web',
    'src',
    'pages',
    'chat-selection-state.js'
  )).href;
  return import(modulePath);
}

test('readSelectionFromSearch parses all persisted chat query params', async () => {
  const { readSelectionFromSearch } = await loadChatSelectionState();

  const result = readSelectionFromSearch('?projectPath=%2Ftmp%2Fdemo&provider=codex&sessionId=s1&projectDirName=p1');

  assert.deepEqual(result, {
    projectPath: '/tmp/demo',
    provider: 'codex',
    sessionId: 's1',
    projectDirName: 'p1'
  });
});

test('readPersistedSelection prefers URL selection over local storage cache', async () => {
  const { readPersistedSelection } = await loadChatSelectionState();

  const storage = {
    getItem() {
      return JSON.stringify({
        projectPath: '/tmp/old',
        provider: 'gemini',
        sessionId: 'cached'
      });
    }
  };

  const result = readPersistedSelection({
    search: '?projectPath=%2Ftmp%2Fnew&provider=codex&sessionId=live&projectDirName=run1',
    localStorage: storage
  });

  assert.deepEqual(result, {
    projectPath: '/tmp/new',
    provider: 'codex',
    sessionId: 'live',
    projectDirName: 'run1'
  });
});

test('writePersistedSelection syncs URL query and local storage payload', async () => {
  const { writePersistedSelection } = await loadChatSelectionState();

  let replacedUrl = '';
  let storedValue = '';
  const history = {
    replaceState(_data, _unused, nextUrl) {
      replacedUrl = String(nextUrl || '');
    }
  };
  const storage = {
    setItem(_key, value) {
      storedValue = value;
    },
    removeItem() {}
  };

  writePersistedSelection({
    projectPath: '/Users/model/projects/shalou',
    provider: 'codex',
    sessionId: '019d7bae',
    projectDirName: 'encoded-project'
  }, {
    location: {
      pathname: '/ui/chat',
      search: '',
      hash: ''
    },
    history,
    localStorage: storage
  });

  assert.equal(
    replacedUrl,
    '/ui/chat?projectPath=%2FUsers%2Fmodel%2Fprojects%2Fshalou&sessionId=019d7bae&provider=codex&projectDirName=encoded-project'
  );
  assert.deepEqual(JSON.parse(storedValue), {
    projectPath: '/Users/model/projects/shalou',
    provider: 'codex',
    sessionId: '019d7bae',
    projectDirName: 'encoded-project'
  });
});

test('writePersistedSelection clears local storage when selection becomes empty', async () => {
  const { writePersistedSelection } = await loadChatSelectionState();

  let removedKey = '';
  const storage = {
    setItem() {},
    removeItem(key) {
      removedKey = key;
    }
  };

  writePersistedSelection({}, {
    location: {
      pathname: '/ui/chat',
      search: '?sessionId=old',
      hash: ''
    },
    history: {
      replaceState() {}
    },
    localStorage: storage
  });

  assert.equal(removedKey, 'web-chat-selection-v1');
});
