import type { ComposerCatalog, SessionProjection } from '@/chat-runtime';

export interface ComposerModelSelection {
  readonly model: string;
  readonly effort: string;
}

export function resolveComposerModelSelection(
  catalog: ComposerCatalog,
  requestedModel: string,
  requestedEffort: string,
): ComposerModelSelection {
  const model = catalog.models.find((entry) => entry.id === requestedModel)
    || catalog.models.find((entry) => entry.id === catalog.defaultModel)
    || catalog.models[0];
  if (!model) return { model: '', effort: '' };
  const effort = model.supportedEfforts.includes(requestedEffort)
    ? requestedEffort
    : model.defaultEffort;
  return { model: model.id, effort };
}

// 会话最后一条 assistant 消息实际使用的模型（时间线条目 detail.model）；没有则为空串。
export function selectLastAssistantModel(projection: SessionProjection): string {
  const items = projection.items || [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind !== 'message' || item.detail.role !== 'assistant') continue;
    const model = String(item.detail.model || '').trim();
    if (model) return model;
  }
  return '';
}

// 打开会话 / 切换账号时的默认模型：
//   1. 会话最后一条消息实际用的模型——前提是当前账号的可选模型里有它；
//   2. 否则当前账号的默认模型；
//   3. 再否则账号第一个可选模型（目录为空返回空串，交给 loading/empty 兜底）。
export function resolveSessionDefaultModel(catalog: ComposerCatalog, lastUsedModel: string): string {
  const ids = catalog.models.map((entry) => entry.id);
  if (lastUsedModel && ids.includes(lastUsedModel)) return lastUsedModel;
  if (catalog.defaultModel && ids.includes(catalog.defaultModel)) return catalog.defaultModel;
  return ids[0] || '';
}
