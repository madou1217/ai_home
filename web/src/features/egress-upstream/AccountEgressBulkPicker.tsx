import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Empty, Modal, Tag, Typography } from 'antd';
import Button from '@/components/ui/AppButton';
import BulkEgressModal from './BulkEgressModal';
import { egressUpstreamAPI } from './egress-upstream-api';
import { commonUpstream, describeAccountEgress, quickSelectAccounts } from './egress-upstream-presentation';
import type { EgressUpstreamView } from './types';

interface AccountEgressBulkPickerProps {
  open: boolean;
  view: EgressUpstreamView | null;
  /** 只列这些 provider 的账号（跟随账号页当前 tab）；空 = 全部。 */
  providers?: string[];
  onClose: (changed: boolean) => void;
}

/**
 * 账号列表「批量设置出口」：按上游分组勾选账号（可一键选「未设置出口的」「网络被拒的」），
 * 再用同一份出口设置逐个保存。所选账号同属一个上游时，出口池范围里能看到该上游的节点判定。
 */
export default function AccountEgressBulkPicker({ open, view, providers = [], onClose }: AccountEgressBulkPickerProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [configuring, setConfiguring] = useState(false);
  const [probing, setProbing] = useState(false);

  const upstreams = useMemo(() => (view?.upstreams || [])
    .map((upstream) => ({
      ...upstream,
      accounts: upstream.accounts.filter((account) => providers.length === 0 || providers.includes(account.provider))
    }))
    .filter((upstream) => upstream.accounts.length > 0), [view, providers]);

  useEffect(() => {
    if (!open) return;
    setConfiguring(false);
    // 默认勾选「当前网络被拒」的账号：它们现在用不了，最需要先设置。
    setSelected(quickSelectAccounts(upstreams, 'denied'));
  }, [open]);  

  const shared = commonUpstream(upstreams, selected);
  const targets = upstreams.flatMap((upstream) => upstream.accounts)
    .filter((account) => selected.includes(account.accountRef))
    .map((account) => ({ provider: account.provider, accountRef: account.accountRef, label: account.label }));

  const toggleMany = (refs: string[], checked: boolean) => setSelected((current) => (
    checked ? [...new Set([...current, ...refs])] : current.filter((ref) => !refs.includes(ref))
  ));

  const probe = async (nodes: string[]) => {
    if (!shared) return;
    setProbing(true);
    try {
      await egressUpstreamAPI.probe(shared.id, nodes);
    } finally {
      setProbing(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !configuring}
        title="批量设置出口"
        width={720}
        okText={`下一步：为 ${selected.length} 个账号设置`}
        okButtonProps={{ disabled: selected.length === 0 }}
        onOk={() => setConfiguring(true)}
        onCancel={() => onClose(false)}
        destroyOnHidden
      >
        <div className="egress-bulk-quick">
          <Button size="small" onClick={() => setSelected(quickSelectAccounts(upstreams, 'unbound'))}>选中未设置出口的</Button>
          <Button size="small" onClick={() => setSelected(quickSelectAccounts(upstreams, 'denied'))}>选中网络被拒的</Button>
          <Button size="small" type="link" disabled={selected.length === 0} onClick={() => setSelected([])}>清空</Button>
        </div>
        {upstreams.length === 0 ? (
          <Empty description={view ? '当前筛选下没有账号' : '正在读取账号出口状态'} />
        ) : (
          <div className="egress-bulk-groups">
            {upstreams.map((upstream) => {
              const refs = upstream.accounts.map((account) => account.accountRef);
              const chosen = refs.filter((ref) => selected.includes(ref)).length;
              return (
                <section key={upstream.id} className="egress-bulk-group" aria-label={upstream.host}>
                  <Checkbox
                    checked={chosen === refs.length}
                    indeterminate={chosen > 0 && chosen < refs.length}
                    onChange={(event) => toggleMany(refs, event.target.checked)}
                  >
                    <strong>{upstream.host}</strong>
                    <Typography.Text type="secondary"> · {upstream.providers.join(' / ')} · {refs.length} 个账号</Typography.Text>
                  </Checkbox>
                  <ul>
                    {upstream.accounts.map((account) => {
                      const badge = describeAccountEgress(account);
                      return (
                        <li key={account.accountRef}>
                          <Checkbox
                            checked={selected.includes(account.accountRef)}
                            onChange={(event) => toggleMany([account.accountRef], event.target.checked)}
                          >
                            {account.label || account.accountRef}
                          </Checkbox>
                          <Tag color={badge.tone === 'error' ? 'error' : badge.tone === 'success' ? 'processing' : 'default'}>{badge.label}</Tag>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </Modal>
      <BulkEgressModal
        open={open && configuring}
        upstream={shared}
        groups={view?.groups || []}
        poolReady={Boolean(view?.pool.ready)}
        targets={targets}
        probing={probing}
        onProbe={probe}
        onClose={(changed) => {
          if (changed) onClose(true);
          else setConfiguring(false);
        }}
      />
    </>
  );
}
