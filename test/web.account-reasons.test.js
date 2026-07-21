const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadAccountReasons() {
  const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
  const filePath = path.join(__dirname, '..', 'web', 'src', 'utils', 'account-reasons.ts');
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

test('account reason formatter explains auth invalid direct 401 composite reason', () => {
  const { formatAccountIssueReason, isAuthInvalidReauthRequiredReason } = loadAccountReasons();

  const formatted = formatAccountIssueReason('auth_invalid_reauth_required:direct_http_status_401');

  assert.equal(isAuthInvalidReauthRequiredReason('auth_invalid_reauth_required:direct_http_status_401'), true);
  assert.equal(
    formatted,
    '账号认证已失效，直连额度请求返回 HTTP 401。请重新登录或重新授权后再使用。'
  );
  assert.equal(formatted.includes('auth_invalid_reauth_required'), false);
  assert.equal(formatted.includes('direct_http_status_401'), false);
});

test('account reason formatter keeps direct http status useful without auth prefix', () => {
  const { formatAccountIssueReason } = loadAccountReasons();

  assert.equal(
    formatAccountIssueReason('direct_http_status_401'),
    '直连额度请求返回 HTTP 401。'
  );
});

test('account reason formatter preserves existing known quota explanations', () => {
  const { formatAccountIssueReason } = loadAccountReasons();

  assert.equal(formatAccountIssueReason('timeout'), '额度查询超时。');
  assert.equal(
    formatAccountIssueReason('auth_invalid_reauth_required'),
    '账号认证已失效，需要重新登录或重新授权后再使用。'
  );
  assert.equal(formatAccountIssueReason('some_future_reason'), 'some_future_reason');
});
