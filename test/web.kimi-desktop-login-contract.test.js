'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(projectRoot, 'web/src/services/api.ts'), 'utf8');
const modalSource = fs.readFileSync(
  path.join(projectRoot, 'web/src/features/accounts/KimiDesktopLoginModal.tsx'),
  'utf8'
);
test('Kimi Desktop 扫码弹窗调用 accountsAPI 已实现的 start/poll 方法', () => {
  assert.match(modalSource, /accountsAPI\.startKimiDesktopSession\(accountRef\)/);
  assert.match(modalSource, /accountsAPI\.pollKimiDesktopSession\(accountRef, code\)/);
  assert.match(apiSource, /startKimiDesktopSession:\s*async\s*\(accountRef: string\)/);
  assert.match(apiSource, /pollKimiDesktopSession:\s*async\s*\(/);
});

test('Kimi Desktop 扫码 API 使用账号作用域路由并提交轮询 code', () => {
  assert.match(
    apiSource,
    /\/webui\/accounts\/kimi\/\$\{encodeURIComponent\(accountRef\)\}\/desktop-session\/start/
  );
  assert.match(
    apiSource,
    /\/webui\/accounts\/kimi\/\$\{encodeURIComponent\(accountRef\)\}\/desktop-session\/poll[\s\S]*?\{ code \}/
  );
  assert.match(modalSource, /destroyOnHidden/);
  assert.doesNotMatch(modalSource, /destroyOnClose/);
});

test('Kimi Desktop 扫码弹窗不因父组件回调重建而重复生成二维码', () => {
  assert.match(modalSource, /const onCloseRef = useRef\(onClose\)/);
  assert.match(modalSource, /const onSuccessRef = useRef\(onSuccess\)/);
  assert.match(modalSource, /if \(onSuccessRef\.current\) onSuccessRef\.current\(\)/);
  assert.match(modalSource, /else onCloseRef\.current\(\)/);
  assert.match(modalSource, /\}, \[accountRef, stopPolling\]\);/);
  assert.doesNotMatch(modalSource, /\}, \[accountRef, onClose, onSuccess, stopPolling\]\);/);
});

test('Kimi Desktop 扫码弹窗使用服务端截止时间停止本地轮询', () => {
  assert.match(modalSource, /const expiryTimerRef = useRef/);
  assert.match(modalSource, /clearTimeout\(expiryTimerRef\.current\)/);
  assert.match(modalSource, /resolveKimiDesktopSessionExpiryDelay\(result\.expiresAtMs\)/);
  assert.match(modalSource, /expiryTimerRef\.current = setTimeout/);
  assert.match(modalSource, /setPhase\('STATUS_EXPIRED'\)/);
});
