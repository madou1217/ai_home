'use strict';

/**
 * RoutingManager: Rule-based traffic dispatching engine.
 * Modes:
 * - 'global': All outbound traffic routes through the selected active proxy node.
 * - 'direct': All outbound traffic connects directly.
 * - 'rule': Evaluates domain / regex / keyword matching against rule sets.
 */

const DEFAULT_AI_DOMAINS = [
  'openai.com',
  'ai.com',
  'chatgpt.com',
  'oaistatic.com',
  'oaiusercontent.com',
  'anthropic.com',
  'claude.ai',
  'generativelanguage.googleapis.com',
  'googleapis.com',
  'x.ai',
  'grok.com',
  'moonshot.cn',
  'kimi.moonshot.cn'
];

const DEFAULT_DEV_DOMAINS = [
  'github.com',
  'githubusercontent.com',
  'githubassets.com',
  'huggingface.co',
  'hf.co',
  'docker.com',
  'docker.io',
  'npmjs.org',
  'npmjs.com'
];

const DEFAULT_DIRECT_DOMAINS = [
  'cn',
  'aliyun.com',
  'tencent.com',
  'baidu.com',
  'taobao.com',
  'jd.com',
  'tsinghua.edu.cn',
  'ustc.edu.cn'
];

class RoutingManager {
  constructor(nodeStore) {
    this.nodeStore = nodeStore;
  }

  getRoutingState() {
    const config = this.nodeStore.getRoutingConfig();
    return {
      mode: config.mode || 'rule',
      activeOutboundNodeId: config.activeOutboundNodeId || null,
      rules: config.rules || []
    };
  }

  setRoutingMode(mode, activeOutboundNodeId = null) {
    const validModes = ['global', 'rule', 'direct'];
    if (!validModes.includes(mode)) {
      throw new Error(`invalid_routing_mode_${mode}`);
    }
    return this.nodeStore.setRoutingConfig({
      mode,
      activeOutboundNodeId
    });
  }

  updateRules(rules) {
    return this.nodeStore.setRoutingConfig({
      rules
    });
  }

  /**
   * Resolve which outbound should be used for a given target domain or host
   */
  resolveOutbound(targetHost) {
    const config = this.getRoutingState();
    if (config.mode === 'direct') {
      return { outbound: 'direct', nodeId: null, matchedRule: null };
    }
    if (config.mode === 'global') {
      return { outbound: 'proxy', nodeId: config.activeOutboundNodeId, matchedRule: 'global' };
    }

    // Rule mode
    const host = String(targetHost || '').toLowerCase();
    for (const rule of config.rules) {
      const domains = rule.domains || [];
      const match = domains.some((d) => {
        if (d.startsWith('.')) return host.endsWith(d) || host === d.slice(1);
        return host === d || host.endsWith('.' + d);
      });
      if (match) {
        return {
          outbound: rule.outbound || 'proxy',
          nodeId: rule.outbound === 'proxy' ? (rule.nodeId || config.activeOutboundNodeId) : null,
          matchedRule: rule.name || rule.id
        };
      }
    }

    // Default fallback
    return { outbound: 'proxy', nodeId: config.activeOutboundNodeId, matchedRule: 'final' };
  }
}

module.exports = {
  RoutingManager,
  DEFAULT_AI_DOMAINS,
  DEFAULT_DEV_DOMAINS,
  DEFAULT_DIRECT_DOMAINS
};
