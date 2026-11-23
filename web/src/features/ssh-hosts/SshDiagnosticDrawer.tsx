import { Drawer, Space, Tag } from 'antd';
import InlineNote from '@/components/ui/InlineNote';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
import HudStateView from '@/components/hud/HudStateView';
import { formatSshProbeTime } from './ssh-hosts-model';
import type { SshConnection } from './ssh-hosts-model';
import type { SshTestState } from './use-ssh-hosts';

export interface SshDiagnosticDrawerProps {
  open: boolean;
  connection: SshConnection | null;
  testState?: SshTestState;
  onClose: () => void;
}

/**
 * SSH 连通性与环境依赖诊断抽屉：拆离自 SshHostsPanel.tsx。
 */
export default function SshDiagnosticDrawer({
  open,
  connection,
  testState,
  onClose
}: SshDiagnosticDrawerProps) {
  const renderBody = () => {
    if (!connection) return null;
    if (!testState) return <div className="ssh-diag-placeholder hud-label">等待探测连接…</div>;
    if (testState.loading) {
      return (
        <div className="ssh-diag-loading">
          <HudStateView
            variant="loading"
            compact
            code="SYS // SSH_PROBE"
            title="正在探测远程主机与工具链…"
            description="核验 SSH 握手、系统架构及 Node / Git / AIH 可用性。"
          />
        </div>
      );
    }

    const result = testState.result;
    if (!result) return null;
    const targetLabel = result.target || `${connection.user ? `${connection.user}@` : ''}${connection.host}`;

    return (
      <Space direction="vertical" style={{ width: '100%' }} size="large">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
          <SettingStatusTag
            status={result.status === 'reachable' ? 'applied' : result.status === 'auth-required' ? 'dirty' : 'error'}
            label={result.status === 'reachable' ? '已连通' : result.status === 'auth-required' ? '认证失败' : '不可达'}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--hos-text-micro)', color: 'var(--color-muted)' }}>
            探测时间：{formatSshProbeTime(testState.testedAt)}
          </span>
        </div>

        {result.status === 'reachable' ? (
          <InlineNote tone="success" description={`目标主机 ${targetLabel} 握手正常。`}>
            SSH 连通正常
          </InlineNote>
        ) : null}
        {result.status === 'auth-required' ? (
          <InlineNote
            tone="warning"
            description="主机可达但 SSH 认证未通过。请核对私钥路径、私钥内容、密码或服务端 ssh-agent 密钥。"
          >
            认证未通过
          </InlineNote>
        ) : null}
        {result.status === 'unreachable' ? (
          <InlineNote
            tone="error"
            description={result.stderr || '网络不可达，请检查主机地址、端口或 sshd 服务状态。'}
          >
            连接失败
          </InlineNote>
        ) : null}

        {result.status === 'reachable' ? (
          <div className="ssh-diag-panel hud-panel hud-panel--sm">
            <div className="ssh-diag-section">
              <div className="ssh-diag-caption hud-label">系统平台 / 架构</div>
              <Space size={6}>
                <Tag color="blue" className="ssh-diag-mono-tag">{result.platform || '未知'}</Tag>
                <Tag color="cyan" className="ssh-diag-mono-tag">{result.arch || '未知'}</Tag>
              </Space>
            </div>

            <div>
              <div className="ssh-diag-caption hud-label">依赖检测</div>
              <div className="ssh-diag-rows">
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Node.js</span>
                  <SettingStatusTag
                    status={result.commands?.node ? 'applied' : 'error'}
                    label={result.commands?.node ? '已安装' : '未检测到'}
                    compact
                    live="off"
                  />
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Npm</span>
                  <SettingStatusTag
                    status={result.commands?.npm ? 'applied' : 'error'}
                    label={result.commands?.npm ? '已安装' : '未检测到'}
                    compact
                    live="off"
                  />
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">Git</span>
                  <SettingStatusTag
                    status={result.commands?.git ? 'applied' : 'error'}
                    label={result.commands?.git ? '已安装' : '未检测到'}
                    compact
                    live="off"
                  />
                </div>
                <div className="ssh-diag-row">
                  <span className="ssh-diag-row-name">AIH Agent</span>
                  <SettingStatusTag
                    status={result.commands?.aih ? 'applied' : 'dirty'}
                    label={result.commands?.aih ? '已配置' : '免装模式'}
                    compact
                    live="off"
                  />
                </div>
              </div>
            </div>

            {result.recommendation ? (
              <div className="ssh-diag-advice">
                <div className="ssh-diag-caption hud-label">诊断建议</div>
                <p className="ssh-diag-advice-text hud-prose">{result.recommendation}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </Space>
    );
  };

  return (
    <Drawer
      title={connection ? `${connection.label} · 探测诊断` : '探测诊断'}
      placement="right"
      width={460}
      onClose={onClose}
      open={open}
      destroyOnClose
    >
      {renderBody()}
    </Drawer>
  );
}
