const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadOaiMemParser() {
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'parsers',
    'oai-mem.parser.ts'
  );
  const xmlBlockHelpers = `
function decodeBasicXmlEntities(value) {
  let current = String(value || '');
  for (let index = 0; index < 3; index += 1) {
    const next = current
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    if (next === current) break;
    current = next;
  }
  return current;
}

function parseXmlBlock(options) {
  if (options.inCodeBlock) return null;

  const tagName = String(options.tagName || '').trim();
  if (!tagName) return null;

  const line = decodeBasicXmlEntities(String(options.lines[options.index] || '').trim());
  const singleLinePattern = new RegExp('^<' + tagName + '(?:\\\\s+[^>]*)?>([\\\\s\\\\S]*?)<\\\\/' + tagName + '>$', 'i');
  const singleLineMatch = line.match(singleLinePattern);
  if (singleLineMatch) {
    return {
      consumed: 1,
      value: decodeBasicXmlEntities(singleLineMatch[1]).trim()
    };
  }

  const openPattern = new RegExp('^<' + tagName + '(?:\\\\s+[^>]*)?>$', 'i');
  if (!openPattern.test(line)) return null;

  const tagLines = [];
  let cursor = options.index + 1;
  while (cursor < options.lines.length) {
    const currentLine = decodeBasicXmlEntities(String(options.lines[cursor] || '').trim());
    if (currentLine.toLowerCase() === '</' + tagName.toLowerCase() + '>') {
      return {
        consumed: cursor - options.index + 1,
        value: tagLines.join('\\n').trim()
      };
    }
    tagLines.push(decodeBasicXmlEntities(options.lines[cursor]));
    cursor += 1;
  }

  return null;
}

function buildTagBlock(name, value) {
  return {
    type: 'tag',
    name,
    value
  };
}
`;
  const source = fs.readFileSync(filePath, 'utf8')
    .replace("import type { BlockParser } from './types';", '')
    .replace("import { buildTagBlock, parseXmlBlock } from './xml-block';", '')
    .replace(/export const /g, 'const ')
    .replace(/: BlockParser/g, '')
    .replace(/: string\[\]/g, '')
    .replace(/: number/g, '')
    .replace(/: string/g, '')
    .replace(/\nconst oaiMemParsers = \[oaiMemParser\];\s*$/, '\nreturn { oaiMemParser };');

  return Function(`${xmlBlockHelpers}\n${source}`)().oaiMemParser;
}

function loadMessageStructure() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'message-structure.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8')
    .replace("import type { ChatMessage } from '@/types';", '')
    .replace("import { registeredParsers } from './parsers';", 'const registeredParsers = [];');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  Function('module', 'exports', outputText)(moduleRef, moduleRef.exports);
  return moduleRef.exports;
}

function loadRealMessageStructure() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const sourceRoot = path.join(__dirname, '..', 'web', 'src', 'components', 'chat');
  const moduleCache = new Map();

  const loadTsModule = (relativePath) => {
    let normalizedPath = relativePath.endsWith('.ts') ? relativePath : `${relativePath}.ts`;
    let absolutePath = path.join(sourceRoot, normalizedPath);
    if (!fs.existsSync(absolutePath)) {
      const indexPath = path.join(sourceRoot, relativePath, 'index.ts');
      if (fs.existsSync(indexPath)) {
        normalizedPath = path.join(relativePath, 'index.ts').replace(/\\/g, '/');
        absolutePath = indexPath;
      }
    }
    if (moduleCache.has(absolutePath)) return moduleCache.get(absolutePath).exports;

    const moduleRef = { exports: {} };
    moduleCache.set(absolutePath, moduleRef);

    const source = fs.readFileSync(absolutePath, 'utf8')
      .replace("import type { ChatMessage } from '@/types';", '')
      .replace(/import type \{[^}]+\} from '[^']+';\n/g, '');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020
      }
    });

    const localRequire = (specifier) => {
      if (!specifier.startsWith('.')) return require(specifier);
      const resolved = path.join(path.dirname(normalizedPath), specifier).replace(/\\/g, '/');
      return loadTsModule(resolved);
    };

    Function('require', 'module', 'exports', outputText)(localRequire, moduleRef, moduleRef.exports);
    return moduleRef.exports;
  };

  return loadTsModule('message-structure');
}

function loadProviderBlocks() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'provider-blocks.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === './message-structure') {
      return { parseStructuredChecklist: () => null };
    }
    if (specifier === './UserAnswersBlock') {
      return { parseUserAnswers: () => null };
    }
    return require(specifier);
  };
  Function('require', 'module', 'exports', outputText)(localRequire, moduleRef, moduleRef.exports);
  return moduleRef.exports;
}

function loadMarkdownDetection() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'markdown-detection.ts'
  );
  const source = fs.readFileSync(filePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020
    }
  });
  const moduleRef = { exports: {} };
  Function('module', 'exports', outputText)(moduleRef, moduleRef.exports);
  return moduleRef.exports;
}

test('oai memory parser accepts escaped citation tags from goal context', () => {
  const parser = loadOaiMemParser();
  const lines = [
    '&lt;oai-mem-citation&gt;',
    '&lt;citation_entries&gt;',
    'MEMORY.md:10-12|note=[used memory]',
    '&lt;/citation_entries&gt;',
    '&lt;/oai-mem-citation&gt;'
  ];

  const result = parser.parse({ lines, index: 0, inCodeBlock: false });

  assert.equal(result.consumed, 5);
  assert.deepEqual(result.block, {
    type: 'tag',
    name: 'oai-mem-citation',
    value: '<citation_entries>\nMEMORY.md:10-12|note=[used memory]\n</citation_entries>'
  });
});

test('oai memory parser accepts double-escaped citation tags from goal context', () => {
  const parser = loadOaiMemParser();
  const lines = [
    '&amp;lt;oai-mem-citation&amp;gt;',
    '&amp;lt;citation_entries&amp;gt;',
    'MEMORY.md:20-21|note=[double escaped]',
    '&amp;lt;/citation_entries&amp;gt;',
    '&amp;lt;/oai-mem-citation&amp;gt;'
  ];

  const result = parser.parse({ lines, index: 0, inCodeBlock: false });

  assert.equal(result.consumed, 5);
  assert.equal(result.block.name, 'oai-mem-citation');
  assert.match(result.block.value, /MEMORY\.md:20-21/);
});

test('oai memory parser accepts citation tags with attributes', () => {
  const parser = loadOaiMemParser();
  const lines = [
    '<oai-mem-citation source="goal">',
    '<citation_entries>',
    'rollout_summaries/a.md:1-1|note=[summary]',
    '</citation_entries>',
    '</oai-mem-citation>'
  ];

  const result = parser.parse({ lines, index: 0, inCodeBlock: false });

  assert.equal(result.consumed, 5);
  assert.equal(result.block.name, 'oai-mem-citation');
  assert.match(result.block.value, /rollout_summaries\/a\.md:1-1/);
});

test('structured xml isolation keeps escaped memory citations out of plain goal text', () => {
  const structure = loadMessageStructure();
  const raw = [
    '<goal_context>',
    '<objective>',
    '继续修复',
    '&lt;oai-mem-citation&gt;',
    '&lt;citation_entries&gt;',
    'MEMORY.md:1-2|note=[goal memory]',
    '&lt;/citation_entries&gt;',
    '&lt;/oai-mem-citation&gt;',
    '</objective>',
    '</goal_context>'
  ].join('\n');

  const isolated = structure.isolateStructuredXmlTags(raw);

  assert.doesNotMatch(isolated, /&lt;oai-mem-citation/);
  assert.match(isolated, /<oai-mem-citation>/);
  assert.match(isolated, /MEMORY\.md:1-2/);
});

test('structured xml isolation does not treat a mentioned citation tag as a citation block', () => {
  const structure = loadMessageStructure();
  const raw = [
    '<goal_context>',
    '<objective>',
    '1 &lt;oai-mem-citation&gt; 解析出问题了请修复 [Image #1]',
    '</objective>',
    '</goal_context>'
  ].join('\n');

  const isolated = structure.isolateStructuredXmlTags(raw);

  assert.match(isolated, /1 &lt;oai-mem-citation&gt; 解析出问题了请修复/);
  assert.doesNotMatch(isolated, /\n<oai-mem-citation>/);
});

test('markdown detection recognizes common prose markdown without forcing plain text', () => {
  const { shouldRenderMarkdown } = loadMarkdownDetection();

  assert.equal(shouldRenderMarkdown('普通一句话'), false);
  assert.equal(shouldRenderMarkdown('请看 **重点** 和 `code`'), true);
  assert.equal(shouldRenderMarkdown('- 第一项\n- 第二项'), true);
  assert.equal(shouldRenderMarkdown('```js\nconsole.log(1)\n```'), true);
  assert.equal(shouldRenderMarkdown('[README](/README.md)'), true);
});

test('structured checklist parsing normalizes todo and update_plan shapes', () => {
  const structure = loadMessageStructure();

  const todo = structure.parseStructuredChecklist('TodoWrite', JSON.stringify({
    todos: [
      { content: '统一消息宽度', status: 'completed' },
      { content: '统一 thinking', status: 'active' }
    ]
  }));
  assert.equal(todo.kind, 'todo');
  assert.equal(todo.items[0].status, 'completed');
  assert.equal(todo.items[1].status, 'in_progress');

  const plan = structure.parseStructuredChecklist('update_plan', JSON.stringify({
    explanation: '按组件统一渲染',
    plan: [
      { step: '抽 adapter', status: 'done' },
      { step: '跑 smoke', status: 'waiting_on_user' }
    ]
  }));
  assert.equal(plan.kind, 'plan');
  assert.equal(plan.explanation, '按组件统一渲染');
  assert.deepEqual(plan.items.map((item) => item.status), ['completed', 'blocked']);
});

test('real message parser keeps structured plan tools out of generic tool groups', () => {
  const structure = loadRealMessageStructure();
  const blocks = structure.parseMessageBlocks([
    ':::tool{name="Read"}',
    'package.json',
    ':::',
    '',
    ':::tool{name="update_plan"}',
    JSON.stringify({
      explanation: '统一渲染',
      plan: [{ step: '修正面板布局', status: 'in_progress' }]
    }),
    ':::',
    '',
    ':::tool{name="Terminal"}',
    'npm test',
    ':::'
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_use', 'tool_use']);
  assert.equal(blocks[1].name, 'update_plan');
  assert.equal(structure.parseStructuredChecklist(blocks[1].name, blocks[1].body).kind, 'plan');
});

test('real message parser groups adjacent generic tools only', () => {
  const structure = loadRealMessageStructure();
  const blocks = structure.parseMessageBlocks([
    ':::tool{name="Read"}',
    'a.js',
    ':::',
    '',
    ':::tool{name="Terminal"}',
    'node --test test/a.test.js',
    ':::'
  ].join('\n'));

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool_group');
  assert.deepEqual(blocks[0].items.map((item) => item.name), ['Read', 'Terminal']);
});

test('real message parser keeps adjacent spawn_agent calls as standalone blocks', () => {
  const structure = loadRealMessageStructure();
  const blocks = structure.parseMessageBlocks([
    ':::tool{name="spawn_agent"}',
    JSON.stringify({ task_name: 'review_api', child_session_id: 'child-1' }),
    ':::',
    '',
    ':::tool{name="spawn_agent"}',
    JSON.stringify({ task_name: 'review_ui', child_session_id: 'child-2' }),
    ':::'
  ].join('\n'));

  assert.deepEqual(blocks.map((block) => block.type), ['tool_use', 'tool_use']);
  assert.deepEqual(blocks.map((block) => block.name), ['spawn_agent', 'spawn_agent']);
});

test('provider blocks expose Codex spawn_agent child metadata for lazy loading', () => {
  const { toProviderBlocks } = loadProviderBlocks();
  const [block] = toProviderBlocks([{
    type: 'tool_use',
    name: 'spawn_agent',
    body: JSON.stringify({
      task_name: 'review_code',
      child_session_id: '40000000-0000-4000-8000-000000000002',
      agent_nickname: 'Curie',
      status: 'open',
      created_at: 1,
      updated_at: 2
    })
  }]);

  assert.deepEqual(block, {
    kind: 'subagent',
    description: 'review_code',
    prompt: '',
    childSessionId: '40000000-0000-4000-8000-000000000002',
    agentNickname: 'Curie',
    status: 'open',
    createdAt: 1,
    updatedAt: 2
  });
});

test('real message parser recognizes proposed plan and task notification tags', () => {
  const structure = loadRealMessageStructure();
  const blocks = structure.parseMessageBlocks([
    '<proposed_plan>',
    '1. 统一 thinking',
    '2. 统一 todo',
    '</proposed_plan>',
    '',
    '<task-notification>',
    '<task-id>task-1</task-id>',
    '<status>completed</status>',
    '<summary>已完成</summary>',
    '</task-notification>'
  ].join('\n'));

  assert.equal(blocks[0].type, 'tag');
  assert.equal(blocks[0].name, 'proposed_plan');
  assert.match(blocks[0].value, /统一 thinking/);
  assert.equal(blocks[1].type, 'tag');
  assert.equal(blocks[1].name, 'task-notification');
  assert.match(blocks[1].value, /"taskId":"task-1"/);
});
