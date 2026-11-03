import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Input, InputNumber, Popconfirm, Segmented, Select, Space } from 'antd';
import { GatewayOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
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

const PREVIEW_DEBOUNCE_MS = 350;

interface EdgePlanCardProps {
  /** 允许选的软件；只传一个时不再显示软件切换（管理页就是"对着这个软件配置"）。 */
  providers?: EdgeProvider[];
  platform?: string;
  /**
   * 传入 = 管理面：预览下方给「写入并重载」，落盘后回调刷新现状。
   * 不传 = 纯预览：只显示会写什么（订阅侧用的就是这一档，不在这里管 nginx）。
   */
  apply?: {
    label?: string;
    onApplied?: (result: EdgeApplyResult) => void;
  };
  hint?: ReactNode;
}

/**
 * 「这个软件要写哪些文件」的**唯一实现**：参数填好即自动预览（不用先点一次生成计划），
 * 内容与写入时逐字节一致（同一个 plan 接口）。管理面在预览下方接写入按钮，订阅侧只到预览为止。
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
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<EdgeApplyResult | null>(null);

  const input = useMemo<EdgePlanInput>(() => ({
    provider,
    domain: domain.trim() || undefined,
    mode: provider === 'nginx' ? mode : undefined,
    remotePort: provider === 'frp' && remotePort ? remotePort : undefined
  }), [provider, domain, mode, remotePort]);

  const ready = provider === 'frp' ? Boolean(remotePort) : Boolean(domain.trim());

  // 参数齐了就自动预览（防抖）：用户不需要"先点一次生成计划"这个多余动作。
  useEffect(() => {
    setApplyResult(null);
    if (!ready) {
      setPlan(null);
      setPreviewError('');
      setPreviewing(false);
      return undefined;
    }
    let alive = true;
    const timer = setTimeout(() => {
      setPreviewing(true);
      void (async () => {
        try {
          const data = await edgeProxyAPI.plan(input);
          if (!alive) return;
          if (data.ok === false || !data.plan) {
            setPlan(null);
            setPreviewError(describeEdgeError(data.error, platform));
          } else {
            setPlan(data.plan);
            setPreviewError('');
          }
        } catch (error: unknown) {
          if (!alive) return;
          setPlan(null);
          setPreviewError(error instanceof Error ? error.message : '预览失败');
        } finally {
          if (alive) setPreviewing(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready, input, platform]);

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
        {providers.length > 1 ? (
          <Segmented
            value={provider}
            onChange={(value) => {
              setProvider(value as EdgeProvider);
              setPlan(null);
              setApplyResult(null);
            }}
            options={providers.map((item) => ({ value: item, label: EDGE_PROVIDER_META[item].label }))}
          />
        ) : null}
        {provider !== 'frp' ? (
          <Input
            style={{ minWidth: 240 }}
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
            style={{ minWidth: 180 }}
            value={remotePort}
            onChange={setRemotePort}
            placeholder="VPS 远端端口"
            aria-label="远端端口"
          />
        ) : null}
      </Space>

      {provider === 'nginx' && activeMode ? <p className="toolkit-section-note">{activeMode.detail}</p> : null}
      {provider === 'frp' ? (
        <p className="toolkit-section-note">只在本机 frpc 配置里补两条 [[proxies]]（TCP + UDP，名字带 aih-server），你自己写的转发不动。</p>
      ) : null}
      {hint ? <p className="toolkit-section-note">{hint}</p> : null}

      {!ready ? (
        <p className="toolkit-section-note">
          {provider === 'frp' ? '填上远端端口就会显示要写的内容。' : '填上域名就会显示要写的内容。'}
        </p>
      ) : null}
      {ready && previewing && !plan ? <p className="toolkit-section-note">正在算要写哪些文件…</p> : null}
      {previewError ? <InlineNote tone="error">{previewError}</InlineNote> : null}

      {plan ? (
        <section aria-label="将要写入的内容">
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
