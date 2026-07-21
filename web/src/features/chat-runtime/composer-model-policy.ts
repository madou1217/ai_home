import type { ComposerCatalog } from '@/chat-runtime';

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
