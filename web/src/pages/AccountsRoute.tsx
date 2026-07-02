import PageScaffold from '@/components/ui/PageScaffold';
import Accounts from './Accounts';
import RemoteAccountsSummary from '@/components/account/RemoteAccountsSummary';
import { useActiveServerContext } from '@/services/server-context';

/* 账号路由（R1）：数据跟随当前 server。
 * - 本机（同源 profile）→ 完整本地账号管理页（原 Accounts，未改动）。
 * - 远端 server → 只读账号摘要（RemoteAccountsSummary）。
 * 路由级双模：切到远端时本地页随组件卸载，其 SSE/WS watcher 自动拆除，不会串数据。 */

export default function AccountsRoute() {
  const context = useActiveServerContext();

  if (context.isLocal || !context.profile) {
    return <Accounts />;
  }

  return (
    <PageScaffold
      ghost
      title="账号管理"
      subTitle={`当前 server：${context.displayName}`}
    >
      <RemoteAccountsSummary key={context.profileId} context={context} />
    </PageScaffold>
  );
}
