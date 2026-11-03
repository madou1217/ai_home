import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { egressUpstreamAPI } from './egress-upstream-api';
import type { EgressUpstream, EgressUpstreamAccount, EgressUpstreamView } from './types';

export interface AccountEgressEntry {
  account: EgressUpstreamAccount;
  upstream: Pick<EgressUpstream, 'id' | 'host' | 'official'>;
}

// 账号出口状态在账号列表里只是辅助信息：低频轮询即可，绑定改动后由调用方显式 reload。
const REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * 账号列表的出口摘要：accountRef → 该账号的出口 / 车道 / 当前网络判定 + 所属上游。
 * 数据与「上游地区策略」面板同源（GET /v0/webui/egress-upstreams），读失败时返回空表（徽标不显示）。
 */
export function useAccountEgressSummary() {
  const [view, setView] = useState<EgressUpstreamView | null>(null);
  const inflight = useRef(false);

  const reload = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      setView(await egressUpstreamAPI.view());
    } catch {
      /* 可选信息：失败不打扰账号列表 */
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [reload]);

  const byAccount = useMemo(() => {
    const map = new Map<string, AccountEgressEntry>();
    (view?.upstreams || []).forEach((upstream) => {
      upstream.accounts.forEach((account) => {
        map.set(account.accountRef, { account, upstream: { id: upstream.id, host: upstream.host, official: upstream.official } });
      });
    });
    return map;
  }, [view]);

  return { view, byAccount, reload };
}
