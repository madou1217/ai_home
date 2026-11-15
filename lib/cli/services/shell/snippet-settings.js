'use strict';

const PREFIX = '# aih-shell-options-v1: ';

function storedSnippetOptions(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  const line = source.split('\n').find((item) => item.startsWith(PREFIX));
  if (line) {
    try {
      const value = JSON.parse(line.slice(PREFIX.length));
      if (['completion', 'typo', 'wrapper'].every((key) => typeof value[key] === 'boolean')
        && Number.isInteger(value.historyTail) && value.historyTail >= 200) {
        return { completion: value.completion, typo: value.typo, wrapper: value.wrapper, historyTail: value.historyTail };
      }
    } catch (_error) { /* Do not execute a shell file to read its preferences. */ }
    return {};
  }
  // Upgrade previously generated snippets without changing their feature choices.
  if (!source.startsWith('# aih 终端集成：')) return {};
  const read = (name) => {
    const match = source.match(new RegExp(`^(?:typeset -g |set -g |\\$global:)?${name}(?:=| = | )(\\$true|\\$false|[0-9]+);?\\r?$`, 'm'));
    return match ? match[1] : undefined;
  };
  const typo = read('AIH_SHELL_TYPO');
  const wrapper = read('AIH_SHELL_WRAPPER');
  const history = Number(read('AIH_SHELL_HISTORY_TAIL'));
  return {
    completion: source.includes('# ---- TAB 补全 ----'),
    ...(typo === undefined ? {} : { typo: typo === '1' || typo === '$true' }),
    ...(wrapper === undefined ? {} : { wrapper: wrapper === '1' || wrapper === '$true' }),
    ...(Number.isInteger(history) && history >= 200 ? { historyTail: history } : {})
  };
}

function snippetOptionsHeader(options) {
  const { completion, typo, wrapper, historyTail } = options;
  return `${PREFIX}${JSON.stringify({ completion, typo, wrapper, historyTail })}\n`;
}

module.exports = { storedSnippetOptions, snippetOptionsHeader };
