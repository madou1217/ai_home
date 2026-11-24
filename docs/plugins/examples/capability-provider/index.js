'use strict';

// Provider 级能力插件最小骨架：
// - scope 已经把调用收敛到 provider=example、model=example-*
// - 返回候选账号的顺序；返回 null 表示不表态，保持宿主原顺序
// - 不能新增候选或越界，越界会得到 plugin_scope_violation
module.exports = {
  apply(ctx) {
    ctx.aih.register('example.gateway.account', async (value) => {
      if (value.provider !== 'example') return null;
      const oauth = value.candidates
        .filter((candidate) => candidate.authType === 'oauth')
        .map((candidate) => candidate.accountRef);
      return oauth.length ? oauth : null;
    });
  }
};
