'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseEdgeArgs, runEdgeCommand } = require('../lib/cli/commands/edge-router');
const { extractNativeEscape, rewriteProviderNativeVerb } = require('../lib/cli/services/ai-cli/provider-resume-verb');
const rewriteProviderResumeVerb = rewriteProviderNativeVerb;

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

test('aih edge：缺动作/未知用法都给提示 + 用法并以 0 退出，--help 以 0 退出', () => {
  const missing = capture();
  assert.equal(runEdgeCommand([], missing), 0);
  assert.match(missing.lines.join('\n'), /未指定动作/);
  assert.match(missing.lines.join('\n'), /aih edge status/);

  const asked = capture();
  assert.equal(runEdgeCommand(['--help'], asked), 0);
  assert.doesNotMatch(asked.lines.join('\n'), /未指定动作/);
  assert.match(asked.lines.join('\n'), /aih edge status/);

  const bogus = capture();
  assert.equal(runEdgeCommand(['bogus'], bogus), 0);
  assert.match(bogus.lines.join('\n'), /未识别的用法 'bogus'/);
  assert.match(bogus.lines.join('\n'), /aih edge status/);

  // 缺/错类型不再丢一句裸报错，而是提示可用类型 + 完整用法。
  const wrongKind = capture();
  assert.equal(runEdgeCommand(['remove', 'nginx'], wrongKind), 0);
  assert.match(wrongKind.lines.join('\n'), /未指定或未识别的类型（可用：frp）/);
  assert.match(wrongKind.lines.join('\n'), /aih edge status/);

  const missingKind = capture();
  assert.equal(runEdgeCommand(['plan'], missingKind), 0);
  assert.match(missingKind.lines.join('\n'), /未指定或未识别的类型（可用：frp \| nginx \| caddy）/);
});

test('aih edge：service 层的缺参数错误码转成提示 + 用法 + exit 0，运行失败仍 exit 1', () => {
  const usageService = fakeService({
    plan: () => {
      const error = new Error('edge_domain_required');
      error.code = 'edge_domain_required';
      throw error;
    }
  });
  const usage = capture();
  assert.equal(runEdgeCommand(['plan', 'nginx'], { service: usageService, consoleImpl: usage.consoleImpl }), 0);
  assert.match(usage.lines.join('\n'), /缺少 --domain/);
  assert.match(usage.lines.join('\n'), /aih edge status/);
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
  assert.equal(help.reason, 'verb_help');
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

test('aih <cli> fork：统一分叉动词（codex 子命令形态 + 其余 --fork-session/--fork）', () => {
  assert.deepEqual(rewriteProviderNativeVerb('codex', ['codex', 'fork', 'sid']), { ok: true, args: ['codex', 'fork', 'sid'] });
  assert.deepEqual(rewriteProviderNativeVerb('codex', ['codex', 'fork']), { ok: true, args: ['codex', 'fork'] });
  assert.deepEqual(rewriteProviderNativeVerb('claude', ['claude', 'fork', 'sid']), { ok: true, args: ['claude', '--resume', 'sid', '--fork-session'] });
  assert.deepEqual(rewriteProviderNativeVerb('claude', ['claude', 'fork']), { ok: true, args: ['claude', '--continue', '--fork-session'] });
  assert.deepEqual(rewriteProviderNativeVerb('opencode', ['opencode', 'fork', 'ses_1']), { ok: true, args: ['opencode', '--session', 'ses_1', '--fork'] });
  assert.deepEqual(rewriteProviderNativeVerb('qodercn', ['qodercn', 'fork']), { ok: true, args: ['qodercn', '--continue', '--fork-session'] });
  // 没有 fork 能力的 provider 明确拒绝（gemini / cline / agy），TUI-only 的给 TUI 说明
  for (const provider of ['gemini', 'cline', 'agy']) {
    const refused = rewriteProviderNativeVerb(provider, [provider, 'fork', 'x']);
    assert.equal(refused.ok, false, provider);
    assert.equal(refused.reason, 'fork_unsupported', provider);
  }
  assert.equal(rewriteProviderNativeVerb('kimi', ['kimi', 'fork']).reason, 'resume_in_tui_only');
});

test('原生命令透传：统一动词之外的 token 一律不改写，`--` 之后强制原样', () => {
  // 这些是各 CLI 的真实子命令/参数，必须原样交给原生 CLI
  for (const tokens of [
    ['codex', 'exec', '--json'],
    ['codex', 'mcp', 'list'],
    ['codex', 'agents'],
    ['claude', '--model', 'opus'],
    ['claude', '-p', 'hi'],
    ['opencode', 'run', 'hello'],
    ['gemini', '-i'],
    ['cline', '--json'],
    ['qoder', '--print', 'x']
  ]) {
    assert.equal(rewriteProviderNativeVerb(tokens[0], tokens), null, tokens.join(' '));
  }

  // codex 的 `resume --last` 既是原生参数也是统一动词：改写后必须逐字节等于原生形态。
  assert.deepEqual(rewriteProviderNativeVerb('codex', ['codex', 'resume', '--last']), { ok: true, args: ['codex', 'resume', '--last'] });
  assert.deepEqual(rewriteProviderNativeVerb('codex', ['codex', 'fork', '--last']), { ok: true, args: ['codex', 'fork', '--last'] });

  // 逃生门：撞上 aih 保留字（ls / login / sessions / resume）也照原样发出去
  assert.deepEqual(extractNativeEscape(['claude', '--', 'ls']), { escaped: true, args: ['claude', 'ls'] });
  assert.deepEqual(extractNativeEscape(['claude', '2', '--', 'resume', 'sid']), { escaped: true, args: ['claude', 'resume', 'sid'] });
  assert.deepEqual(extractNativeEscape(['claude', 'ls']), { escaped: false, args: ['claude', 'ls'] });
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
  assert.match(aiCliRouter, /rewriteProviderNativeVerb\(cliName, args\)/);
  assert.match(aiCliRouter, /不支持该统一动词/);
  // 逃生门必须先于动词改写生效（`--` 之后原样透传）。
  assert.match(aiCliRouter, /extractNativeEscape\(args\)/);
});
