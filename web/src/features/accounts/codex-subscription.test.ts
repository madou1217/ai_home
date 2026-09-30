import { describe, expect, test } from 'bun:test';
import { describeCodexSubscription, getCodexSubscription } from './codex-subscription';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 8, 0, 0);

function codexRecord(account: Record<string, unknown>) {
  return {
    provider: 'codex',
    usageSnapshot: { kind: 'codex_oauth_status', capturedAt: NOW, account, entries: [] }
  } as any;
}

describe('codex subscription status', () => {
  test('到期日未到：正常显示到期日', () => {
    const sub = getCodexSubscription(codexRecord({ planType: 'plus', subscriptionActiveUntilMs: NOW + DAY }), NOW)!;
    expect(sub.status).toBe('active');
    expect(describeCodexSubscription(sub).needsConfirmation).toBe(false);
  });

  test('到期日已过，但之后额度接口仍确认付费套餐：已续费', () => {
    const sub = getCodexSubscription(codexRecord({
      planType: 'plus', subscriptionActiveUntilMs: NOW - 3 * DAY, planConfirmedAtMs: NOW - 60_000
    }), NOW)!;
    expect(sub.status).toBe('renewed');
    const view = describeCodexSubscription(sub);
    expect(view.tone).toBe('success');
    expect(view.label).toMatch(/^订阅有效 \d{4}-\d{2}-\d{2}$/);
    expect(view.tooltip).toContain('plus');
    expect(view.needsConfirmation).toBe(false);
  });

  test('到期日已过，之后确认为 free：已失效', () => {
    const sub = getCodexSubscription(codexRecord({
      planType: 'free', subscriptionActiveUntilMs: NOW - DAY, planConfirmedAtMs: NOW - 60_000
    }), NOW)!;
    expect(sub.status).toBe('lapsed');
    expect(describeCodexSubscription(sub).tone).toBe('danger');
  });

  test('到期日已过，之后没有实时确认：待确认，并提供确认动作', () => {
    const sub = getCodexSubscription(codexRecord({
      planType: 'plus', subscriptionActiveUntilMs: NOW - DAY, planConfirmedAtMs: NOW - 2 * DAY
    }), NOW)!;
    expect(sub.status).toBe('unconfirmed');
    const view = describeCodexSubscription(sub);
    expect(view.needsConfirmation).toBe(true);
    expect(view.tooltip).toContain('确认');
  });

  test('旧快照没有确认时间：到期后视为待确认，而不是已续费', () => {
    const sub = getCodexSubscription(codexRecord({ planType: 'plus', subscriptionActiveUntilMs: NOW - DAY }), NOW)!;
    expect(sub.status).toBe('unconfirmed');
  });
});
