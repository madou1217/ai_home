import { accountsAPI } from '@/services/api';
import type { AccountEgressBindingInput } from '@/types';

export interface BulkEgressTarget {
  provider: string;
  accountRef: string;
  label?: string;
}

/**
 * 把同一个出口设置逐个应用到多个账号（同上游批量设置）。逐个串行：每次保存都会探测一次出口，
 * 并发会让同一个代理被同时探测 N 次。单个失败不影响其它账号，结果里列出失败项。
 */
export async function applyEgressToAccounts(targets: BulkEgressTarget[], input: AccountEgressBindingInput) {
  const failed: Array<BulkEgressTarget & { error: string }> = [];
  let applied = 0;
  for (const target of targets) {
    try {
       
      const response = await accountsAPI.saveAccountEgress(target.provider, target.accountRef, input);
      if (response.apply && response.apply.ok === false) failed.push({ ...target, error: response.apply.error || 'apply_failed' });
      else applied += 1;
    } catch (error: unknown) {
      const code = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
      failed.push({ ...target, error: code || (error as Error)?.message || 'save_failed' });
    }
  }
  return { applied, failed };
}
