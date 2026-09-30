import { describe, expect, test } from 'bun:test';
import { getAccountIdentityLabel, getAccountSecondaryIdentity } from './account-labels';

// 回归:没有邮箱的 OAuth 账号(如 WorkBuddy 只有 nickname)主标题就是名称,副标题又显示一遍。
describe('account identity labels', () => {
  test('no email: the name is the title and is not repeated as the subtitle', () => {
    const account = { provider: 'workbuddy', email: '', displayName: '码逗', configured: true, apiKeyMode: false } as any;
    expect(getAccountIdentityLabel(account)).toBe('码逗');
    expect(getAccountSecondaryIdentity(account)).toBe('');
  });

  test('email as title: a different name is shown as the subtitle', () => {
    const account = { provider: 'codex', email: 'a@example.com', displayName: 'Alice', configured: true, apiKeyMode: false } as any;
    expect(getAccountIdentityLabel(account)).toBe('a@example.com');
    expect(getAccountSecondaryIdentity(account)).toBe('Alice');
  });
});
