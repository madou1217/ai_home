const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadSubagentThreadState() {
  const filePath = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'components',
    'chat',
    'subagent-thread-state.ts'
  );
  assert.equal(fs.existsSync(filePath), true, 'subagent thread state module should exist');
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
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

test('subagent transcript loads only after the first expansion', () => {
  const { shouldLoadSubagentTranscript } = loadSubagentThreadState();

  assert.equal(shouldLoadSubagentTranscript(false, 'idle'), false);
  assert.equal(shouldLoadSubagentTranscript(true, 'idle'), true);
  assert.equal(shouldLoadSubagentTranscript(true, 'loading'), false);
  assert.equal(shouldLoadSubagentTranscript(true, 'loaded'), false);
  assert.equal(shouldLoadSubagentTranscript(true, 'error'), false);
});

test('subagent card exposes deterministic task and loading status', () => {
  const { getSubagentStatusPresentation } = loadSubagentThreadState();

  assert.deepEqual(getSubagentStatusPresentation('open', 'idle'), {
    label: '可查看',
    tone: 'neutral',
    dot: false
  });
  assert.deepEqual(getSubagentStatusPresentation('open', 'loading'), {
    label: '加载中',
    tone: 'running',
    dot: true
  });
  assert.deepEqual(getSubagentStatusPresentation('open', 'loaded'), {
    label: '已加载',
    tone: 'success',
    dot: false
  });
  assert.deepEqual(getSubagentStatusPresentation('failed', 'idle'), {
    label: '失败',
    tone: 'failed',
    dot: false
  });
  assert.deepEqual(getSubagentStatusPresentation('interrupted', 'idle'), {
    label: '已中断',
    tone: 'attention',
    dot: false
  });
});

test('subagent invocation without a child thread distinguishes spawn failure from running state', () => {
  const { getSubagentResultStatusPresentation } = loadSubagentThreadState();

  assert.deepEqual(
    getSubagentResultStatusPresentation('collab spawn failed: agent thread limit reached'),
    { label: '未创建', tone: 'failed', dot: false }
  );
  assert.deepEqual(
    getSubagentResultStatusPresentation(''),
    { label: '运行中', tone: 'running', dot: true }
  );
  assert.deepEqual(
    getSubagentResultStatusPresentation('任务被中断，无产出'),
    { label: '中断/运行中', tone: 'attention', dot: true }
  );
  assert.deepEqual(
    getSubagentResultStatusPresentation('审查完成'),
    { label: '已完成', tone: 'success', dot: false }
  );
});
