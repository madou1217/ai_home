'use strict';

const { REHOSTED_IMAGE } = require('./image-generation-blob-rehost');
const { ImageGenerationError } = require('./image-generation-strategy');

// 客户端要流式（stream: true）时，把一次已完成的生图结果按 OpenAI Images 流式协议渲染成 SSE。
//
// 上游一律按非流式执行（透传口径剥掉 stream / partial_images，原生策略本来就不流式），所以只发
// 「完成」事件、不发 partial_image 预览：partial_images 只是「最多」几张预览（官方文档：最终图
// 可能先于预览数量出来），没有预览的流是合法流。代价是首个事件要等整张图出来；好处是失败仍在
// 发出任何字节之前发生 —— 换号、HTTP 错误码与非流式完全一致，客户端拿到的仍是它要的 SSE 帧。
//
// 事件：生成 image_generation.completed / 编辑 image_edit.completed，每张图一个，字段
// b64_json、created_at、size、quality、background、output_format；最后一个事件带 usage
// （上游给了 OpenAI 形状的用量时）。流式事件只承载 base64：上游只给了公开链接（与上游不同源，
// 网关不取回）的图，以 url 字段放进同一事件，不伪造 base64。

const EVENT_PREFIX = Object.freeze({ generation: 'image_generation', edit: 'image_edit' });
const MIME_OUTPUT_FORMAT = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' });

// 客户端是否要求流式响应。JSON 体里是布尔 true；multipart/form-data（images.edit 走这条）
// 的表单字段只能是文本，归一化后是字符串 "true"，两种都认。
function isImageStreamRequest(requestJson) {
  if (!requestJson || typeof requestJson !== 'object') return false;
  const value = requestJson.stream;
  if (value === true) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// 透传结果给的是上游原体（含被取回的同源图片字节）；网关自己的结果给的是规范化后的图片。
function readStreamItems(result) {
  if (result && result.passthroughBody && Array.isArray(result.passthroughBody.data)) {
    return result.passthroughBody.data.map((item) => {
      const entry = item && typeof item === 'object' ? item : {};
      const rehosted = entry[REHOSTED_IMAGE];
      if (rehosted && rehosted.bytes) {
        return { b64_json: Buffer.from(rehosted.bytes).toString('base64'), mimeType: rehosted.mimeType };
      }
      return { b64_json: readText(entry.b64_json), url: readText(entry.url) };
    });
  }
  return (result && Array.isArray(result.images) ? result.images : []).map((item) => ({
    b64_json: readText(item && item.b64_json),
    url: readText(item && item.url),
    mimeType: readText(item && item.mimeType)
  }));
}

function readStreamUsage(result) {
  const body = result && result.passthroughBody;
  if (body && body.usage && typeof body.usage === 'object') return body.usage;
  const usageInput = result && result.usageInput;
  return usageInput && usageInput.usageFormat === '' && usageInput.usage && typeof usageInput.usage === 'object'
    ? usageInput.usage
    : null;
}

/**
 * 把完成的结果变成按顺序发送的事件对象。
 * @param {object} result 策略结果（images / passthroughBody / usageInput）
 * @param {{mode?: string, size?: string, quality?: string, background?: string, outputFormat?: string}} request
 * @param {{nowSeconds?: number, requestJson?: object}} [options] requestJson 是客户端原始请求，
 *   透传口径的宽松解析不保留 size / quality 等字段，事件字段以上游回显 → 解析结果 → 原始请求为序。
 */
function buildImageStreamEvents(result, request = {}, options = {}) {
  const type = `${EVENT_PREFIX[request.mode] || EVENT_PREFIX.generation}.completed`;
  const body = result && result.passthroughBody && typeof result.passthroughBody === 'object'
    ? result.passthroughBody
    : {};
  const raw = options.requestJson && typeof options.requestJson === 'object' ? options.requestJson : {};
  const pick = (bodyKey, requestKey, rawKey) => readText(body[bodyKey]) || readText(request[requestKey])
    || readText(raw[rawKey]);
  const createdAt = Number.isInteger(body.created) && body.created > 0
    ? body.created
    : Math.floor(Number(options.nowSeconds) || Date.now() / 1000);
  const items = readStreamItems(result).filter((item) => item.b64_json || item.url);
  if (items.length === 0) {
    // 零图不能在写出任何字节之后再暴露：那会变成「流开起来但永远没有完成事件」。
    // 与非流式保持同一语义，在写头之前就失败。
    throw new ImageGenerationError(502, 'invalid_image_output', 'image generation returned no images');
  }
  const usage = readStreamUsage(result);
  return items.map((item) => ({
    type,
    ...(item.b64_json ? { b64_json: item.b64_json } : { url: item.url }),
    created_at: createdAt,
    size: pick('size', 'size', 'size') || 'auto',
    quality: pick('quality', 'quality', 'quality') || 'auto',
    background: pick('background', 'background', 'background') || 'auto',
    output_format: pick('output_format', 'outputFormat', 'output_format')
      || MIME_OUTPUT_FORMAT[String(item.mimeType || '').toLowerCase()] || 'png',
    // 完成事件的 usage 是每个事件自带的字段，不是只在最后一个上。
    ...(usage ? { usage } : {})
  }));
}

/** 写出 SSE 响应（调用方已设置好与非流式相同的路由诊断头）。 */
function writeImageStream(res, events) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  // SSE 不能被前置反代（本项目 webui/nginx 场景）整段缓冲。
  res.setHeader('x-accel-buffering', 'no');
  res.setHeader('connection', 'keep-alive');
  (Array.isArray(events) ? events : []).forEach((event) => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  res.end();
}

module.exports = {
  buildImageStreamEvents,
  isImageStreamRequest,
  writeImageStream
};
