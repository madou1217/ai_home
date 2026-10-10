'use strict';

const base64 = require('./base64');
const loon = require('./loon');
const mihomo = require('./mihomo');
const singBox = require('./sing-box');
const surfboard = require('./surfboard');
const surge = require('./surge');

/**
 * 输出格式渲染器注册表（Strategy）。契约：
 * - id / name / contentType / extension
 * - capabilities: { rejectInGroups, groups, protocols?, ruleSetFormat?, sanitizeName? }
 *   rejectInGroups / groups 影响聚合规划；ruleSetFormat 表示规则集由 AIH 转换后提供
 *   （见 rule-set-converter）；sanitizeName 在规划前清洗节点名（分隔符等）。
 * - compileNode(entry, context) → 该格式的节点表示，抛错即跳过该节点
 * - render(plan, compiledNodes, context) → 订阅正文；context 见 render-context
 */
const RENDERERS = Object.freeze([mihomo, singBox, surge, surfboard, loon, base64]);
const RENDERER_BY_ID = new Map(RENDERERS.map((renderer) => [renderer.id, renderer]));
const TARGET_ALIASES = new Map([
  ['clash', 'mihomo'],
  ['clash-meta', 'mihomo'],
  ['meta', 'mihomo'],
  ['singbox', 'sing-box'],
  ['v2ray', 'base64'],
  ['uri', 'base64']
]);

function getRenderer(target) {
  const id = String(target || '').trim().toLowerCase();
  return RENDERER_BY_ID.get(TARGET_ALIASES.get(id) || id) || null;
}

// 客户端拉订阅时通常不带格式参数，按 User-Agent 推断；认不出时给 mihomo。
function detectRendererByUserAgent(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (/sing-box|sfi|sfa|sfm|sft|hiddify|karing/.test(ua)) return singBox;
  if (/surfboard/.test(ua)) return surfboard;
  if (/surge/.test(ua)) return surge;
  if (/loon/.test(ua)) return loon;
  if (/shadowrocket|v2ray|quantumult|passwall|ssrplus/.test(ua)) return base64;
  return mihomo;
}

function describeRenderers() {
  return RENDERERS.map((renderer) => ({
    id: renderer.id,
    name: renderer.name,
    extension: renderer.extension,
    groups: renderer.capabilities.groups
  }));
}

module.exports = {
  RENDERERS,
  describeRenderers,
  detectRendererByUserAgent,
  getRenderer
};
