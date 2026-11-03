// Provider 插件样例：插件只返回 canonical 描述符数据。
// - 不 import 宿主内部模块；
// - 不携带探针/发现函数（host RPC 只能传 JSON）；
// - models.strategies[].handler 引用宿主已注册的 handler id，
//   由宿主在代次发布时解析，解析失败该描述符会被拒绝。
import { definePlugin } from '@ai-home/plugin-sdk';
import descriptor from './descriptor.json' with { type: 'json' };

export default definePlugin({
  name: 'aih-sample-provider-descriptor',
  apply(ctx) {
    ctx.aih.register('sample.provider.descriptor', () => ({ descriptors: [descriptor] }));
  }
});
