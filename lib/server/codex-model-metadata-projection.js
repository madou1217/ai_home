'use strict';

function getModelFamily(modelId) {
  const match = String(modelId || '').trim().match(/^(gpt-\d+(?:\.\d+)?)(?:-|$)/i);
  return match ? match[1].toLowerCase() : '';
}

function cloneModelMetadata(template, modelId) {
  const source = template && typeof template === 'object' ? template : {};
  return {
    ...source,
    slug: modelId,
    display_name: modelId,
    description: `AIH gateway model ${modelId}`,
    // These fields are required by the Codex ModelInfo wire contract. They are
    // conservative relay defaults when an account's catalog contains only an
    // ID or when the ID was discovered on a different account.
    base_instructions: typeof source.base_instructions === 'string'
      ? source.base_instructions
      : 'You are a coding agent. Follow the user instructions and use the available tools to complete the task safely and accurately.',
    shell_type: typeof source.shell_type === 'string' ? source.shell_type : 'shell_command',
    visibility: typeof source.visibility === 'string' ? source.visibility : 'list',
    supported_in_api: source.supported_in_api !== false,
    supported_reasoning_levels: Array.isArray(source.supported_reasoning_levels)
      ? source.supported_reasoning_levels
      : [],
    availability_nux: null,
    upgrade: null
  };
}

function projectCodexModelCatalog(modelIds, sourceModels) {
  const models = Array.isArray(sourceModels) ? sourceModels : [];
  const bySlug = new Map();
  models.forEach((model) => {
    const slug = String(model && model.slug || '').trim();
    if (slug && !bySlug.has(slug)) bySlug.set(slug, model);
  });

  const projected = [];
  const seen = new Set();
  (Array.isArray(modelIds) ? modelIds : []).forEach((modelIdRaw) => {
    const modelId = String(modelIdRaw || '').trim();
    if (!modelId || seen.has(modelId)) return;
    const exact = bySlug.get(modelId);
    if (exact) {
      projected.push(exact);
      seen.add(modelId);
      return;
    }
    const family = getModelFamily(modelId);
    const template = (family && models.find((model) => getModelFamily(model && model.slug) === family))
      || models[0]
      || null;
    projected.push(cloneModelMetadata(template, modelId));
    seen.add(modelId);
  });
  return projected;
}

module.exports = {
  cloneModelMetadata,
  getModelFamily,
  projectCodexModelCatalog
};
