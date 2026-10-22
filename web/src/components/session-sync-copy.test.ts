import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SESSION_SYNC_SUMMARY } from './session-sync-copy.ts';

test('即时刷新文案说明触发方式和数据边界', () => {
  assert.equal(
    SESSION_SYNC_SUMMARY,
    '本机 CLI 有新回合时，只通知 WebUI 重新读取本地会话文件；这个本地通知不携带账号凭据或聊天正文。'
  );
  assert.doesNotMatch(SESSION_SYNC_SUMMARY, /Hook/);
});

// 「网页会话刷新」这个说法用户看不懂（它像在描述同步机制，不说明结果）。
// 界面上统一用动作名「即时刷新」，术语不再分叉。
test('应用管理不再把「网页会话刷新」当用户可见文案', () => {
  const sources = [
    fs.readFileSync(new URL('./toolkit/AppManagerPanel.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./toolkit/ManagedAppCard.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./toolkit/use-managed-apps.tsx', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../mobile/pages/toolkit/AppsPanel.tsx', import.meta.url), 'utf8')
  ];

  for (const source of sources) {
    assert.doesNotMatch(source, /['"`][^'"`]*网页会话刷新/);
    assert.doesNotMatch(source, /SESSION_SYNC_(?:POLICY|BOUNDARY|SCOPE)/);
    assert.doesNotMatch(source, /会话实时同步/);
    assert.doesNotMatch(source, /Provider Hook|Hook 状态|Hook 尚未|会话 Hook/);
  }

  // 文案只有一个源：启用入口与说明都从 SESSION_SYNC_SUMMARY 取，避免各写各的。
  assert.match(
    fs.readFileSync(new URL('./toolkit/ManagedAppCard.tsx', import.meta.url), 'utf8'),
    /SESSION_SYNC_SUMMARY/
  );

  assert.equal(fs.existsSync(new URL('./settings/RealtimeSyncCard.tsx', import.meta.url)), false);
  assert.equal(fs.existsSync(new URL('./settings/RealtimeSyncCard.css', import.meta.url)), false);
});
