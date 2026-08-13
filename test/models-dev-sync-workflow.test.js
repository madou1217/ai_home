'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(
  REPO_ROOT,
  '.github',
  'workflows',
  'models-dev-sync.yml'
);

/** 读取受版本控制的异步同步工作流，避免测试依赖运行时状态。 */
function readWorkflow() {
  return fs.readFileSync(WORKFLOW_PATH, 'utf8');
}

test('models.dev 同步在后台定时执行且不接入运行时请求链', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /cron: '37 \*\/2 \* \* \*'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /server start|aih-server|\/v1\/models/);
});

test('models.dev 同步只在内容变化且验证成功后提交固定产物', () => {
  const workflow = readWorkflow();

  assert.match(workflow, /npm run models:sync/);
  assert.match(workflow, /npm run models:check/);
  assert.match(
    workflow,
    /go test \.\/internal\/adapters\/modelmetadata\/modelsdev \.\/internal\/tools\/modelsdevmodalities/
  );
  assert.match(workflow, /if: steps\.changes\.outputs\.changed == 'true'/);
  assert.match(workflow, /git diff --cached --check/);
  assert.match(workflow, /git push origin HEAD:main/);
});

test('models.dev 普通 CI 检查只校验固定快照而不探测上游', () => {
  const temporaryBin = fs.mkdtempSync(
    path.join(os.tmpdir(), 'aih-models-check-')
  );
  const gitPath = childProcess.execFileSync('which', ['git'], {
    encoding: 'utf8'
  }).trim();
  const wrapperPath = path.join(temporaryBin, 'git');
  fs.writeFileSync(
    wrapperPath,
    '#!/bin/sh\n'
      + 'for argument in "$@"; do\n'
      + '  if [ "$argument" = "fetch" ]; then\n'
      + '    echo "check mode attempted network fetch" >&2\n'
      + '    exit 97\n'
      + '  fi\n'
      + 'done\n'
      + 'exec "$AIH_TEST_REAL_GIT" "$@"\n',
    { mode: 0o755 }
  );

  try {
    const output = childProcess.execFileSync(
      process.execPath,
      ['scripts/sync-models-dev.js', '--check'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          AIH_TEST_REAL_GIT: gitPath,
          PATH: `${temporaryBin}${path.delimiter}${process.env.PATH || ''}`
        }
      }
    );
    assert.match(output, /固定版本与快照一致/);
  } finally {
    fs.rmSync(temporaryBin, { recursive: true, force: true });
  }
});

test('models.dev 自动提交保持最小权限和精确文件范围', () => {
  const workflow = readWorkflow();
  const expectedPath = 'internal/adapters/modelmetadata/modelsdev/modalities.json';

  assert.match(workflow, /permissions:\n  contents: write/);
  assert.doesNotMatch(workflow, /pull-requests: write/);
  assert.doesNotMatch(workflow, /create-pull-request|git push --force/);
  assert.equal((workflow.match(/git add --/g) || []).length, 1);
  assert.match(workflow, /git add -- \\\n            third_party\/models\.dev/);
  assert.ok(workflow.includes(expectedPath));
});
