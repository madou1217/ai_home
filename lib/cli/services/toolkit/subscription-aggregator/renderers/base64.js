'use strict';

const { encodeProxyNode } = require('../../proxy-pool/protocol-parsers');

/** 通用分享链接订阅（Shadowrocket、v2rayN 等）：只有节点，不含策略组与分流规则。 */
module.exports = Object.freeze({
  id: 'base64',
  name: '通用 Base64',
  contentType: 'text/plain; charset=utf-8',
  extension: 'txt',
  capabilities: Object.freeze({ rejectInGroups: true, groups: false }),
  compileNode(entry) {
    const uri = encodeProxyNode({ ...entry.node, name: entry.name });
    if (!uri) throw new Error(`unsupported_proxy_uri_export_${entry.node?.protocol || 'empty'}`);
    return uri;
  },
  render(_plan, compiledNodes) {
    return Buffer.from(compiledNodes.join('\n'), 'utf8').toString('base64');
  }
});
