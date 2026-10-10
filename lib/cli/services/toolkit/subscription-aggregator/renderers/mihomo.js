'use strict';

const { createClashFamilyRenderer } = require('./clash-family');

/** Clash Meta / mihomo 完整配置（Clash Verge Rev、Mihomo Party、FlClash 等）：规则集用 .mrs。 */
module.exports = createClashFamilyRenderer({
  id: 'mihomo',
  name: 'Clash Meta / mihomo',
  ruleSetFile: 'mihomo',
  ruleSetFormat: 'mrs',
  extraConfig: { 'unified-delay': true, 'tcp-concurrent': true }
});
