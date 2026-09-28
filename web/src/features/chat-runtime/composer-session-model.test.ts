import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComposerCatalog, SessionProjection } from '@/chat-runtime';
import { resolveSessionDefaultModel, selectLastAssistantModel } from './composer-model-policy';

const catalog = (ids: string[], defaultModel: string) => ({
  models: ids.map((id) => ({ id, label: id, supportedEfforts: [], defaultEffort: '' })),
  defaultModel,
}) as unknown as ComposerCatalog;

const projection = (items: unknown[]) => ({ items }) as unknown as SessionProjection;

test('last assistant message model wins when the account can serve it', () => {
  const items = [
    { kind: 'message', detail: { role: 'assistant', model: 'claude-opus-4-6-thinking' } },
    { kind: 'message', detail: { role: 'user' } },
    { kind: 'message', detail: { role: 'assistant', model: 'gemini-3.8-flash-high' } },
    { kind: 'reasoning', detail: {} },
  ];
  const last = selectLastAssistantModel(projection(items));
  assert.equal(last, 'gemini-3.8-flash-high');
  assert.equal(
    resolveSessionDefaultModel(catalog(['claude-opus-4-6-thinking', 'gemini-3.8-flash-high'], 'claude-opus-4-6-thinking'), last),
    'gemini-3.8-flash-high',
  );
});

test('falls back to the account default when the account lacks the last model', () => {
  assert.equal(resolveSessionDefaultModel(catalog(['gpt-5.6-sol', 'gpt-5.5'], 'gpt-5.5'), 'gemini-3.8-flash-high'), 'gpt-5.5');
  assert.equal(resolveSessionDefaultModel(catalog(['gpt-5.6-sol'], 'missing'), ''), 'gpt-5.6-sol');
  assert.equal(resolveSessionDefaultModel(catalog([], ''), 'x'), '');
  assert.equal(selectLastAssistantModel(projection([])), '');
  assert.equal(selectLastAssistantModel({} as SessionProjection), '');
});
