'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  canonicalizeProviderResourcePath,
  canonicalizeProviderResourceText,
  canonicalizeProviderResourceValue,
  resolveProviderResourcePath
} = require('../lib/runtime/provider-resource-path');
const {
  resolveProviderAttachmentRoot,
  resolveProviderNativeRoot,
  resolveProviderRuntimeHomeRoot
} = require('../lib/runtime/provider-storage-policy');
const {
  persistChatImages,
  resolveChatAttachmentPath
} = require('../lib/server/chat-attachments');

const hostHomeDir = path.join(path.parse(process.cwd()).root, 'Users', 'tester');
const aiHomeDir = path.join(hostHomeDir, '.ai_home');
const accountRef = 'acct_0123456789abcdef0123';

const providerCases = [
  ['codex', ['.codex'], ['sessions', 'rollout.jsonl']],
  ['claude', ['.claude'], ['projects', 'session.jsonl']],
  ['gemini', ['.gemini'], ['tmp', 'artifact.png']],
  ['agy', ['.gemini', 'antigravity-cli'], ['brain', 'session-id', 'artifact.md']],
  ['opencode', ['.local', 'share', 'opencode'], ['storage', 'session.json']]
];

test('provider resource aliases resolve to one account-independent native root', () => {
  providerCases.forEach(([provider, projectionRoot, resourceTail]) => {
    const currentPath = path.join(
      aiHomeDir,
      'run',
      'auth-projections',
      provider,
      accountRef,
      ...projectionRoot,
      ...resourceTail
    );
    const legacyPath = path.join(
      aiHomeDir,
      'profiles',
      provider,
      '7',
      ...projectionRoot,
      ...resourceTail
    );
    const expectedPath = path.join(hostHomeDir, ...projectionRoot, ...resourceTail);

    assert.equal(canonicalizeProviderResourcePath(currentPath, { aiHomeDir, hostHomeDir }), expectedPath);
    assert.equal(canonicalizeProviderResourcePath(legacyPath, { aiHomeDir, hostHomeDir }), expectedPath);
    assert.equal(expectedPath.includes('.ai_home'), false);
  });
});

test('opencode bridge data aliases resolve to the native opencode data root', () => {
  const projected = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    'opencode',
    accountRef,
    '.local',
    'share',
    'aih-opencode-runtime',
    'opencode',
    'storage',
    'message.json'
  );
  assert.equal(
    canonicalizeProviderResourcePath(projected, { aiHomeDir, hostHomeDir }),
    path.join(hostHomeDir, '.local', 'share', 'opencode', 'storage', 'message.json')
  );
});

test('AGY fake-home resources canonicalize to the provider-native runtime home', () => {
  const projected = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    'agy',
    accountRef,
    'Library',
    'Caches',
    'ms-playwright-go',
    'version.txt'
  );
  assert.equal(
    canonicalizeProviderResourcePath(projected, { aiHomeDir, hostHomeDir }),
    path.join(
      hostHomeDir,
      '.gemini',
      'antigravity-cli',
      '.aih-runtime-home',
      'Library',
      'Caches',
      'ms-playwright-go',
      'version.txt'
    )
  );
});

test('legacy AGY XDG paths canonicalize to the directories used by the new runtime', () => {
  const cases = [
    [['.local', 'share', 'agy', 'state.json'], ['xdg', 'data', 'agy', 'state.json']],
    [['.local', 'state', 'agy', 'state.json'], ['xdg', 'state', 'agy', 'state.json']],
    [['.config', 'agy', 'settings.json'], ['xdg', 'config', 'agy', 'settings.json']],
    [['.cache', 'agy', 'cache.bin'], ['xdg', 'cache', 'agy', 'cache.bin']]
  ];

  cases.forEach(([projectedTail, nativeTail]) => {
    const projected = path.join(
      aiHomeDir,
      'run',
      'auth-projections',
      'agy',
      accountRef,
      ...projectedTail
    );
    assert.equal(
      canonicalizeProviderResourcePath(projected, { aiHomeDir, hostHomeDir }),
      path.join(resolveProviderRuntimeHomeRoot(hostHomeDir, 'agy'), ...nativeTail)
    );
  });
});

test('unknown fake-home entries canonicalize under each provider native directory', () => {
  providerCases.forEach(([provider]) => {
    const projected = path.join(
      aiHomeDir,
      'run',
      'auth-projections',
      provider,
      accountRef,
      'unknown-provider-state',
      'artifact.bin'
    );
    assert.equal(
      canonicalizeProviderResourcePath(projected, { aiHomeDir, hostHomeDir }),
      path.join(
        resolveProviderRuntimeHomeRoot(hostHomeDir, provider),
        ...(provider === 'agy' ? ['home'] : []),
        'unknown-provider-state',
        'artifact.bin'
      )
    );
  });
});

test('account-private artifacts never canonicalize from an account projection', () => {
  const cases = [
    ['codex', ['.codex', 'auth.json']],
    ['codex', ['.codex', 'config.toml']],
    ['claude', ['.claude', '.credentials.json']],
    ['gemini', ['.gemini', 'oauth_creds.json']],
    ['gemini', ['.gemini', 'google_accounts.json']],
    ['agy', ['.gemini', 'antigravity-cli', 'antigravity-oauth-token']],
    ['agy', ['.gemini', 'antigravity-cli', 'email.cache']],
    ['agy', ['Library', 'Keychains', 'account.keychain-db']],
    ['opencode', ['.local', 'share', 'opencode', 'auth.json']],
    ['opencode', ['.local', 'share', 'aih-opencode-runtime', 'opencode', 'auth.json']],
    ['opencode', ['.config', 'opencode', 'auth.json.backup']]
  ];

  cases.forEach(([provider, artifactPath]) => {
    const projected = path.join(
      aiHomeDir,
      'run',
      'auth-projections',
      provider,
      accountRef,
      ...artifactPath
    );
    const result = resolveProviderResourcePath(projected, { aiHomeDir, hostHomeDir });
    assert.equal(result.blocked, true, projected);
    assert.equal(result.canonicalized, false, projected);
    assert.equal(result.path, projected);
  });
});

test('session text and nested message values canonicalize legacy and current resource paths', () => {
  const legacy = path.join(
    aiHomeDir,
    'profiles',
    'agy',
    '1',
    '.gemini',
    'antigravity-cli',
    'brain',
    'session-id',
    'artifact.md'
  );
  const current = path.join(
    aiHomeDir,
    'run',
    'auth-projections',
    'agy',
    accountRef,
    '.gemini',
    'antigravity-cli',
    'brain',
    'session-id',
    'image.jpg'
  );
  const secret = path.join(
    aiHomeDir,
    'profiles',
    'agy',
    '1',
    '.gemini',
    'antigravity-cli',
    'antigravity-oauth-token'
  );
  const expectedRoot = path.join(hostHomeDir, '.gemini', 'antigravity-cli');
  const source = `open [artifact](file://${legacy}) then ${current}; keep ${secret}`;

  const text = canonicalizeProviderResourceText(source, {
    provider: 'agy',
    aiHomeDir,
    hostHomeDir
  });
  const expectedArtifact = path.join(expectedRoot, 'brain', 'session-id', 'artifact.md');
  const expectedImage = path.join(expectedRoot, 'brain', 'session-id', 'image.jpg');
  assert.equal(text.includes(expectedArtifact), true);
  assert.equal(text.includes(expectedImage), true);
  assert.equal(text.includes(path.join(aiHomeDir, 'profiles', 'agy', '1', '.gemini', 'antigravity-cli', 'brain')), false);
  assert.equal(text.includes(path.join(aiHomeDir, 'run', 'auth-projections', 'agy')), false);
  assert.equal(text.includes(secret), true);
  const wrappedSecret = `${secret}); next`;
  assert.equal(canonicalizeProviderResourceText(wrappedSecret, {
    provider: 'agy',
    aiHomeDir,
    hostHomeDir
  }), wrappedSecret);

  const messages = canonicalizeProviderResourceValue([
    { role: 'assistant', content: source, meta: { outputFile: current } }
  ], {
    provider: 'agy',
    aiHomeDir,
    hostHomeDir
  });
  assert.equal(messages[0].meta.outputFile, path.join(expectedRoot, 'brain', 'session-id', 'image.jpg'));
});

test('provider attachment roots are native and account-independent', () => {
  providerCases.forEach(([provider]) => {
    const nativeRoot = resolveProviderNativeRoot(hostHomeDir, provider);
    const attachmentRoot = resolveProviderAttachmentRoot(hostHomeDir, provider);
    assert.equal(nativeRoot.startsWith(hostHomeDir), true);
    assert.equal(attachmentRoot.startsWith(nativeRoot), true);
    assert.equal(attachmentRoot.includes('.ai_home'), false);
    assert.equal(attachmentRoot.includes(accountRef), false);
  });
});

test('chat image persistence writes every provider directly to its native root', (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-attachments-'));
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const dataUrl = `data:image/png;base64,${Buffer.from('provider-image').toString('base64')}`;

  providerCases.forEach(([provider]) => {
    const [filePath] = persistChatImages([dataUrl], {
      fs,
      provider,
      hostHomeDir: temporaryHome,
      aiHomeDir: path.join(temporaryHome, '.ai_home')
    });
    const expectedRoot = resolveProviderAttachmentRoot(temporaryHome, provider);
    assert.equal(filePath.startsWith(`${expectedRoot}${path.sep}`), true, filePath);
    assert.equal(filePath.includes('.ai_home'), false, filePath);
    assert.equal(resolveChatAttachmentPath(filePath, {
      fs,
      hostHomeDir: temporaryHome,
      aiHomeDir: path.join(temporaryHome, '.ai_home')
    }), fs.realpathSync(filePath));
  });
});

test('chat attachment aliases survive account switch and deletion', (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-attachment-alias-'));
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const temporaryAiHome = path.join(temporaryHome, '.ai_home');
  const sessionId = '287e94b0-5944-4d05-a614-d906797222dc';
  const nativePath = path.join(
    temporaryHome,
    '.gemini',
    'antigravity-cli',
    'brain',
    sessionId,
    'phoenix_concert_1.jpg'
  );
  const aliases = [
    path.join(
      temporaryAiHome,
      'profiles',
      'agy',
      '1',
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      'phoenix_concert_1.jpg'
    ),
    path.join(
      temporaryAiHome,
      'run',
      'auth-projections',
      'agy',
      accountRef,
      '.gemini',
      'antigravity-cli',
      'brain',
      sessionId,
      'phoenix_concert_1.jpg'
    )
  ];
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.writeFileSync(nativePath, 'image', 'utf8');

  aliases.forEach((aliasPath) => {
    assert.equal(resolveChatAttachmentPath(aliasPath, {
      fs,
      hostHomeDir: temporaryHome,
      aiHomeDir: temporaryAiHome
    }), fs.realpathSync(nativePath));
  });
  assert.equal(fs.existsSync(path.join(temporaryAiHome, 'profiles')), false);
  assert.equal(fs.existsSync(path.join(temporaryAiHome, 'run', 'auth-projections')), false);
});

test('chat attachment resolution rejects symlinks escaping provider roots', (t) => {
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-provider-attachment-escape-'));
  t.after(() => fs.rmSync(temporaryHome, { recursive: true, force: true }));
  const attachmentRoot = resolveProviderAttachmentRoot(temporaryHome, 'agy');
  const outsideFile = path.join(temporaryHome, 'outside.jpg');
  const linkPath = path.join(attachmentRoot, 'leak.jpg');
  fs.mkdirSync(attachmentRoot, { recursive: true });
  fs.writeFileSync(outsideFile, 'outside', 'utf8');
  fs.symlinkSync(outsideFile, linkPath);

  assert.throws(() => resolveChatAttachmentPath(linkPath, {
    fs,
    hostHomeDir: temporaryHome,
    aiHomeDir: path.join(temporaryHome, '.ai_home')
  }), /chat_attachment_not_found/);
});
