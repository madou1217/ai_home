import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopLoginRequiredAction } from './launch-required-action';

const failure = (data: unknown) => ({ response: { data } });

test('启动失败只按服务端声明的 requiredAction 进入托管登录，不看 provider 或错误码', () => {
  assert.deepEqual(
    desktopLoginRequiredAction(failure({
      error: 'kimi_desktop_session_seed_failed',
      message: '登录态写入失败',
      requiredAction: { kind: 'desktop-login', flow: 'kimi-desktop-session', warn: true }
    })),
    { kind: 'desktop-login', flow: 'kimi-desktop-session', warn: true, message: '登录态写入失败' }
  );
  assert.equal(desktopLoginRequiredAction(failure({ error: 'kimi_desktop_session_required' })), null);
  assert.equal(desktopLoginRequiredAction(failure({
    requiredAction: { kind: 'desktop-login', flow: 'unknown-flow' }
  })), null, '未实现的流程按普通错误处理');
  assert.equal(desktopLoginRequiredAction(new Error('network')), null);
  assert.equal(desktopLoginRequiredAction(null), null);
});
