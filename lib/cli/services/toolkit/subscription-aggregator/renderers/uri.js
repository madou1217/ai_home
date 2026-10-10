'use strict';

const base64 = require('./base64');

/** 纯文本分享链接列表（每行一个、不做 base64），给能直接读链接列表的客户端或脚本。 */
module.exports = Object.freeze({
  id: 'uri',
  name: '分享链接列表',
  contentType: 'text/plain; charset=utf-8',
  extension: 'txt',
  capabilities: Object.freeze({ rejectInGroups: true, groups: false }),
  compileNode: base64.compileNode,
  render(_plan, links) {
    return links.length ? `${links.join('\n')}\n` : '';
  }
});
