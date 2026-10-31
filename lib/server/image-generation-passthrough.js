'use strict';

const { createImageOutputMissingError } = require('./image-generation-strategy');
const { getNativeImageCapabilities } = require('./image-generation-model-specs');
const {
  createImageApiTransport, createImageBlobFetcher, buildUpstreamUrl, readUpstreamErrorBody, readImageApiUsage
} = require('./image-generation-api-transport');
const { IMAGE_FILE_FIELDS } = require('./image-generation-multipart');
const { REHOSTED_IMAGE } = require('./image-generation-blob-rehost');

// Passthrough strategy: any api-key (apiKeyMode) account whose upstream speaks
// the OpenAI wire protocol. Two codecs share one transport:
//
// - forward (HTTP /v1/images/* entry, `input.passthroughRequestJson` set): the
//   client's own fields go upstream unchanged (minus gateway-only fields), the
//   upstream body comes back unchanged (usage, created, revised_prompt …), and
//   the only rewrite is re-hosting another AIH's private blob urls. The upstream
//   is the authority on parameters, so values the gateway does not know
//   (dall-e-3 quality=hd, style, user, http image refs …) still work.
// - normalized (Image Studio and other internal callers): the canonical request
//   fields are encoded as before and the images are normalized by the executor.
//
// Edits use multipart when every input image carries bytes (data URLs), and the
// JSON edits contract when the client referenced images by http url / file_id.

// 不进上游的字段：provider 是网关的路由参数；stream / partial_images 会让上游改回 SSE，
// 而本入口按 JSON 读响应（流式透传尚未接入）。
const FORWARD_OMITTED_FIELDS = new Set(['provider', 'stream', 'partial_images']);

const IMAGE_FILE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
});

// 部分 OpenAI 兼容中转按文件扩展名判断类型：文件名必须带与字节一致的扩展名。
function imageFileName(stem, mimeType) {
  return `${stem}.${IMAGE_FILE_EXTENSIONS[String(mimeType || '').toLowerCase()] || 'png'}`;
}

function appendImageFile(form, field, image, stem) {
  form.append(
    field,
    new Blob([Buffer.from(image.data, 'base64')], { type: image.mimeType }),
    imageFileName(stem, image.mimeType)
  );
}

function appendImageInputs(form, input) {
  const inputs = Array.isArray(input.images) ? input.images : [];
  const imageField = inputs.length > 1 ? 'image[]' : 'image';
  inputs.forEach((image, index) => appendImageFile(form, imageField, image, `image-${index + 1}`));
  if (input.mask) appendImageFile(form, 'mask', input.mask, 'mask');
}

function appendFormValue(form, key, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item) => appendFormValue(form, key, item));
    return;
  }
  form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
}

function buildNormalizedRequest(input) {
  const {
    mode, model, prompt, n, size, quality, responseFormat, background, outputFormat, outputCompression, moderation
  } = input;
  const commonFields = { model, prompt, n };
  if (size) commonFields.size = size;
  if (quality) commonFields.quality = quality;
  commonFields.response_format = responseFormat || 'b64_json';
  if (background) commonFields.background = background;
  if (outputFormat) commonFields.output_format = outputFormat;
  if (outputCompression != null) commonFields.output_compression = outputCompression;
  if (moderation) commonFields.moderation = moderation;

  if (mode !== 'edit') {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(commonFields) };
  }
  // Produce (never parse) multipart for the upstream edits endpoint.
  // FormData sets its own multipart content-type with boundary.
  const form = new FormData();
  appendImageInputs(form, input);
  Object.entries(commonFields).forEach(([key, value]) => appendFormValue(form, key, value));
  return { headers: {}, body: form };
}

function buildForwardFields(input) {
  const fields = {};
  Object.entries(input.passthroughRequestJson || {}).forEach(([key, value]) => {
    if (value === undefined || FORWARD_OMITTED_FIELDS.has(key)) return;
    fields[key] = value;
  });
  // 别名 / 命名空间前缀解析后的有效模型，而不是客户端写的原名。
  fields.model = input.model;
  return fields;
}

function buildForwardRequest(input) {
  const fields = buildForwardFields(input);
  if (input.mode !== 'edit' || input.passthroughJsonOnly) {
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) };
  }
  const form = new FormData();
  appendImageInputs(form, input);
  Object.entries(fields).forEach(([key, value]) => {
    if (!IMAGE_FILE_FIELDS.has(key)) appendFormValue(form, key, value);
  });
  return { headers: {}, body: form };
}

function hasImagePayload(item) {
  return Boolean(item && typeof item === 'object'
    && (String(item.b64_json || '').trim() || String(item.url || '').trim()));
}

function toImageEntries(data) {
  return data.map((item) => ({
    ...(item && typeof item === 'object' ? item : {}),
    ...(item && item.b64_json ? { b64_json: String(item.b64_json) } : {}),
    ...(item && item.url ? { url: String(item.url) } : {})
  }));
}

async function rehostUpstreamBlob(input, item, fetchBlob) {
  if (!item || typeof item !== 'object' || typeof item.url !== 'string') return item;
  try {
    const blob = await fetchBlob(input, item.url);
    return blob ? { ...item, [REHOSTED_IMAGE]: blob } : item;
  } catch (error) {
    // 图已经生成（额度已花掉）：取回失败不该把整次请求判失败、更不该换号重生成。
    // 原样交回上游链接，并留下可排查的痕迹。
    console.warn(`[aih] image passthrough: upstream blob rehost failed (${String(error && error.message || error)})`);
    return item;
  }
}

function createPassthroughImageGenerationStrategy(deps = {}) {
  const transport = createImageApiTransport(deps);
  const fetchBlob = createImageBlobFetcher(deps);
  return {
    provider: 'passthrough',
    kind: 'passthrough',
    capabilities: getNativeImageCapabilities('passthrough'),
    // The upstream endpoint is the authority on which models it can serve.
    supportsModel() {
      return true;
    },
    async generate(input) {
      const forward = Boolean(input.passthroughRequestJson && typeof input.passthroughRequestJson === 'object');
      const json = await transport(input, forward ? buildForwardRequest(input) : buildNormalizedRequest(input));
      const data = Array.isArray(json && json.data) ? json.data : [];
      // 透传口径跳过执行器的严格规范化，所以「有条目但没有图」也要在这里判成空产出。
      if (data.length === 0 || (forward && !data.some(hasImagePayload))) {
        throw createImageOutputMissingError('upstream returned no image data');
      }
      const usageInput = readImageApiUsage(json, input.model);
      if (!forward) return { images: toImageEntries(data), usageInput, raw: json };

      const rehostedData = await Promise.all(data.map((item) => rehostUpstreamBlob(input, item, fetchBlob)));
      return {
        images: toImageEntries(data),
        usageInput,
        raw: json,
        // 入口直接渲染这份上游原体（见 image-generations-endpoint），执行器不再做严格规范化。
        passthroughBody: { ...json, data: rehostedData }
      };
    }
  };
}

module.exports = {
  createPassthroughImageGenerationStrategy,
  __private: {
    FORWARD_OMITTED_FIELDS,
    buildForwardFields,
    buildForwardRequest,
    buildNormalizedRequest,
    buildUpstreamUrl,
    imageFileName,
    readUpstreamErrorBody
  }
};
