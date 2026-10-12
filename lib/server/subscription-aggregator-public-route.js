'use strict';

const {
  getSubscriptionAggregatorService
} = require('../cli/services/toolkit/subscription-aggregator/aggregator-service');
const { requestOrigin } = require('../cli/services/toolkit/subscription-aggregator/render-context');

const PUBLIC_PREFIX = '/sub/';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const RULE_SET_PATH = /^([A-Za-z0-9_-]{16,128})\/rules\/((?:geosite|geoip)-[A-Za-z0-9@._-]{1,128})$/;

function writePlain(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readTarget(url) {
  return url?.searchParams?.get('target') || url?.searchParams?.get('format') || '';
}

function respond(res, method, result) {
  if (!result.ok) {
    writePlain(res, result.status || 404, result.status === 400 ? 'unsupported target' : 'not found');
    return;
  }
  res.writeHead(result.status, result.headers);
  res.end(method === 'HEAD' ? undefined : result.body);
}

/**
 * 聚合订阅的公开拉取入口：GET /sub/<token>[?target=<格式>]；
 * 规则集转换：GET /sub/<token>/rules/<标签>?target=<格式>（Surge / Loon / QX 等用）。
 * Clash/sing-box 等客户端拉订阅不会带 Management Key，凭据就是链接里的随机 token；
 * 未知 token 一律 404，不区分"不存在"与"已重置"。
 */
async function handleAggregatedSubscriptionRequest({ req, res, method, pathname, url, service }) {
  if (!pathname.startsWith(PUBLIC_PREFIX)) return false;
  if (method !== 'GET' && method !== 'HEAD') {
    writePlain(res, 405, 'method not allowed');
    return true;
  }
  const rest = pathname.slice(PUBLIC_PREFIX.length);
  const ruleSetMatch = RULE_SET_PATH.exec(rest);
  if (!ruleSetMatch && !TOKEN_PATTERN.test(rest)) {
    writePlain(res, 404, 'not found');
    return true;
  }
  const aggregator = service || getSubscriptionAggregatorService();
  const request = {
    target: readTarget(url),
    view: url?.searchParams?.get('view') || '',
    userAgent: req.headers?.['user-agent'] || '',
    origin: requestOrigin(req)
  };
  try {
    respond(res, method, ruleSetMatch
      ? await aggregator.serveRuleSet(ruleSetMatch[1], ruleSetMatch[2], request)
      : await aggregator.serveSubscription(rest, request));
  } catch (error) {
    writePlain(res, 500, `subscription render failed: ${error.code || 'internal_error'}`);
  }
  return true;
}

module.exports = {
  PUBLIC_PREFIX,
  handleAggregatedSubscriptionRequest
};
