// Plugin Host 子进程入口：起本机 RPC 服务，把 prepare / activate / invoke / dispose / status 交给 HostRuntime。
// 由 supervisor.js 拉起；socket 路径与令牌只经环境变量传入（环境变量按白名单构造，不含网关凭据）。

import { createRequire } from 'node:module';
import { HostRuntime } from './host-runtime.mjs';

const require = createRequire(import.meta.url);
const { createRpcServer } = require('../transport/rpc-server');
const { PluginError } = require('../sdk/errors');

const socketPath = process.env.AIH_PLUGIN_SOCKET || '';
const token = process.env.AIH_PLUGIN_TOKEN || '';
if (!socketPath) throw new Error('plugin_host_socket_missing');
if (token.length < 32) throw new Error('plugin_host_token_invalid');

const runtime = new HostRuntime({ hostVersion: process.env.AIH_PLUGIN_HOST_VERSION || '1.0.0' });
let server = null;

async function shutdown(code = 0) {
  try { await runtime.shutdown(); } catch (_error) {}
  try { await server?.close(); } catch (_error) {}
  process.exit(code);
}

server = createRpcServer({
  socketPath,
  token,
  onCall: async (method, value, context) => {
    if (method === 'prepare') return runtime.prepare(value);
    if (method === 'activate') return runtime.activate(value?.generation);
    if (method === 'invoke') return runtime.invoke(value, context);
    if (method === 'dispose') return runtime.dispose(value?.generation);
    if (method === 'status') return runtime.status();
    if (method === 'ping') return { value: { pong: true }, payload: context.payload };
    if (method === 'shutdown') { setImmediate(() => { void shutdown(0); }); return { state: 'stopping' }; }
    throw new PluginError('plugin_rpc_method_unknown');
  }
});

await server.listen();
process.stdout.write(`${JSON.stringify({ event: 'plugin_host_ready', pid: process.pid })}\n`);
process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
process.once('disconnect', () => { void shutdown(0); });
