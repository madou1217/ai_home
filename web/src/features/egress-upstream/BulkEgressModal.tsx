import { useEffect, useMemo, useState } from 'react';
import { Form, Input, Modal, Radio, Select, Tag, Typography, message } from 'antd';
import PoolScopePicker, { type PoolSelection } from './PoolScopePicker';
import { applyEgressToAccounts, type BulkEgressTarget } from './bulk-egress';
import { egressUpstreamAPI } from './egress-upstream-api';
import type { EgressCatalogGroup, EgressStrategyStatus, EgressUpstream } from './types';
import type { AccountEgressMode } from '@/types';
import { toolkitAPI, type ToolkitProxyCandidate } from '@/services/api';

interface BulkEgressModalProps {
  open: boolean;
  /** 覆盖弹窗标题；单账号设置时传「设置出口 · 账号名」。 */
  title?: string;
  /** 单账号设置时预选当前绑定，避免每次都从「出口池」重新选。 */
  initialMode?: AccountEgressMode;
  initialProxyUrl?: string;
  initialSshId?: string;
  /** 服务端策略目录；缺省时弹窗自己读取，仍失败则用离线兜底。 */
  strategies?: EgressStrategyStatus[];
  upstream: EgressUpstream | null;
  groups: EgressCatalogGroup[];
  poolReady: boolean;
  targets: BulkEgressTarget[];
  onClose: (changed: boolean) => void;
  onProbe: (nodes: string[]) => Promise<void>;
  probing: boolean;
}

const DEFAULT_SELECTION: PoolSelection = { scope: { kind: 'all', groups: [], nodes: [] }, strategy: 'sticky' };

/** 离线兜底：服务端策略目录不可用时仍能完成基本设置；新增策略以服务端为准。 */
const FALLBACK_STRATEGIES: EgressStrategyStatus[] = [
  { id: 'direct', label: '直连', description: '', layer: 'application', input: 'none', requiresMihomo: false, requiresSsh: false, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 },
  { id: 'system', label: '系统代理', description: '', layer: 'system', input: 'none', requiresMihomo: false, requiresSsh: false, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 },
  { id: 'url', label: '代理地址', description: '', layer: 'application', input: 'proxy_url', requiresMihomo: false, requiresSsh: false, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 },
  { id: 'ssh', label: 'SSH 出口（AWS 等）', description: '', layer: 'application', input: 'ssh_connection', requiresMihomo: false, requiresSsh: true, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 },
  { id: 'pool', label: 'AIH 出口池（mihomo）', description: '', layer: 'application', input: 'pool_scope', requiresMihomo: true, requiresSsh: false, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 },
  { id: 'tun', label: '外部 TUN', description: '', layer: 'network', input: 'none', requiresMihomo: false, requiresSsh: false, supportsLaunch: true, supportsProbe: true, available: true, status: 'ready', boundAccounts: 0 }
];

/** 同上游批量设置出口：一次选好，逐个账号保存（每个账号仍是独立绑定，之后可单独改）。 */
export default function BulkEgressModal({
  open,
  title,
  initialMode,
  initialProxyUrl,
  initialSshId,
  strategies,
  upstream,
  groups,
  poolReady,
  targets,
  onClose,
  onProbe,
  probing
}: BulkEgressModalProps) {
  const [mode, setMode] = useState<AccountEgressMode>('pool');
  const [proxyUrl, setProxyUrl] = useState('');
  const [selection, setSelection] = useState<PoolSelection>(DEFAULT_SELECTION);
  const [saving, setSaving] = useState(false);
  const [sshId, setSshId] = useState('');
  const [sshCandidates, setSshCandidates] = useState<ToolkitProxyCandidate[]>([]);
  const [sshLoading, setSshLoading] = useState(false);
  const [fetchedCatalog, setFetchedCatalog] = useState<EgressStrategyStatus[]>([]);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode || 'pool');
    setProxyUrl(initialProxyUrl || '');
    setSelection(DEFAULT_SELECTION);
    setSshId(initialSshId || '');
  }, [initialMode, initialProxyUrl, initialSshId, open]);

  // 调用方没有传目录时自己读取；失败才退回离线兜底，保证弹窗始终可用。
  useEffect(() => {
    if (!open || (strategies && strategies.length) || fetchedCatalog.length) return;
    egressUpstreamAPI.strategies()
      .then((items) => setFetchedCatalog(items.length ? items : FALLBACK_STRATEGIES))
      .catch(() => setFetchedCatalog(FALLBACK_STRATEGIES));
  }, [fetchedCatalog.length, open, strategies]);

  const catalog = useMemo(
    () => (strategies && strategies.length ? strategies : (fetchedCatalog.length ? fetchedCatalog : FALLBACK_STRATEGIES)),
    [fetchedCatalog, strategies]
  );
  const activeStrategy = catalog.find((item) => item.id === mode) || catalog[0];
  const activeInput = activeStrategy?.input || 'none';

  // SSH 出口是 AIH 管理的环回隧道（AWS 等），不需要 mihomo；候选来自
  // 现有 SSH 主机的“作为代理启用”状态。
  useEffect(() => {
    if (!open || activeInput !== 'ssh_connection' || sshCandidates.length || sshLoading) return;
    setSshLoading(true);
    toolkitAPI.listProxyCandidates()
      .then((items) => setSshCandidates(items.filter((item) => item.source === 'ssh')))
      .catch(() => setSshCandidates([]))
      .finally(() => setSshLoading(false));
  }, [activeInput, open, sshCandidates.length, sshLoading]);

  const submit = async () => {
    if (activeStrategy?.status === 'unavailable') {
      message.warning(activeStrategy.reason || '该出口策略当前不可用');
      return;
    }
    if (activeInput === 'proxy_url' && !proxyUrl.trim()) {
      message.warning('请输入代理地址');
      return;
    }
    if (activeInput === 'ssh_connection' && !sshId) {
      message.warning('请选择 SSH 出口');
      return;
    }
    setSaving(true);
    try {
      const result = await applyEgressToAccounts(targets, {
        mode,
        proxyUrl: activeInput === 'proxy_url'
          ? proxyUrl.trim()
          : (activeInput === 'ssh_connection' ? sshId : ''),
        ...(activeInput === 'pool_scope' ? { scope: selection.scope, strategy: selection.strategy } : {})
      });
      if (result.failed.length === 0) message.success(`已为 ${result.applied} 个账号设置出口`);
      else message.warning(`${result.applied} 个成功，${result.failed.length} 个失败：${result.failed.map((item) => `${item.label || item.accountRef}（${item.error}）`).join('、')}`);
      onClose(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title || `批量设置出口 · ${targets.length} 个账号`}
      width={720}
      okText="全部应用"
      confirmLoading={saving}
      onOk={() => void submit()}
      onCancel={() => onClose(false)}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" className="egress-up-bulk-targets">
        {targets.map((target) => target.label || target.accountRef).join('、')}
      </Typography.Paragraph>
      <Form layout="vertical">
        <Form.Item label="出口来源">
          <Radio.Group
            value={mode}
            onChange={(event) => setMode(event.target.value as AccountEgressMode)}
            optionType="button"
            buttonStyle="solid"
            options={catalog.map((item) => ({
              value: item.id,
              label: (
                <span>
                  {item.label}
                  {item.status === 'unavailable' ? (
                    <Tag bordered={false} color="default" className="egress-strategy-status">当前不可用</Tag>
                  ) : null}
                </span>
              )
            }))}
          />
        </Form.Item>
        {activeStrategy?.description ? (
          <Typography.Paragraph type="secondary" className="egress-strategy-hint">
            {activeStrategy.description}
            {activeStrategy.reason ? ` ${activeStrategy.reason}` : ''}
          </Typography.Paragraph>
        ) : null}
        {activeInput === 'proxy_url' ? (
          <Form.Item label="代理地址" required>
            <Input value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="socks5://127.0.0.1:6153" className="aih-mono-input" />
          </Form.Item>
        ) : null}
        {activeInput === 'ssh_connection' ? (
          <Form.Item
            label="SSH 出口"
            required
            extra="使用已启用的 SSH 主机作为代理，不需要 mihomo；隧道由 AIH 管理，AWS 等服务器可直接复用。"
          >
            <Select
              value={sshId || undefined}
              loading={sshLoading}
              onChange={(value) => setSshId(value || '')}
              placeholder={sshCandidates.length ? '选择 SSH 出口' : '暂无已启用的 SSH 代理主机'}
              notFoundContent={sshLoading ? '读取中…' : '请先在 SSH 主机里启用“作为代理”'}
              options={sshCandidates.map((item) => ({
                value: item.id,
                label: item.available ? item.name : `${item.name}（不可用）`,
                disabled: !item.available
              }))}
            />
          </Form.Item>
        ) : null}
        {activeInput === 'pool_scope' && activeStrategy?.status !== 'unavailable' ? (
          <PoolScopePicker
            upstream={upstream}
            groups={groups}
            poolReady={poolReady}
            value={selection}
            onChange={setSelection}
            probing={probing}
            onProbe={(nodes) => void onProbe(nodes)}
          />
        ) : null}
      </Form>
    </Modal>
  );
}