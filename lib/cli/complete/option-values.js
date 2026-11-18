'use strict';

const { isProviderName } = require('./command-tree');

const COMMON_VALUE_FLAGS = new Set(['--provider', '--scope', '--account', '--model', '--model-alias']);

const PEER_VALUE_FLAGS = new Set(['--channel', '--target', '--reply-to', '--state', '--mode']);

function isManagedValueFlag(flag, prior) {
  const head = prior[0];
  return (flag === '--proxy' && isProviderName(head) && ['install', 'update'].includes(prior[1]))
    || COMMON_VALUE_FLAGS.has(flag)
    || (head === 'shell' && flag === '--shell')
    || (head === 'peer' && PEER_VALUE_FLAGS.has(flag))
    || (['server', 'daemon', 'serve'].includes(head) && prior[1] === 'config' && prior[2] === 'set');
}

// Normalize only earlier words, leaving the current word's replacement boundary
// to the shell adapter. Never parse anything following the native escape marker.
function normalizePriorValues(prior) {
  const out = [];
  for (let index = 0; index < prior.length; index += 1) {
    const word = prior[index];
    if (word === '--') return [...out, ...prior.slice(index)];
    const inline = word.match(/^(--[^=]+)=(.*)$/s);
    if (inline && isManagedValueFlag(inline[1], prior)) {
      out.push(inline[1], inline[2]);
    } else if (isManagedValueFlag(word, prior) && prior[index + 1] === '=') {
      out.push(word);
      index += 1;
      if (index + 1 < prior.length) {
        out.push(prior[index + 1]);
        index += 1;
      }
    } else {
      out.push(word);
    }
  }
  return out;
}

module.exports = { isManagedValueFlag, normalizePriorValues };
