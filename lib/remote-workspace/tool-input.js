'use strict';

// Minimal write contract validation shared by all remote-tool adapters. This
// runs before workspace/auth resolution, not only inside the file writer.
function validateRemoteToolInput(name, args) {
  if (name !== 'write_file') return null;
  if (!args || typeof args !== 'object' || !Object.prototype.hasOwnProperty.call(args, 'expected_version')
    || typeof args.expected_version !== 'string') {
    return { isError: true, content: [{ type: 'text', text: '[invalid_expected_version] expected_version 必须提供字符串；新建文件传空字符串' }] };
  }
  if (typeof args.path !== 'string' || typeof args.content !== 'string') {
    return { isError: true, content: [{ type: 'text', text: '[invalid_write_arguments] path 和 content 必须为字符串' }] };
  }
  return null;
}

module.exports = { validateRemoteToolInput };
