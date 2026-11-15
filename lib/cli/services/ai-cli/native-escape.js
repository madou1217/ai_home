'use strict';

// Parse only the AIH-owned prefix. Tokens after the first marker belong to the
// official CLI, even when they look like an AIH action, account ID or flag.
function parseNativeEscape(args = []) {
  const tokens = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const index = tokens.indexOf('--', 1);
  if (index < 0) return { escaped: false, args: tokens };
  const prefix = tokens.slice(0, index);
  const selector = prefix[1];
  const hasSelector = /^(?:\d+|acct_[a-f0-9]{20}|\.aih-server)$/.test(selector || '');
  return {
    escaped: true,
    args: [...prefix, ...tokens.slice(index + 1)],
    accountSelector: hasSelector ? selector : '',
    nativeArgs: [...prefix.slice(hasSelector ? 2 : 1), ...tokens.slice(index + 1)]
  };
}

module.exports = { parseNativeEscape };
