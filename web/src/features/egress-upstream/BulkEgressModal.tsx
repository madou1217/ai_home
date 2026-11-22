import { useEffect, useState } from 'react';
import { Form, Input, Modal, Radio, Select, Tag, Typography, message } from 'antd';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
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
  /** 服务端策略目录；缺省时弹窗自己读取，读不到就显示不可用并允许重试。 */
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
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    setMode(initialMode || 'pool');
    setProxyUrl(initialProxyUrl || '');
    setSelection(DEFAULT_SELECTION);
    setSshId(initialSshId || '');
  }, [initialMode, initialProxyUrl, initialSshId, open]);

  // 服务端目录是唯一声明源：调用方没传时自己读取；失败或为空就保持空目录，
  // 由界面提示不可用并提供重试，不拼本地兜底清单。
  const providedCount = strategies?.length || 0;
  useEffect(() => {
    if (!open || providedCount || fetchedCatalog.length) return;
    let cancelled = false;
    setCatalogFailed(false);
    egressUpstreamAPI.strategies()
      .then((items) => {
        if (cancelled) return;
        setFetchedCatalog(items);
        setCatalogFailed(items.length === 0);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalogFailed(true);
      });
    return () => { cancelled = true; };
  }, [catalogAttempt, fetchedCatalog.length, open, providedCount]);

  const catalog = strategies && strategies.length ? strategies : fetchedCatalog;
  // 目录到达后，若预选模式不在服务端声明里（旧绑定/已下线策略），落到目录首项，
  // 避免提交一个服务端不认识的 mode；目录加载过程中不动已有选择。
  useEffect(() => {
    if (!catalog.length) return;
    if (catalog.some((item) => item.id === mode)) return;
    setMode(catalog[0].id as AccountEgressMode);
  }, [catalog, mode]);

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
    if (!activeStrategy) {
      message.warning('出口策略目录不可用，暂时无法保存');
      return;
    }
    if (activeStrategy.status === 'unavailable') {
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
      okButtonProps={{ disabled: catalog.length === 0 }}
      onOk={() => void submit()}
      onCancel={() => onClose(false)}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" className="egress-up-bulk-targets">
        {targets.map((target) => target.label || target.accountRef).join('、')}
      </Typography.Paragraph>
      <Form layout="vertical">
        <Form.Item label="出口来源">
          {catalog.length ? (
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
          ) : catalogFailed ? (
            <InlineNote
              tone="warning"
              action={<Button size="small" type="link" onClick={() => setCatalogAttempt((value) => value + 1)}>重试</Button>}
            >
              策略目录不可用，暂时无法设置出口
            </InlineNote>
          ) : (
            <InlineNote tone="info">正在读取出口策略…</InlineNote>
          )}
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