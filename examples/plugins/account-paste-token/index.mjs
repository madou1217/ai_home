// P4 账号插件样例：一个最小的「粘贴 token」登录 + 投影 + 刷新闭环。
//
// 插件只交换 JSON：账号判重、accountRef、runtimeDir、写盘和任务持久化都由宿主完成。
// 这里故意使用 opencode 的 auth.json 形状，方便用真实账号注册链路做端到端验收。
import { randomUUID } from 'node:crypto';
import { definePlugin } from '@ai-home/plugin-sdk';

const SOURCE_ID = 'paste-token';
const LOGIN_ID = 'aih.demo.account.paste-token.login';
const AUTH_FILE = '.local/share/opencode/auth.json';

function providerMatches(provider) {
  return String(provider || '').trim().toLowerCase() === 'opencode';
}

function authFile(token) {
  return {
    path: AUTH_FILE,
    content: `${JSON.stringify({ opencode: { type: 'api', key: token } }, null, 2)}\n`
  };
}

export default definePlugin({
  name: 'aih.demo.account.paste-token',
  apply(ctx) {
    ctx.aih.register('aih.demo.account.paste-token.source', (input) => {
      if (input.kind === 'list') {
        return {
          sources: [{
            id: SOURCE_ID,
            kind: 'remote',
            authMode: 'api-key',
            clientDependent: false,
            directImport: false,
            description: '粘贴 OpenCode API Key',
            loginContribution: LOGIN_ID
          }]
        };
      }
      if (input.kind === 'import') {
        return { files: [] };
      }
      throw new Error(`unsupported source kind: ${input.kind}`);
    });

    ctx.aih.register(LOGIN_ID, (input) => {
      if (input.kind === 'start') {
        return {
          status: 'waiting_user',
          jobId: randomUUID(),
          canSubmit: true,
          submitLabel: '提交 API Key',
          submitPlaceholder: '粘贴 OpenCode API Key；插件不会把它写进任务文件。',
          expiresAt: Date.now() + 10 * 60 * 1000
        };
      }
      if (input.kind === 'poll') {
        return { status: 'waiting_user' };
      }
      if (input.kind === 'submit') {
        const token = String(input.value || '').trim();
        if (!token) return { status: 'failed', message: 'API Key 为空' };
        return { status: 'success', credential: { token } };
      }
      return { status: 'cancelled' };
    });

    ctx.aih.register('aih.demo.account.paste-token.materialize', (input) => {
      if (input.kind === 'match') return { handles: providerMatches(input.provider) };
      if (input.kind !== 'materialize') return { handled: false };
      const token = String(input.credential && input.credential.token || '').trim();
      if (!providerMatches(input.provider) || !token) return { handled: false };
      return { handled: true, files: [authFile(token)] };
    });

    ctx.aih.register('aih.demo.account.paste-token.refresh', (input) => {
      if (input.kind === 'match') return { handles: providerMatches(input.provider) };
      if (input.kind !== 'refresh') return { handled: false };
      const token = String(input.credential && input.credential.token || '').trim();
      if (!token) return { handled: false };
      // 演示刷新链：真实插件在这里换取新 token；这里保持同一个 token，避免演示账号
      // 因身份种子变化被注册成第二个账号。
      return { handled: true, rotated: false, credential: { token } };
    });
  }
});
