import { Tag } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import type { EgressDiagnostics } from '@/features/egress-upstream/types';

const POOL_PHASE_LABELS: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'default' | 'processing' }> = {
  stopped: { label: '未运行', color: 'default' },
  starting: { label: '启动中', color: 'processing' },
  ready: { label: '就绪', color: 'success' },
  degraded: { label: '降级', color: 'warning' },
  failed: { label: '失败', color: 'error' }
};

const PROCESS_LABELS: Record<string, string> = {
  'clash-verge': 'Clash Verge',
  mihomo: 'mihomo',
  'sing-box': 'sing-box',
  'aih-core': 'AIH 出口池内核'
};

const CORE_SOURCE_LABELS: Record<string, string> = {
  managed: '托管内核',
  path: 'PATH 内核',
  client: '客户端自带内核'
};

export default function ProviderNetworkDiagnostics({ diagnostics }: { diagnostics: EgressDiagnostics }) {
  const phase = POOL_PHASE_LABELS[diagnostics.pool.phase || ''] || POOL_PHASE_LABELS.stopped;
  return (
    <section className="pn-diagnostics" aria-label="代理冲突检测">
      <div className="pn-upstream-head">
        <strong>冲突检测</strong>
        <Tag bordered={false} color={phase.color}>{phase.label}</Tag>
        {diagnostics.pool.mixedPort ? (
          <span className="pn-muted">端口 {diagnostics.pool.mixedPort}/{diagnostics.pool.controllerPort}</span>
        ) : null}
        {typeof diagnostics.pool.freshHealthy === 'number' ? (
          <span className="pn-muted">新鲜健康 {diagnostics.pool.freshHealthy} 个</span>
        ) : null}
        {diagnostics.pool.corePid ? (
          <span className="pn-muted">
            core pid {diagnostics.pool.corePid}{diagnostics.pool.coreVerified ? ' · 已验证' : ' · 身份未知'}
            {diagnostics.pool.coreKind ? ` · ${diagnostics.pool.coreKind}${diagnostics.pool.coreVersion ? ' ' + diagnostics.pool.coreVersion : ''}` : ''}
            {diagnostics.pool.coreSource ? ` · ${CORE_SOURCE_LABELS[diagnostics.pool.coreSource] || diagnostics.pool.coreSource}` : ''}
          </span>
        ) : null}
      </div>
      {diagnostics.conflicts.length ? (
        <InlineNote tone="error">{diagnostics.conflicts.join('；')}</InlineNote>
      ) : (
        <InlineNote tone="success">没有检测到端口或进程身份冲突；AIH 不会接管或结束外部代理内核。</InlineNote>
      )}
      {diagnostics.processes.length ? (
        <div className="pn-rules">
          {diagnostics.processes.map((process) => (
            <Tag bordered={false} key={`${process.kind}:${process.pid}`}>
              {PROCESS_LABELS[process.kind] || process.kind} · pid {process.pid}
            </Tag>
          ))}
        </div>
      ) : null}
      {diagnostics.notes.map((note) => <span className="pn-muted" key={note}>{note}</span>)}
    </section>
  );
}
