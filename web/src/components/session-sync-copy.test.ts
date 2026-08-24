import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SESSION_SYNC_SUMMARY } from './session-sync-copy.ts';

test('网页会话刷新文案说明触发方式和数据边界', () => {
  assert.equal(
    SESSION_SYNC_SUMMARY,
    '本机 CLI 有新回合时，只通知 WebUI 重新读取本地会话文件；这个本地通知不携带账号凭据或聊天正文。'
  );
  assert.doesNotMatch(SESSION_SYNC_SUMMARY, /Hook/);
});

test('应用管理复用网页会话刷新单一文案源', () => {
  const sources = [
    fs.readFileSync(new URL('./toolkit/AppManagerPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./toolkit/ManagedAppCard.tsx', import.meta.url), 'utf8')
  ];

  for (const source of sources) {
    assert.match(source, /SESSION_SYNC_SUMMARY/);
    assert.doesNotMatch(source, /SESSION_SYNC_(?:POLICY|BOUNDARY|SCOPE)/);
    assert.doesNotMatch(source, /会话实时同步/);
    assert.doesNotMatch(source, /Provider Hook|Hook 状态|Hook 尚未|会话 Hook/);
  }

  assert.equal(fs.existsSync(new URL('./settings/RealtimeSyncCard.tsx', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('./settings/RealtimeSyncCard.css', import.meta.url)), false);
});
