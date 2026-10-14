'use strict';

const base64 = require('./base64');
const clashClassic = require('./clash');
const egern = require('./egern');
const json = require('./json');
const loon = require('./loon');
const mihomo = require('./mihomo');
const quantumultX = require('./quantumult-x');
const singBox = require('./sing-box');
const stash = require('./stash');
const surfboard = require('./surfboard');
const surge = require('./surge');
const uri = require('./uri');

/**
 * 输出格式渲染器注册表（Strategy）。契约：
 * - id / name / contentType / extension
 * - capabilities: { rejectInGroups, groups, protocols?, ruleSetFormat?, sanitizeName? }
 *   rejectInGroups / groups 影响聚合规划；ruleSetFormat 表示规则集由 AIH 转换后提供
 *   （见 rule-set-converter）；sanitizeName 在规划前清洗节点名（分隔符等）。
 * - compileNode(entry, context) → 该格式的节点表示，抛错即跳过该节点
 * - render(plan, compiledNodes, context) → 订阅正文；context 见 render-context
 */
const RENDERERS = Object.freeze([
  mihomo, clashClassic, stash, singBox, surge, surfboard, loon, quantumultX, egern, base64, uri, json
]);
const RENDERER_BY_ID = new Map(RENDERERS.map((renderer) => [renderer.id, renderer]));
const TARGET_ALIASES = new Map([
  ['clash', 'mihomo'],
  ['clash-meta', 'mihomo'],
  ['meta', 'mihomo'],
  ['singbox', 'sing-box'],
  ['qx', 'quantumult-x'],
  ['quantumultx', 'quantumult-x'],
  ['clash-premium', 'clash-classic'],
  ['v2ray', 'base64'],
  ['v2rayn', 'base64'],
  ['shadowrocket', 'base64']
]);

function getRenderer(target) {
  const id = String(target || '').trim().toLowerCase();
  return RENDERER_BY_ID.get(TARGET_ALIASES.get(id) || id) || null;
}

// 客户端拉订阅时通常不带格式参数，按 User-Agent 认出客户端（见 client-profiles）；认不出时给 mihomo。
function detectRendererByUserAgent(userAgent) {
  return getRenderer(require('../client-profiles').detectClient(userAgent).target) || mihomo;
}

function describeRenderers() {
  return RENDERERS.map((renderer) => ({
    id: renderer.id,
    name: renderer.name,
    extension: renderer.extension,
    groups: renderer.capabilities.groups,
    // 界面上给这个格式的补充说明（例如全协议目标需要 Meta 系内核）。
    ...(renderer.note ? { note: renderer.note } : {})
  }));
}

module.exports = {
  RENDERERS,
  describeRenderers,
  detectRendererByUserAgent,
  getRenderer
};
