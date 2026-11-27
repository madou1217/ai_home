import { useEffect } from 'react';
import { history } from '@umijs/max';

/**
 * 历史链接 /chat/work 的兼容跳转。
 *
 * Work 现在挂在独立顶级路由 /work（见 config/routes.ts）：/chat/work 会同时命中
 * /chat 与 /chat/work 两个菜单项，侧栏出现双选中。这里保留旧地址但立刻跳到新地址，
 * 并带上原有 query（深链 projectPath / sessionId 不能丢）。
 * 用一个页面组件而不是 routes.ts 的 redirect 字段，是因为 redirect 会丢掉 query。
 */
export default function ChatWorkRedirect() {
  useEffect(() => {
    const { search, hash } = history.location;
    history.replace({ pathname: '/work', search, hash });
  }, []);
  return null;
}
