import { useEffect, useState } from 'react';
import { Form, Input, Modal, Radio, Typography, message } from 'antd';
import PoolScopePicker, { type PoolSelection } from './PoolScopePicker';
import { applyEgressToAccounts, type BulkEgressTarget } from './bulk-egress';
import type { EgressCatalogGroup, EgressUpstream } from './types';
import type { AccountEgressMode } from '@/types';

interface BulkEgressModalProps {
  open: boolean;
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
export default function BulkEgressModal({ open, upstream, groups, poolReady, targets, onClose, onProbe, probing }: BulkEgressModalProps) {
  const [mode, setMode] = useState<AccountEgressMode>('pool');
  const [proxyUrl, setProxyUrl] = useState('');
  const [selection, setSelection] = useState<PoolSelection>(DEFAULT_SELECTION);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('pool');
    setProxyUrl('');
    setSelection(DEFAULT_SELECTION);
  }, [open]);

  const submit = async () => {
    if (mode === 'url' && !proxyUrl.trim()) {
      message.warning('请输入代理地址');
      return;
    }
    setSaving(true);
    try {
      const result = await applyEgressToAccounts(targets, {
        mode,
        proxyUrl: mode === 'url' ? proxyUrl.trim() : '',
        ...(mode === 'pool' ? { scope: selection.scope, strategy: selection.strategy } : {})
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
      title={`批量设置出口 · ${targets.length} 个账号`}
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
            onChange={(event) => setMode(event.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'pool', label: 'AIH 出口池' },
              { value: 'url', label: '代理地址' },
              { value: 'system', label: '系统代理' },
              { value: 'tun', label: '外部 TUN' },
              { value: 'direct', label: '直连' }
            ]}
          />
        </Form.Item>
        {mode === 'url' ? (
          <Form.Item label="代理地址" required>
            <Input value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} placeholder="socks5://127.0.0.1:6153" className="aih-mono-input" />
          </Form.Item>
        ) : null}
        {mode === 'pool' ? (
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
