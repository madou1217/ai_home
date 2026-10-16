'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseEdgeArgs, runEdgeCommand } = require('../lib/cli/commands/edge-router');
const { rewriteProviderResumeVerb } = require('../lib/cli/services/ai-cli/provider-resume-verb');

function capture() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    consoleImpl: {
      log: (line = '') => lines.push(String(line)),
      error: (line = '') => errors.push(String(line))
    }
  };
}

function fakeService(overrides = {}) {
  const calls = [];
  return {
    calls,
    status: () => ({ ok: true, aihPort: 9527, providers: {} }),
    plan: (kind, args) => {
      calls.push(['plan', kind, args]);
      return { kind, summary: `plan:${kind}`, notes: [], files: [{ path: `/etc/nginx/${kind}.conf`, content: 'stream {}' }] };
    },
    apply: (kind, args) => {
      calls.push(['apply', kind, args]);
      return { ok: true, provider: kind, summary: `applied:${kind}`, reloaded: true, reloadedVia: 'nginx-s' };
    },
    ...overrides
  };
}

test('aih edge：参数解析保持既有旗标语义（含 dry-run / no-reload / udp）', () => {
  assert.deepEqual(parseEdgeArgs(['apply', 'frp', '--remote-port', '29527', '--no-udp', '--dry-run']), {
    positional: ['apply', 'frp'],
    remotePort: 29527,
    udp: false,
    dryRun: true
  });
  assert.deepEqual(parseEdgeArgs(['plan', 'nginx', '--domain', 'a.com', '--mode', 'split', '--no-reload']), {
    positional: ['plan', 'nginx'],
    domain: 'a.com',
    mode: 'split',
    reload: false
  });
});

test('aih edge status：打印真实探测结果并以 0 退出', () => {
  const { consoleImpl, lines } = capture();
  const code = runEdgeCommand(['status'], { service: fakeService(), consoleImpl });

  assert.equal(code, 0);
  assert.match(lines.join('\n'), /"aihPort": 9527/);
});

test('aih edge plan：只打印将写入的内容，不落盘', () => {
  const { consoleImpl, lines } = capture();
  const service = fakeService();
  const code = runEdgeCommand(['plan', 'nginx', '--domain', 'a.com'], { service, consoleImpl });

  assert.equal(code, 0);
  assert.equal(service.calls.length, 1);
  assert.equal(service.calls[0][0], 'plan');
  assert.equal(service.calls[0][2].domain, 'a.com');
  assert.match(lines.join('\n'), /plan:nginx/);
  assert.match(lines.join('\n'), /stream \{\}/);
});

test('aih edge apply --dry-run：绝不调用写入（dry-run 是承诺，不是提示）', () => {
  const { consoleImpl, lines } = capture();
  const service = fakeService();
  const code = runEdgeCommand(['apply', 'frp', '--remote-port', '29527', '--dry-run'], { service, consoleImpl });

  assert.equal(code, 0);
  assert.deepEqual(service.calls.map((call) => call[0]), ['plan']);
  assert.match(lines.join('\n'), /dry-run：没有写入任何文件/);
});

test('aih edge apply：写入失败以非零退出并回显内核原话', () => {
  const { consoleImpl, errors } = capture();
  const service = fakeService({
    apply: () => ({ ok: false, error: 'edge_config_rejected', detail: 'unknown directive "stream"' })
  });
  const code = runEdgeCommand(['apply', 'nginx', '--domain', 'a.com'], { service, consoleImpl });

  assert.equal(code, 1);
  assert.match(errors.join('\n'), /edge_config_rejected/);
  assert.match(errors.join('\n'), /unknown directive/);
});

test('aih edge：缺动作给帮助并以 1 退出，--help 以 0 退出', () => {
  const missing = capture();
  assert.equal(runEdgeCommand([], missing), 1);
  assert.match(missing.lines.join('\n'), /aih edge status/);

  const asked = capture();
  assert.equal(runEdgeCommand(['--help'], asked), 0);

  const bogus = capture();
  assert.equal(runEdgeCommand(['bogus'], bogus), 1);
  assert.match(bogus.errors.join('\n'), /aih edge status/);
});

test('aih <cli> resume：统一动词翻译成各 provider 的原生命令/旗标（事实来自合同）', () => {
  // 顶层无账号
  assert.deepEqual(rewriteProviderResumeVerb('codex', ['codex', 'resume']), { ok: true, args: ['codex', 'resume'] });
  assert.deepEqual(rewriteProviderResumeVerb('codex', ['codex', 'resume', 'abc']), { ok: true, args: ['codex', 'resume', 'abc'] });
  assert.deepEqual(rewriteProviderResumeVerb('claude', ['claude', 'resume']), { ok: true, args: ['claude', '--continue'] });
  assert.deepEqual(rewriteProviderResumeVerb('claude', ['claude', 'resume', 'sid']), { ok: true, args: ['claude', '--resume', 'sid'] });
  assert.deepEqual(rewriteProviderResumeVerb('gemini', ['gemini', 'resume']), { ok: true, args: ['gemini', '--resume', 'latest'] });
  assert.deepEqual(rewriteProviderResumeVerb('opencode', ['opencode', 'resume', 'ses_9']), { ok: true, args: ['opencode', '--session', 'ses_9'] });
  assert.deepEqual(rewriteProviderResumeVerb('codebuddycn', ['codebuddycn', 'resume', 'x']), { ok: true, args: ['codebuddycn', '--resume', 'x'] });

  // 带账号：改写的只是动词部分，账号 token 原样保留
  assert.deepEqual(rewriteProviderResumeVerb('claude', ['claude', '2', 'resume', 'sid']), { ok: true, args: ['claude', '2', '--resume', 'sid'] });

  // 额外原生参数跟在身份之后，不被吞掉
  assert.deepEqual(
    rewriteProviderResumeVerb('claude', ['claude', 'resume', 'sid', '--model', 'opus']),
    { ok: true, args: ['claude', '--resume', 'sid', '--model', 'opus'] }
  );

  // 没有 resume 动词时原样返回 null，由既有派发链处理
  assert.equal(rewriteProviderResumeVerb('claude', ['claude', 'ls']), null);
  assert.equal(rewriteProviderResumeVerb('claude', ['claude', '--resume', 'sid']), null);
});

test('aih <cli> resume --help：打印统一用法而不是把 --help 发给原生 CLI', () => {
  const help = rewriteProviderResumeVerb('claude', ['claude', 'resume', '--help']);
  assert.equal(help.ok, false);
  assert.equal(help.reason, 'resume_help');
  assert.match(help.message, /aih <cli> resume \[<id>\]/);
  assert.match(help.message, /cline {5}--id/);
});

test('aih <cli> resume：拒绝的三种情形各自有明确原因（不猜、不静默降级）', () => {
  const cline = rewriteProviderResumeVerb('cline', ['cline', 'resume']);
  assert.equal(cline.ok, false);
  assert.equal(cline.reason, 'resume_identity_required');

  const kimi = rewriteProviderResumeVerb('kimi', ['kimi', 'resume']);
  assert.equal(kimi.ok, false);
  assert.equal(kimi.reason, 'resume_in_tui_only');

  const zcode = rewriteProviderResumeVerb('zcode', ['zcode', 'resume', 'x']);
  assert.equal(zcode.ok, false);
  assert.equal(zcode.reason, 'resume_unsupported');

  const bad = rewriteProviderResumeVerb('claude', ['claude', 'resume', 'bad id']);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'resume_identity_invalid');
});

test('接线守卫：aih edge 必须挂在顶层路由器上，脚本只是薄壳；resume 动词必须接进 provider 派发', () => {
  const root = path.join(__dirname, '..');
  const router = fs.readFileSync(path.join(root, 'lib/cli/commands/root/router.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'lib/cli/app.js'), 'utf8');
  const wiring = fs.readFileSync(path.join(root, 'lib/cli/bootstrap/root-dispatch.js'), 'utf8');
  const help = fs.readFileSync(path.join(root, 'lib/cli/commands/help/messages.js'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'scripts/aih-edge.js'), 'utf8');

  assert.match(router, /edge: async \(\) =>/);
  assert.match(router, /deps\.runEdgeCommand\(/);
  assert.match(app, /require\('\.\/commands\/edge-router'\)/);
  assert.match(app, /runEdgeCommand,/);
  assert.match(wiring, /runEdgeCommand: deps\.runEdgeCommand/);
  assert.match(help, /aih edge \[status\|plan\|apply\|remove\]/);
  // 脚本与 CLI 必须是同一实现，不允许第二套解析/写入逻辑。
  assert.match(script, /runEdgeCommand\(process\.argv\.slice\(2\)\)/);
  assert.equal(script.includes('EdgeProxyService'), false, '脚本里不应再直接持有服务实现');

  // resume 统一动词：router 必须调用它，且拒绝时以非零退出（不许静默降级成转发原生命令）。
  const aiCliRouter = fs.readFileSync(path.join(root, 'lib/cli/commands/ai-cli/router.js'), 'utf8');
  assert.match(aiCliRouter, /rewriteProviderResumeVerb\(cliName, args\)/);
  assert.match(aiCliRouter, /resume 不支持/);
});
