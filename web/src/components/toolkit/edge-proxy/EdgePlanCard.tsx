import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Input, InputNumber, Popconfirm, Segmented, Select, Space } from 'antd';
import { FileTextOutlined, GatewayOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import CopyableCommand from '../CopyableCommand';
import { edgeProxyAPI, type EdgePlanInput } from './edge-proxy-api';
import {
  EDGE_NGINX_MODES,
  EDGE_PROVIDER_META,
  describeApplyResult,
  describeEdgeError
} from './edge-proxy-presentation';
import type { EdgeApplyResult, EdgeNginxMode, EdgePlan, EdgeProvider } from './types';

interface EdgePlanCardProps {
  /** 允许选的软件；订阅侧只要「做一个入口」用的那两个，管理面给全集。 */
  providers?: EdgeProvider[];
  platform?: string;
  /**
   * 传入 = 管理面：计划下方给「写入并重载」，落盘后回调刷新现状。
   * 不传 = 纯 dry-run：只生成计划（订阅侧用的就是这一档，不在这里管 nginx）。
   */
  apply?: {
    label?: string;
    onApplied?: (result: EdgeApplyResult) => void;
  };
  /** 计划区之外的补充说明（例如「写入与回滚在 应用与集成」）。 */
  hint?: ReactNode;
}

/**
 * 「生成计划」这一件事的**唯一实现**：选软件 / 域名 / 形态 → 拿到会写入的内容（可复制）。
 * 管理面（EdgeProxyPanel）在它下面接上写入按钮；订阅侧只渲染 dry-run，不碰写入。
 */
export default function EdgePlanCard({
  providers = ['nginx', 'caddy', 'frp'],
  platform = '',
  apply,
  hint
}: EdgePlanCardProps) {
  const [provider, setProvider] = useState<EdgeProvider>(providers[0]);
  const [domain, setDomain] = useState('');
  const [mode, setMode] = useState<EdgeNginxMode>('split');
  const [remotePort, setRemotePort] = useState<number | null>(null);
  const [plan, setPlan] = useState<EdgePlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<EdgeApplyResult | null>(null);

  const input = useMemo<EdgePlanInput>(() => ({
    provider,
    domain: domain.trim() || undefined,
    mode: provider === 'nginx' ? mode : undefined,
    remotePort: provider === 'frp' && remotePort ? remotePort : undefined
  }), [provider, domain, mode, remotePort]);

  const generatePlan = useCallback(async () => {
    setPlanLoading(true);
    setPlanError('');
    setApplyResult(null);
    try {
      const data = await edgeProxyAPI.plan(input);
      if (data.ok === false || !data.plan) {
        setPlan(null);
        setPlanError(describeEdgeError(data.error, platform));
      } else {
        setPlan(data.plan);
      }
    } catch (error: unknown) {
      setPlan(null);
      setPlanError(error instanceof Error ? error.message : '生成失败');
    } finally {
      setPlanLoading(false);
    }
  }, [input, platform]);

  const runApply = useCallback(async () => {
    setApplying(true);
    try {
      const data = await edgeProxyAPI.apply({ ...input, reload: true });
      setApplyResult(data);
      if (data.ok) apply?.onApplied?.(data);
    } catch (error: unknown) {
      setApplyResult({ ok: false, error: 'edge_request_failed', message: error instanceof Error ? error.message : '写入失败' });
    } finally {
      setApplying(false);
    }
  }, [input, apply]);

  const applyLine = applyResult ? describeApplyResult(applyResult) : null;
  const activeMode = EDGE_NGINX_MODES.find((item) => item.value === mode);

  return (
    <>
      <Space wrap size={8}>
        <Segmented
          value={provider}
          onChange={(value) => {
            setProvider(value as EdgeProvider);
            setPlan(null);
            setApplyResult(null);
          }}
          options={providers.map((item) => ({ value: item, label: EDGE_PROVIDER_META[item].label }))}
        />
        {provider !== 'frp' ? (
          <Input
            style={{ minWidth: 220 }}
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="域名，例如 aih.example.com"
            aria-label="域名"
          />
        ) : null}
        {provider === 'nginx' ? (
          <Select
            style={{ minWidth: 200 }}
            value={mode}
            onChange={(value) => setMode(value as EdgeNginxMode)}
            aria-label="转发形态"
            options={EDGE_NGINX_MODES.map((item) => ({ value: item.value, label: item.label }))}
          />
        ) : null}
        {provider === 'frp' ? (
          <InputNumber
            style={{ minWidth: 160 }}
            value={remotePort}
            onChange={setRemotePort}
            placeholder="VPS 远端端口"
            aria-label="远端端口"
          />
        ) : null}
        <Button
          type="primary"
          icon={<FileTextOutlined />}
          loading={planLoading}
          disabled={provider !== 'frp' && !domain.trim()}
          onClick={() => void generatePlan()}
        >
          生成计划
        </Button>
      </Space>

      {provider === 'nginx' && activeMode ? <p className="toolkit-section-note">{activeMode.detail}</p> : null}
      {provider === 'frp' ? (
        <p className="toolkit-section-note">只在本机 frpc 配置里补两条 [[proxies]]（TCP + UDP，名字带 aih-server），你自己写的转发不动。</p>
      ) : null}
      {hint ? <p className="toolkit-section-note">{hint}</p> : null}

      {planError && <InlineNote tone="error">{planError}</InlineNote>}

      {plan ? (
        <section aria-label="计划预览">
          <InlineNote tone="info" icon={<GatewayOutlined />} description={plan.notes?.join('；')}>{plan.summary}</InlineNote>
          {plan.files.map((file) => (
            <div key={file.path}>
              <div className="toolkit-detail-heading">
                <div>
                  <span>{file.topLevel ? 'TOP-LEVEL INCLUDE' : file.append ? 'MANAGED BLOCK' : 'SITE'}</span>
                  <h3>{file.path}</h3>
                </div>
              </div>
              <CopyableCommand command={file.content} copyLabel="复制配置" />
            </div>
          ))}
          {apply ? (
            <div className="toolkit-header-actions">
              <Popconfirm
                title="写入并重载？"
                description="先备份原配置；校验不通过会整体回滚。"
                okText="写入"
                cancelText="取消"
                onConfirm={() => void runApply()}
              >
                <Button type="primary" icon={<SafetyCertificateOutlined />} loading={applying}>
                  {apply.label || '写入并重载'}
                </Button>
              </Popconfirm>
            </div>
          ) : null}
        </section>
      ) : null}

      {applyLine ? (
        <InlineNote tone={applyLine.tone} description={applyLine.detail || undefined}>{applyLine.text}</InlineNote>
      ) : null}
    </>
  );
}
