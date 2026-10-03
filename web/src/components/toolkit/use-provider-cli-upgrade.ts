import { useCallback, useEffect, useMemo, useState } from 'react';
import { toolkitAPI } from '@/services/api';
import type { ProviderCliUpgradeClearBrokenResponse, ProviderCliUpgradeStatusResponse } from '@/types';
import { getProviderCliUpgradeRows, getUpgradeModeSummary } from './provider-cli-upgrade-presentation';

/**
 * CLI 自动升级状态面的数据层（桌面面板与移动端共用）。
 * 「刷新」只重新拉取服务端已有状态，不触发检查、不安装任何东西。
 * 唯一的写操作是「验证并解除熔断」：服务端先验证当前 CLI，通过才解除。
 */
export function useProviderCliUpgrade() {
  const [data, setData] = useState<ProviderCliUpgradeStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await toolkitAPI.getProviderCliUpgradeStatus();
      setData(response);
      setError('');
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const [clearingProvider, setClearingProvider] = useState('');
  const clearBroken = useCallback(async (provider: string): Promise<ProviderCliUpgradeClearBrokenResponse> => {
    setClearingProvider(provider);
    try {
      const result = await toolkitAPI.clearProviderCliUpgradeBroken(provider);
      if (result.status) setData(result.status);
      return result;
    } catch (clearError) {
      return {
        ok: false,
        reason: 'request_failed',
        detail: clearError instanceof Error ? clearError.message : String(clearError),
        version: ''
      };
    } finally {
      setClearingProvider('');
    }
  }, []);

  const rows = useMemo(() => getProviderCliUpgradeRows(data), [data]);
  const mode = useMemo(() => getUpgradeModeSummary(data?.scheduler || null, data?.global), [data]);
  const updatable = rows.filter((row) => row.statusLabel === '有新版' || row.statusLabel === '待升级').length;
  const attention = rows.filter((row) => row.attention).length;
  const installed = rows.filter((row) => row.installed).length;

  return { data, loading, error, fetchStatus, rows, mode, updatable, attention, installed, clearBroken, clearingProvider };
}
