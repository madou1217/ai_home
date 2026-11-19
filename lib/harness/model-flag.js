'use strict';

// 只改写 --model / --model=，用于会话级模型别名；不读取别名表。
function rewriteModelFlagInArgs(args, resolveModel) {
  const source = Array.isArray(args) ? args : [];
  const next = source.slice();
  for (let index = 0; index < next.length; index += 1) {
    const token = String(next[index] || '');
    if (token === '--') break;
    if (token === '--model') {
      if (index + 1 < next.length) next[index + 1] = resolveModel(next[index + 1]);
      continue;
    }
    if (token.startsWith('--model=')) {
      const value = token.slice('--model='.length);
      next[index] = `--model=${resolveModel(value)}`;
    }
  }
  return next;
}

module.exports = { rewriteModelFlagInArgs };
