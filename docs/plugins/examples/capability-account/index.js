'use strict';

// 账号级能力插件最小骨架：
// - account.source 只负责“这个 Provider 有哪些登录来源”
// - account.login 负责 start / poll / submit / cancel 状态机
// - 投影文件与账号入库由 AIH 宿主完成，插件不要直接写账号库
module.exports = {
  apply(ctx) {
    ctx.aih.register('example.account.source', async (value) => {
      if (value.provider !== 'example') return { sources: [] };
      return {
        sources: [{
          schemaVersion: 1,
          id: 'example-oauth',
          kind: 'oauth',
          authMode: 'oauth',
          directImport: false,
          available: true,
          description: 'Example OAuth device flow'
        }]
      };
    });

    ctx.aih.register('example.account.login', async (value) => {
      switch (value.kind) {
        case 'start':
          return {
            status: 'waiting_user',
            jobId: 'example-job',
            message: '在浏览器中完成授权',
            verificationUri: 'https://example.com/device',
            userCode: 'ABCD-EFGH',
            intervalMs: 5000
          };
        case 'poll':
          return { status: 'pending', message: '等待用户授权' };
        case 'submit':
          return { status: 'failed', message: '样例未实现 submit' };
        case 'cancel':
          return { status: 'failed', message: '已取消' };
        default:
          return { status: 'failed', message: `unknown kind: ${value.kind}` };
      }
    });
  }
};
