'use strict';

const { putImageBlob } = require('./image-blob-store');

// 上游以 url 回图、而链接落在**上游自己的源**（与账号 base 同 scheme / host / port）时，
// 这条链接通常只对持有上游凭据、或能直连上游的调用方有效（鉴权的文件端点、只在上游
// 网络里可达的地址……）。客户端手里只有本网关的密钥，原样转交就是一条打不开的链接。
// 与上游不同源的链接（CDN、签名直链）本来就是公开的，原样透传。不识别任何特定上游实现。
//
// 分工：透传策略持有账号凭据，负责取回同源链接的字节（凭据只发往账号自己的上游源），
// 挂在条目的 REHOSTED_IMAGE 上；入口持有本网关的对外地址，渲染时把字节放进本网关的
// blob 存储、改写成本网关的链接。
//
// 标记用 Symbol 键：JSON 序列化会丢掉它。没处理标记的调用方只会看到上游的原始链接，
// 取回的字节不会意外出现在响应体里。

const REHOSTED_IMAGE = Symbol('aih.image.rehosted');

function readHttpOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch (_error) {
    return '';
  }
}

/** 链接与账号上游同源时返回规范化后的链接，否则返回 ''（不取回、原样透传）。 */
function resolveUpstreamOriginUrl(value, upstreamBase) {
  const origin = readHttpOrigin(value);
  if (!origin || origin !== readHttpOrigin(upstreamBase)) return '';
  return new URL(String(value).trim()).toString();
}

/**
 * 把透传响应体里带 REHOSTED_IMAGE 标记的条目落进本网关的 blob 存储，链接改写成
 * `${baseUrl}/v1/blobs/<id>`（与本网关自己渲染 url 的口径一致）。其余字段原样保留。
 */
function materializeRehostedImages(body, baseUrl) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.data)) return body;
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    ...body,
    data: body.data.map((item) => {
      const rehosted = item && typeof item === 'object' ? item[REHOSTED_IMAGE] : null;
      if (!rehosted) return item;
      const { [REHOSTED_IMAGE]: _rehosted, ...rest } = item;
      if (!base) return rest;
      const id = putImageBlob(rehosted.bytes, rehosted.mimeType);
      return { ...rest, url: `${base}/v1/blobs/${id}` };
    })
  };
}

module.exports = {
  REHOSTED_IMAGE,
  materializeRehostedImages,
  resolveUpstreamOriginUrl
};
