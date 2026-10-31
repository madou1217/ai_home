'use strict';

const { putImageBlob } = require('./image-blob-store');

// 上游是另一台 AIH 时，response_format=url 拿到的链接是**那台 AIH 自己的** `/v1/blobs/<id>`：
// 取它要那台 AIH 的客户端密钥，字节也只活在它的内存里，原样交给下游客户端就是一条打不开的链接。
//
// 分工：透传策略持有账号凭据，负责把字节取回来（只认账号上游同主机的 blob 链接，取的 URL 由
// 账号自己的上游 base 拼出，凭据绝不会发往响应里给出的任意地址），挂在条目的 REHOSTED_IMAGE
// 上；入口持有本网关的对外地址，渲染时把字节放进本网关的 blob 存储、改写成本网关的链接。
//
// 标记用 Symbol 键：JSON 序列化会丢掉它。没处理标记的调用方只会看到上游的原始链接，
// 取回的字节不会意外出现在响应体里。

const REHOSTED_IMAGE = Symbol('aih.image.rehosted');

// AIH 渲染 blob 链接的固定形状（image-generations-endpoint 的 `${baseUrl}/v1/blobs/${id}`，
// id 是 sha256 的前 32 位十六进制，见 image-blob-store）。
const AIH_BLOB_PATH_PATTERN = /^\/v1\/blobs\/([0-9a-f]{32})$/i;

function readHostname(value) {
  try {
    return new URL(String(value || '')).hostname.toLowerCase();
  } catch (_error) {
    return '';
  }
}

/**
 * 响应里的链接是不是「本账号上游那台 AIH」的 blob：是就返回 blob id，否则返回 ''。
 * 只比较主机名：对端渲染链接用的是它收到的 Host 头，协议总是 http，端口/前缀不可信；
 * 真正去取的 URL 由账号的 base 拼出，所以这里只需要确认「指的是同一台机器上的 blob」。
 */
function resolveUpstreamBlobId(value, upstreamBase) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch (_error) {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
  const baseHostname = readHostname(upstreamBase);
  if (!baseHostname || url.hostname.toLowerCase() !== baseHostname) return '';
  const match = AIH_BLOB_PATH_PATTERN.exec(url.pathname);
  return match ? match[1].toLowerCase() : '';
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
  resolveUpstreamBlobId
};
