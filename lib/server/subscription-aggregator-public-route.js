'use strict';

const {
  getSubscriptionAggregatorService
} = require('../cli/services/toolkit/subscription-aggregator/aggregator-service');

const PUBLIC_PREFIX = '/sub/';

function writePlain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/**
 * 聚合订阅的公开拉取入口：GET /sub/<token>[?target=mihomo|sing-box|base64]。
 * Clash/sing-box 等客户端拉订阅不会带 Management Key，凭据就是链接里的随机 token；
 * 未知 token 一律 404，不区分"不存在"与"已重置"。
 */
async function handleAggregatedSubscriptionRequest({ req, res, method, pathname, url, service }) {
  if (!pathname.startsWith(PUBLIC_PREFIX)) return false;
  if (method !== 'GET' && method !== 'HEAD') {
    writePlain(res, 405, 'method not allowed');
    return true;
  }
  const token = pathname.slice(PUBLIC_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
    writePlain(res, 404, 'not found');
    return true;
  }
  const aggregator = service || getSubscriptionAggregatorService();
  try {
    const result = await aggregator.serveSubscription(token, {
      target: url?.searchParams?.get('target') || url?.searchParams?.get('format') || '',
      userAgent: req.headers?.['user-agent'] || ''
    });
    if (!result.ok) {
      writePlain(res, result.status || 404, result.status === 400 ? 'unsupported target' : 'not found');
      return true;
    }
    res.writeHead(result.status, result.headers);
    res.end(method === 'HEAD' ? undefined : result.body);
  } catch (error) {
    writePlain(res, 500, `subscription render failed: ${error.code || 'internal_error'}`);
  }
  return true;
}

module.exports = {
  PUBLIC_PREFIX,
  handleAggregatedSubscriptionRequest
};
