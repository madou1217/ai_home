const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 翻译工具是纯 TS 函数（不依赖 React / DOM），直接 transpile 后加载。
// 这样测试跑在 Node 测试套件里，不需要浏览器环境或 web 侧构建。
function loadTranslationUtils() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(__dirname, '..', 'web', 'src', 'features', 'translation', 'translation-utils.ts');
  const source = fs.readFileSync(filePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  const requireFromUtils = (request) => {
    // 纯逻辑模块只允许发生类型导入（编译后被擦除）；出现运行时依赖说明边界被破坏。
    throw new Error(`Unexpected translation utils dependency: ${request}`);
  };
  Function('module', 'exports', 'require', outputText)(
    moduleRef,
    moduleRef.exports,
    requireFromUtils
  );
  return moduleRef.exports;
}

const utils = loadTranslationUtils();

const LANGUAGES = [
  { code: 'zh-Hans', label: '简体中文', english: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'zh-Hant', label: '繁体中文', english: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'en', label: '英语', english: 'English', native: 'English' }
];

const MODELS = [
  {
    id: 'claude-sonnet-4',
    provider: 'claude',
    providerLabel: 'Claude',
    source: 'capability',
    origin: '',
    availableAccountCount: 2
  },
  {
    id: 'gpt-5.4',
    provider: 'codex',
    providerLabel: 'Codex',
    source: 'capability',
    origin: '',
    availableAccountCount: 0
  }
];

test('translation language options put auto first and keep catalog order', () => {
  const options = utils.buildLanguageOptions(LANGUAGES);
  assert.deepEqual(
    options.map((option) => option.value),
    ['auto', 'zh-Hans', 'zh-Hant', 'en']
  );
  assert.equal(options[0].label, '自动检测');
  // 目标语言下拉不需要 auto
  const targetOptions = utils.buildLanguageOptions(LANGUAGES, { includeAuto: false });
  assert.equal(targetOptions.length, 3);
  assert.ok(targetOptions.every((option) => option.value !== 'auto'));
});

test('translation language labels and swap fall back safely', () => {
  assert.equal(utils.languageLabelOf(LANGUAGES, 'auto'), '自动检测');
  assert.equal(utils.languageLabelOf(LANGUAGES, ''), '自动检测');
  assert.equal(utils.languageLabelOf(LANGUAGES, 'en'), '英语');
  assert.equal(utils.languageLabelOf(LANGUAGES, 'ja'), 'ja');

  assert.equal(utils.counterpartLanguage('zh-Hans'), 'zh-Hant');
  assert.equal(utils.counterpartLanguage('zh-Hant'), 'zh-Hans');
  assert.equal(utils.counterpartLanguage('en'), '');

  assert.equal(utils.canSwapLanguages('auto', 'zh-Hans'), false);
  assert.equal(utils.canSwapLanguages('en', 'zh-Hans'), true);
  assert.deepEqual(utils.swapLanguages('en', 'zh-Hans'), { source: 'zh-Hans', target: 'en' });
  // 自动检测时不互换（目标不能变成 auto）
  assert.deepEqual(utils.swapLanguages('auto', 'zh-Hans'), { source: 'auto', target: 'zh-Hans' });
});

test('translation skips only when the effective source already equals the target', () => {
  // 显式源语言：相同即跳过
  assert.equal(utils.isSameTranslationLanguage('en', 'en', ''), true);
  assert.equal(utils.isSameTranslationLanguage('en', 'zh-Hans', ''), false);
  // 自动检测：用检测结果判断；检测未知时不能误判
  assert.equal(utils.isSameTranslationLanguage('auto', 'en', 'en'), true);
  assert.equal(utils.isSameTranslationLanguage('auto', 'zh-Hans', 'en'), false);
  assert.equal(utils.isSameTranslationLanguage('auto', 'en', ''), false);
  // 简体 / 繁体是不同语言，不能因为都叫中文就跳过
  assert.equal(utils.isSameTranslationLanguage('zh-Hans', 'zh-Hant', ''), false);
  assert.equal(utils.resolveEffectiveSourceLanguage('auto', 'ja'), 'ja');
  assert.equal(utils.resolveEffectiveSourceLanguage('fr', 'ja'), 'fr');
});

test('translation model options keep unavailable models visible with an explicit note', () => {
  const options = utils.buildModelOptions(MODELS);
  assert.equal(options.length, 2);
  assert.equal(utils.modelOptionLabel(options[0]), 'claude-sonnet-4 · Claude · 2 个账号');
  assert.match(utils.modelOptionLabel(options[1]), /暂无可用账号/);
  assert.equal(utils.modelOptionLabel({ ...options[0], available: 1 }), 'claude-sonnet-4 · Claude · 1 个账号');
  assert.equal(utils.isModelStillAvailable(MODELS, 'claude-sonnet-4'), true);
  assert.equal(utils.isModelStillAvailable(MODELS, 'gone-model'), false);
  assert.equal(utils.isModelStillAvailable(MODELS, ''), false);
});

test('translation selection falls back to the catalog default when the saved model is gone', () => {
  const auto = { model: 'gpt-5.4', provider: 'codex' };

  const kept = utils.resolveTranslationSelection(
    { model: 'claude-sonnet-4', provider: 'claude' },
    MODELS,
    auto
  );
  assert.deepEqual(kept, { model: 'claude-sonnet-4', provider: 'claude', fallback: false });

  const missing = utils.resolveTranslationSelection({ model: 'retired-model', provider: '' }, MODELS, auto);
  assert.deepEqual(missing, { model: 'gpt-5.4', provider: 'codex', fallback: true });

  const empty = utils.resolveTranslationSelection({ model: '', provider: '' }, MODELS, auto);
  assert.deepEqual(empty, { model: 'gpt-5.4', provider: 'codex', fallback: false });

  const nothing = utils.resolveTranslationSelection(null, MODELS, { model: '', provider: '' });
  assert.deepEqual(nothing, { model: '', provider: '', fallback: false });
});

test('translation input limits count code points and reject blank or oversized text', () => {
  assert.equal(utils.canTranslate('   '), false);
  assert.equal(utils.canTranslate('hello'), true);
  assert.equal(utils.countCharacters('你好'), 2);
  assert.equal(utils.countCharacters('👨‍👩‍👧‍👦'), 7);
  assert.equal(utils.exceedsInputLimit('abc'), false);
  assert.equal(utils.exceedsInputLimit('x'.repeat(utils.MAX_TRANSLATION_INPUT_CHARS + 1)), true);
  assert.deepEqual(utils.splitParagraphs(' a \n\n\n b \n c '), ['a', 'b \n c']);
});

test('translation structure detection flags code, links and lists', () => {
  assert.deepEqual(utils.detectPreservedStructures('plain text'), {
    codeBlock: false,
    inlineCode: false,
    url: false,
    list: false
  });
  const detected = utils.detectPreservedStructures(
    '# 标题\n- 第一项\n\n`code`\n\n```js\nconst a = 1;\n```\n\nhttps://example.com'
  );
  assert.deepEqual(detected, {
    codeBlock: true,
    inlineCode: true,
    url: true,
    list: true
  });
});

test('floating translation only offers itself for real text selections outside editors', () => {
  const base = { selectionText: 'hello world', enabled: true };
  assert.equal(utils.shouldOfferFloatingTranslation(base), true);
  assert.equal(utils.shouldOfferFloatingTranslation({ ...base, enabled: false }), false);
  assert.equal(utils.shouldOfferFloatingTranslation({ ...base, inEditable: true }), false);
  assert.equal(utils.shouldOfferFloatingTranslation({ ...base, shiftKey: true }), false);
  assert.equal(utils.shouldOfferFloatingTranslation({ ...base, selectionText: '   ' }), false);
  assert.equal(utils.shouldOfferFloatingTranslation({ ...base, selectionText: '12345 !!!' }), false);
  assert.equal(
    utils.shouldOfferFloatingTranslation({
      ...base,
      selectionText: 'a'.repeat(utils.MAX_FLOATING_SELECTION_CHARS + 1)
    }),
    false
  );
  assert.equal(
    utils.shouldOfferFloatingTranslation({ ...base, selectionText: '日本語のテキスト' }),
    true
  );
});

test('floating anchor stays inside the viewport and prefers below the selection', () => {
  const viewport = { width: 1200, height: 800 };
  const panel = { width: 380, height: 220 };
  const rect = { left: 500, top: 200, right: 600, bottom: 220, width: 100, height: 20 };

  const preferred = utils.computeFloatingAnchor(rect, viewport, panel);
  assert.equal(preferred.placement, 'below');
  assert.equal(preferred.top, 232);
  assert.equal(preferred.left, 360);

  // 贴着视口底部时翻到上方
  const bottomRect = { left: 500, top: 700, right: 600, bottom: 760, width: 100, height: 20 };
  const flipped = utils.computeFloatingAnchor(bottomRect, viewport, panel);
  assert.equal(flipped.placement, 'above');
  assert.equal(flipped.top, 468);

  // 靠右边缘时被夹回视口内
  const rightRect = { left: 1150, top: 100, right: 1190, bottom: 120, width: 40, height: 20 };
  const clamped = utils.computeFloatingAnchor(rightRect, viewport, panel);
  assert.equal(clamped.left, 1200 - 380 - 12);

  // 小视口：maxLeft 不能小于 margin
  const narrow = utils.computeFloatingAnchor(rect, { width: 200, height: 400 }, panel, 8);
  assert.equal(narrow.left, 8);
  assert.ok(narrow.top >= 8);
});

test('translation shortcut label matches the global handler', () => {
  // ⇧⌘T 被浏览器占用（重新打开标签页），因此用 ⌥⌘T；旧组合仍接受但不展示。
  assert.equal(utils.shortcutLabel(), '⌥⌘T');
  const panelSource = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'features', 'translation', 'TranslationFloatingPanel.tsx'),
    'utf8'
  );
  assert.match(panelSource, /event\.altKey \|\| event\.shiftKey/);
  assert.match(panelSource, /toLowerCase\(\) === 't'/);
  assert.match(panelSource, /data-translation-floating/);
  // 浮层不写回默认值：目标语言只走本地 state
  assert.match(panelSource, /setPanelTarget\(value\)/);
  assert.doesNotMatch(panelSource, /saveTranslationSettings/);
});
