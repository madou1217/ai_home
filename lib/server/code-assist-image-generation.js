'use strict';

// Image-generation concern for code-assist (agy/antigravity) models such as
// `gemini-3.1-flash-image`. Those models return the picture as an `inlineData`
// (base64) part instead of `text`, and require the request to opt into the
// IMAGE response modality. This module keeps that concern isolated so the
// generic request/response adapters stay text-focused.

const IMAGE_MODEL_PATTERN = /(?:^|[-_/])image(?:$|[-_])|nano-?banana|flash-image/i;

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase();
}

// Only gemini image-generation models emit inlineData image parts. Match the
// public `-image` family (e.g. gemini-3.1-flash-image) plus the "nano banana"
// alias, without matching image-input-capable text models.
function isImageGenerationModel(model) {
  const name = normalizeModelName(model);
  if (!name) return false;
  return IMAGE_MODEL_PATTERN.test(name);
}

// Image-generation models reject/ignore thinking and require the IMAGE
// modality to actually return a picture. Thinking config, if left in, makes the
// model narrate instead of drawing (observed: only reasoning_content, empty
// image), so it is stripped for these models.
function applyImageGenerationGenerationConfig(generationConfig, model) {
  if (!isImageGenerationModel(model)) return generationConfig;
  const next = generationConfig && typeof generationConfig === 'object' ? generationConfig : {};
  next.responseModalities = ['TEXT', 'IMAGE'];
  delete next.thinkingConfig;
  return next;
}

function readInlineData(part) {
  if (!part || typeof part !== 'object') return null;
  const inline = part.inlineData || part.inline_data;
  if (!inline || typeof inline !== 'object') return null;
  const data = String(inline.data || '').trim();
  if (!data) return null;
  const mimeType = String(inline.mimeType || inline.mime_type || 'image/png').trim() || 'image/png';
  return { mimeType, data };
}

function inlineDataToDataUrl(inline) {
  if (!inline) return '';
  return `data:${inline.mimeType};base64,${inline.data}`;
}

// Render inlineData image parts as markdown images so they flow through the
// existing text/markdown rendering path in the webUI without a new content
// channel. Returns '' when there are no image parts.
function extractInlineImageMarkdown(parts, options = {}) {
  const list = Array.isArray(parts) ? parts : [];
  const alt = String(options.alt || '生成的图片').trim() || 'image';
  const pieces = [];
  list.forEach((part) => {
    const inline = readInlineData(part);
    if (inline) pieces.push(`![${alt}](${inlineDataToDataUrl(inline)})`);
  });
  return pieces.join('\n\n');
}

function hasInlineImagePart(parts) {
  return (Array.isArray(parts) ? parts : []).some((part) => readInlineData(part) !== null);
}

module.exports = {
  isImageGenerationModel,
  applyImageGenerationGenerationConfig,
  extractInlineImageMarkdown,
  hasInlineImagePart,
  __private: {
    readInlineData,
    inlineDataToDataUrl
  }
};
