#!/usr/bin/env node
'use strict';

/**
 * 影子比对：把同一批请求同时发给 Node 与 Go 网关，逐条比对状态码与响应结构。
 *
 * 为什么需要它：切流前唯一能证明「Go 能替代 Node」的证据是同输入同输出，而
 * 单测和合成测试测不出真实上游的行为差异——429 被洗成 502、订阅身份缺失被限流
 * 这两个缺陷都只有真流量才暴露。本工具让这种比对可重复、可留档。
 *
 * 用法:
 *   node scripts/gateway-shadow-compare.js
 *     --node http://127.0.0.1:9527 --node-key <key>
 *     --go   http://127.0.0.1:19550 --go-key  <key>
 *     [--model claude-opus-4-6] [--include-inference] [--json]
 *
 * 默认只跑只读端点（不产生 token 计费）。--include-inference 才发推理请求，
 * 每个协议各一次最小提示。
 *
 * 安全约束：Key 只从命令行或环境变量读取，不落盘、不打印；响应体只比结构，
 * 不输出正文内容。
 */

const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const out = {
    node: '', go: '', nodeKey: '', goKey: '',
    model: 'claude-opus-4-6', includeInference: false, json: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => String(argv[i + 1] || '').trim();
    if (arg === '--node') { out.node = next(); i += 1; }
    else if (arg === '--go') { out.go = next(); i += 1; }
    else if (arg === '--node-key') { out.nodeKey = next(); i += 1; }
    else if (arg === '--go-key') { out.goKey = next(); i += 1; }
    else if (arg === '--model') { out.model = next(); i += 1; }
    else if (arg === '--include-inference') out.includeInference = true;
    else if (arg === '--json') out.json = true;
  }
  out.nodeKey = out.nodeKey || String(process.env.AIH_SHADOW_NODE_KEY || '').trim();
  out.goKey = out.goKey || String(process.env.AIH_SHADOW_GO_KEY || '').trim();
  return out;
}

/** 只读探针：不触发上游推理，因此没有 token 成本。 */
function readOnlyProbes() {
  return [
    { name: 'props', method: 'GET', path: '/v1/props' },
    { name: 'models', method: 'GET', path: '/v1/models' },
    { name: 'health', method: 'GET', path: '/healthz', skipAuth: true }
  ];
}

/** 推理探针：每个客户端协议一次最小请求。 */
function inferenceProbes(model) {
  return [
    {
      name: 'responses',
      method: 'POST',
      path: '/v1/responses',
      body: { model, input: 'say ok', stream: false }
    },
    {
      name: 'messages',
      method: 'POST',
      path: '/v1/messages',
      body: {
        model,
        max_tokens: 64_000,
        messages: [{ role: 'user', content: 'say ok' }]
      }
    }
  ];
}

/**
 * 提取响应的结构指纹：字段名与类型，不含取值。
 * 直接比正文会被 id、时间戳、token 数噪声淹没；结构才是协议契约。
 */
function structureOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return depth >= 3 ? 'array' : `[${value.length ? structureOf(value[0], depth + 1) : ''}]`;
  }
  if (typeof value !== 'object') return typeof value;
  if (depth >= 3) return 'object';
  return `{${Object.keys(value).sort().map(
    (k) => `${k}:${structureOf(value[k], depth + 1)}`
  ).join(',')}}`;
}

async function probe(baseUrl, key, spec) {
  const headers = { accept: 'application/json' };
  if (!spec.skipAuth && key) headers.authorization = `Bearer ${key}`;
  if (spec.body) headers['content-type'] = 'application/json';
  const started = Date.now();
  try {
    const res = await fetch(baseUrl + spec.path, {
      method: spec.method,
      headers,
      body: spec.body ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_e) { parsed = null; }
    return {
      status: res.status,
      structure: parsed ? structureOf(parsed) : '<non-json>',
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      status: 0,
      structure: `<error:${error.name}>`,
      elapsedMs: Date.now() - started
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.node || !args.go) {
    console.error('必须同时提供 --node 与 --go 基地址');
    process.exit(2);
  }

  const specs = [
    ...readOnlyProbes(),
    ...(args.includeInference ? inferenceProbes(args.model) : [])
  ];

  const rows = [];
  for (const spec of specs) {
    // 顺序执行：并发会让两侧命中不同的账号冷却状态，比对失去意义。
    const nodeResult = await probe(args.node, args.nodeKey, spec);
    const goResult = await probe(args.go, args.goKey, spec);
    rows.push({
      probe: spec.name,
      path: spec.path,
      node: nodeResult,
      go: goResult,
      statusMatch: nodeResult.status === goResult.status,
      structureMatch: nodeResult.structure === goResult.structure
    });
  }

  const mismatches = rows.filter((r) => !r.statusMatch || !r.structureMatch);

  if (args.json) {
    console.log(JSON.stringify({ rows, mismatchCount: mismatches.length }, null, 2));
  } else {
    console.log('probe        path                 node        go          一致');
    for (const r of rows) {
      const verdict = r.statusMatch && r.structureMatch
        ? '✓'
        : (r.statusMatch ? '结构✗' : '状态✗');
      console.log(
        `${r.probe.padEnd(12)} ${r.path.padEnd(20)} `
        + `${String(r.node.status).padEnd(11)} ${String(r.go.status).padEnd(11)} ${verdict}`
      );
    }
    if (mismatches.length) {
      console.log('\n不一致明细:');
      for (const r of mismatches) {
        console.log(`\n  ${r.probe} ${r.path}`);
        console.log(`    node: status=${r.node.status} structure=${r.node.structure}`);
        console.log(`    go:   status=${r.go.status} structure=${r.go.structure}`);
      }
    }
    console.log(`\n探针 ${rows.length} 条，不一致 ${mismatches.length} 条。`);
  }

  process.exit(mismatches.length ? 1 : 0);
}

main();
