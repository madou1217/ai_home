'use strict';

const KNOWN_ZCODE_MODELS = [
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  'glm-4-plus',
  'glm-4-air',
  'glm-4-flash',
  'glm-4',
  'codegeex-4',
];

function isKnownZcodeModel(modelId) {
  if (!modelId) return false;
  const stripped = String(modelId).toLowerCase().replace(/^zcode\//, '').replace(/^zhipu\//, '').replace(/^zhipuai\//, '');
  return KNOWN_ZCODE_MODELS.includes(stripped) || stripped.startsWith('glm-');
}

module.exports = {
  KNOWN_ZCODE_MODELS,
  isKnownZcodeModel,
};
