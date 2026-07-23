'use strict';

function getModelFamily(modelId) {
  const match = String(modelId || '').trim().match(/^(gpt-\d+(?:\.\d+)?)(?:-|$)/i);
  return match ? match[1].toLowerCase() : '';
}

function cloneModelMetadata(template, modelId) {
  return {
    ...template,
    slug: modelId,
    display_name: modelId,
    description: `AIH gateway model ${modelId}`,
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
    if (!family) return;
    const template = models.find((model) => getModelFamily(model && model.slug) === family);
    if (!template || typeof template.base_instructions !== 'string') return;
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
