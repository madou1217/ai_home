// M0 样例插件：只 import SDK，不引用 AIH 宿主内部模块。
// - sample.echo.call：原样回显 value 与二进制 payload（字节数也回报，便于核对有界大 payload）。
// - sample.echo.wait：一直等到被取消（或 deadline），用来验证取消真的传到了 handler；
//   sample.echo.stats 回报 handler 实际观察到的取消次数与原因。
// - 提供 sample.echo 服务，并登记一个异步 disposer，验证卸载会等它跑完。

import { definePlugin, withPayload } from '@ai-home/plugin-sdk';

const observed = { aborts: 0, lastReason: '' };

export default definePlugin({
  name: 'aih-sample-echo',
  apply(ctx) {
    ctx.aih.provide('sample.echo', { echo: (value) => value });

    ctx.aih.register('sample.echo.call', (value, context) => withPayload(
      { echoed: value, bytes: context.payload.byteLength, instanceId: context.instanceId, generation: context.generation },
      context.payload
    ));

    ctx.aih.register('sample.echo.wait', (_value, context) => new Promise((resolve) => {
      const done = () => {
        observed.aborts += 1;
        observed.lastReason = String(context.signal.reason?.code || context.signal.reason || '');
        resolve({ aborted: true, reason: observed.lastReason });
      };
      if (context.signal.aborted) done();
      else context.signal.addEventListener('abort', done, { once: true });
    }));

    ctx.aih.register('sample.echo.stats', () => ({ ...observed }));

    ctx.effect(() => () => new Promise((resolve) => setTimeout(resolve, 20)), 'sample.echo async disposer');
  }
});
