const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../web/node_modules/typescript');

function loadControlPlaneSelectionModule() {
  const filename = path.join(__dirname, '../web/src/services/control-plane-selection.ts');
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(compiled.outputText, filename);
  return mod.exports;
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

function createStorageEvent(key, oldValue, newValue) {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: key },
    oldValue: { value: oldValue },
    newValue: { value: newValue }
  });
  return event;
}

function createProfile(id, overrides = {}) {
  return {
    id,
    name: id,
    endpoint: `https://${id}.example.com`,
    state: 'discovered',
    authState: 'unpaired',
    deviceToken: '',
    nodeCount: 0,
    accountCount: 0,
    activeAccountCount: 0,
    schedulableAccountCount: 0,
    sessionCount: 0,
    lastDeviceSyncAt: 0,
    lastStatusSyncAt: 0,
    lastAccountsSyncAt: 0,
    lastSessionsSyncAt: 0,
    descriptor: null,
    lastCheckedAt: 0,
    lastError: '',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

test('control plane selection persists and clears active profile id', () => {
  const selection = loadControlPlaneSelectionModule();
  const storage = createStorage();

  assert.equal(selection.getActiveControlPlaneProfileId(storage), '');
  assert.equal(selection.setActiveControlPlaneProfileId('  cp-home  ', storage), 'cp-home');
  assert.equal(selection.getActiveControlPlaneProfileId(storage), 'cp-home');
  selection.clearActiveControlPlaneProfileId(storage);
  assert.equal(selection.getActiveControlPlaneProfileId(storage), '');
});

test('control plane selection prefers stored profile then paired profile then first profile', () => {
  const selection = loadControlPlaneSelectionModule();
  const profiles = [
    createProfile('cp-draft', { state: 'draft' }),
    createProfile('cp-paired', { state: 'paired', authState: 'paired' }),
    createProfile('cp-revoked', { state: 'revoked', authState: 'paired' })
  ];

  assert.deepEqual(
    selection.resolveActiveControlPlaneProfile(profiles, 'cp-draft'),
    {
      profile: profiles[0],
      profileId: 'cp-draft',
      source: 'stored'
    }
  );
  assert.deepEqual(
    selection.resolveActiveControlPlaneProfile(profiles, 'missing'),
    {
      profile: profiles[1],
      profileId: 'cp-paired',
      source: 'paired'
    }
  );
  assert.deepEqual(
    selection.resolveActiveControlPlaneProfile([profiles[0], profiles[2]], 'missing'),
    {
      profile: profiles[0],
      profileId: 'cp-draft',
      source: 'first'
    }
  );
  assert.deepEqual(
    selection.resolveActiveControlPlaneProfile([], 'missing'),
    {
      profile: null,
      profileId: '',
      source: 'none'
    }
  );
});

test('control plane stored selection skips revoked stored profile and falls back to paired server', () => {
  const selection = loadControlPlaneSelectionModule();
  const profiles = [
    createProfile('cp-revoked', { state: 'revoked', authState: 'paired' }),
    createProfile('cp-paired', { state: 'paired', authState: 'paired' }),
    createProfile('cp-draft', { state: 'draft' })
  ];

  assert.deepEqual(
    selection.resolveActiveControlPlaneProfile(profiles, 'cp-revoked'),
    {
      profile: profiles[0],
      profileId: 'cp-revoked',
      source: 'stored'
    }
  );
  assert.deepEqual(
    selection.resolveStoredActiveControlPlaneProfile(profiles, 'cp-revoked'),
    {
      profile: profiles[1],
      profileId: 'cp-paired',
      source: 'paired'
    }
  );
});

test('control plane stored selection sync persists fallback and emits one change event', () => {
  const selection = loadControlPlaneSelectionModule();
  const storage = createStorage();
  const eventTarget = new EventTarget();
  const profiles = [
    createProfile('cp-revoked', { state: 'revoked', authState: 'paired' }),
    createProfile('cp-paired', { state: 'paired', authState: 'paired' })
  ];
  const events = [];
  selection.setActiveControlPlaneProfileId('cp-revoked', storage, eventTarget);
  const unsubscribe = selection.addActiveControlPlaneProfileChangeListener((detail) => {
    events.push(detail);
  }, eventTarget);

  const resolved = selection.syncStoredActiveControlPlaneProfile(profiles, storage, eventTarget);

  unsubscribe();
  assert.equal(resolved.profileId, 'cp-paired');
  assert.equal(resolved.source, 'paired');
  assert.equal(selection.getActiveControlPlaneProfileId(storage), 'cp-paired');
  assert.deepEqual(events, [
    { profileId: 'cp-paired', previousProfileId: 'cp-revoked' }
  ]);
});

test('control plane selection stores chosen profile before resolving', () => {
  const selection = loadControlPlaneSelectionModule();
  const storage = createStorage();
  const profiles = [
    createProfile('cp-home'),
    createProfile('cp-office', { state: 'paired', authState: 'paired' })
  ];

  const resolved = selection.selectActiveControlPlaneProfile(profiles, 'cp-home', storage);

  assert.equal(resolved.profileId, 'cp-home');
  assert.equal(resolved.source, 'stored');
  assert.equal(selection.getActiveControlPlaneProfileId(storage), 'cp-home');
});

test('control plane selection notifies same-window subscribers when active profile changes', () => {
  const selection = loadControlPlaneSelectionModule();
  const storage = createStorage();
  const eventTarget = new EventTarget();
  const events = [];
  const unsubscribe = selection.addActiveControlPlaneProfileChangeListener((detail) => {
    events.push(detail);
  }, eventTarget);

  selection.setActiveControlPlaneProfileId('cp-home', storage, eventTarget);
  selection.setActiveControlPlaneProfileId(' cp-home ', storage, eventTarget);
  selection.setActiveControlPlaneProfileId('cp-office', storage, eventTarget);
  selection.clearActiveControlPlaneProfileId(storage, eventTarget);
  unsubscribe();
  selection.setActiveControlPlaneProfileId('cp-lab', storage, eventTarget);

  assert.deepEqual(events, [
    { profileId: 'cp-home', previousProfileId: '' },
    { profileId: 'cp-office', previousProfileId: 'cp-home' },
    { profileId: '', previousProfileId: 'cp-office' }
  ]);
});

test('control plane selection bridges cross-window storage changes into profile events', () => {
  const selection = loadControlPlaneSelectionModule();
  const eventTarget = new EventTarget();
  const events = [];
  const unsubscribe = selection.addActiveControlPlaneProfileChangeListener((detail) => {
    events.push(detail);
  }, eventTarget);

  eventTarget.dispatchEvent(createStorageEvent('unrelated-key', 'cp-home', 'cp-office'));
  eventTarget.dispatchEvent(createStorageEvent('aih:active-control-plane-profile:v1', 'cp-home', 'cp-office'));
  eventTarget.dispatchEvent(createStorageEvent('aih:active-control-plane-profile:v1', 'cp-office', 'cp-office'));
  eventTarget.dispatchEvent(createStorageEvent('aih:active-control-plane-profile:v1', 'cp-office', null));

  unsubscribe();
  eventTarget.dispatchEvent(createStorageEvent('aih:active-control-plane-profile:v1', '', 'cp-lab'));

  assert.deepEqual(events, [
    { profileId: 'cp-office', previousProfileId: 'cp-home' },
    { profileId: '', previousProfileId: 'cp-office' }
  ]);
});
