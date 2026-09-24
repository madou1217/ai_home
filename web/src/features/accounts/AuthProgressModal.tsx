import { Button, Card, Collapse, Input, Modal, Space, Tooltip, Typography, message } from 'antd';
import { CopyOutlined, GlobalOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { providerNames } from '@/components/chat/ProviderIcon';
import { InlineNote } from '@/components/ui/InlineNote';
import { openExternalUrl } from '@/services/open-external-url';
import type { AccountAddJob } from '@/types';
import './account-overlays.css';

const { Text } = Typography;

// agy/claude keep a CLI running and want an authorization code pasted in, while
// codex/gemini redirect to a URL we forward. Centralizing the strings (and the
// "must wait for the code prompt" gate) keeps the modal free of scattered
// per-provider conditionals.
type CallbackUiCopy = {
  hint: string;
  placeholder: string;
  submitLabel: string;
  emptyWarning: string;
  submitSuccess: string;
  requiresAwaitingCode: boolean;
};

export function getCallbackUiCopy(provider?: string): CallbackUiCopy {
  if (provider === 'agy') {
    return {
      hint: '授权后如果页面显示 authorization code，把完整授权码粘贴到这里，系统会写回 Antigravity CLI。',
      placeholder: '粘贴 Google 授权页返回的完整授权码',
      submitLabel: '提交授权码',
      emptyWarning: '请粘贴授权码',
      submitSuccess: '授权码已提交，正在确认授权结果',
      requiresAwaitingCode: true
    };
  }
  return {
    // codex / claude / gemini: aih (or the CLI) runs a localhost loopback server.
    // Same machine auto-captures; remote sessions paste the callback URL here.
    hint: '同一台机器会自动接收回调；如果是远端访问，浏览器停在回调页或显示无法连接时，把地址栏完整地址粘贴到这里。只有本次授权链接的 state 才会被接受。',
    placeholder: '粘贴完整回调地址，或只粘贴 ?code=...&state=...',
    submitLabel: '提交回调',
    emptyWarning: '请粘贴回调地址',
    submitSuccess: '回调已提交，正在确认授权结果',
    requiresAwaitingCode: false
  };
}

export function getAuthJobIdentity(job: AccountAddJob | null, subjectLabel: string): string {
  const value = String(job?.email || job?.displayName || '').trim();
  if (value) return value;
  const subject = String(subjectLabel || '').trim();
  if (!subject || /授权|账号/.test(subject)) return '';
  return subject;
}

type AuthStepState = 'pending' | 'active' | 'done' | 'warn' | 'error';
type AuthStatusTone = 'info' | 'ok' | 'warn' | 'err';

function getAuthStatusTone(status: AccountAddJob['status']): AuthStatusTone {
  if (status === 'failed') return 'err';
  if (status === 'succeeded') return 'ok';
  if (status === 'expired' || status === 'cancelled') return 'warn';
  return 'info';
}

export function getAuthJobStatusDescription(job: AccountAddJob, successClosing: boolean): string {
  if (job.status === 'running') return '正在等待授权完成...';
  if (job.status === 'succeeded') {
    return successClosing ? '授权已完成，账号已经可用。弹窗将在 3 秒后自动关闭。' : '授权已完成，账号已经可用。';
  }
  if (job.status === 'expired') return job.error || '授权已过期，请重新发起。';
  if (job.status === 'cancelled') return job.error || '授权流程已取消。';
  return job.error || '授权失败，请查看下方日志。';
}

/**
 * 授权步骤轨：只由真实 job.status / setupPhase 推导，不引入额外阶段。
 * 安装步骤只在后端报告安装阶段（等待确认 / 安装中）时出现。
 */
export function getAuthJobSteps(job: AccountAddJob): Array<{ key: string; label: string; state: AuthStepState }> {
  const installPhase = job.setupPhase === 'awaiting-install-confirmation' || job.setupPhase === 'installing';
  const authorizeState: AuthStepState = installPhase
    ? 'pending'
    : job.status === 'running'
      ? 'active'
      : job.status === 'succeeded'
        ? 'done'
        : job.status === 'failed'
          ? 'error'
          : 'warn';
  const steps: Array<{ key: string; label: string; state: AuthStepState }> = [];
  if (installPhase) {
    steps.push({
      key: 'install',
      label: '安装 CLI',
      state: job.setupPhase === 'installing' ? 'active' : 'warn'
    });
  }
  steps.push({ key: 'authorize', label: '等待授权', state: authorizeState });
  steps.push({ key: 'ready', label: '账号可用', state: job.status === 'succeeded' ? 'done' : 'pending' });
  return steps;
}

/** 授权状态头（取代整块 Alert）：LED + 标题 + 真实状态码 + 说明 + 步骤轨。 */
export function AuthJobStatusPanel({
  job,
  title,
  successClosing
}: {
  job: AccountAddJob;
  title: string;
  successClosing: boolean;
}) {
  const tone = getAuthStatusTone(job.status);
  const steps = getAuthJobSteps(job);
  return (
    <div
      className={`auth-job-status auth-job-status--${tone}`}
      role={tone === 'err' || tone === 'warn' ? 'alert' : 'status'}
    >
      <span
        className={`hud-led hud-led--${tone}${job.status === 'running' ? ' hud-led--live' : ''}`}
        aria-hidden="true"
      />
      <div className="auth-job-status-body">
        <div className="auth-job-status-head">
          <span className="auth-job-status-title">{title}</span>
          <span className="auth-job-status-code">{String(job.status || '').toUpperCase()}</span>
        </div>
        <span className="auth-job-status-desc">{getAuthJobStatusDescription(job, successClosing)}</span>
        <ol className="aih-step-track" aria-label="授权步骤">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className={`aih-step aih-step--${step.state}`}
              aria-current={step.state === 'active' ? 'step' : undefined}
            >
              <span className="aih-step-head">
                <span className="aih-step-index">{String(index + 1).padStart(2, '0')}</span>
                <span>{step.label}</span>
              </span>
              <span className="aih-step-bar" aria-hidden="true" />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

interface AuthProgressModalProps {
  open: boolean;
  job: AccountAddJob | null;
  subjectLabel: string;
  successClosing: boolean;
  callbackUrl: string;
  callbackSubmitting: boolean;
  cliInstallSubmitting: boolean;
  canSubmitCallback: boolean;
  onClose: () => void;
  onCallbackUrlChange: (url: string) => void;
  onSubmitBrowserCallback: () => void;
  onConfirmCliInstall: () => void;
}

export function AuthProgressModal({
  open,
  job: addJob,
  subjectLabel,
  successClosing: authSuccessClosing,
  callbackUrl: authCallbackUrl,
  callbackSubmitting: authCallbackSubmitting,
  cliInstallSubmitting,
  canSubmitCallback,
  onClose,
  onCallbackUrlChange,
  onSubmitBrowserCallback,
  onConfirmCliInstall
}: AuthProgressModalProps) {
  const copyText = async (value: string, successMessage: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(successMessage);
    } catch (_error) {
      message.error('复制失败');
    }
  };

  const openAuthLink = async (value?: string) => {
    const target = String(value || '').trim();
    if (!target) return;
    try {
      await openExternalUrl(target);
    } catch (_error) {
      message.error('无法打开授权链接');
    }
  };

  const renderAuthDetail = (
    label: string,
    value: string,
    options: { copyMessage: string; openable?: boolean; code?: boolean } = { copyMessage: '已复制' }
  ) => {
    const text = String(value || '').trim();
    if (!text) return null;
    return (
      <div className={`auth-progress-detail-row${options.code ? ' auth-progress-detail-row--code' : ''}`}>
        <Text strong className="auth-progress-detail-label">{label}</Text>
        <div className="auth-progress-detail-content">
          <Text className="auth-progress-detail-text">{text}</Text>
          <Space size={4} className="auth-progress-detail-actions">
            <Tooltip title="复制">
              <Button
                type="text"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => copyText(text, options.copyMessage)}
              />
            </Tooltip>
            {options.openable ? (
              <Tooltip title="在当前浏览器打开">
                <Button
                  type="text"
                  size="small"
                  icon={<GlobalOutlined />}
                  onClick={() => openAuthLink(text)}
                />
              </Tooltip>
            ) : null}
          </Space>
        </div>
      </div>
    );
  };

  return (
    <Modal
      title="授权进度"
      open={open}
      wrapClassName="auth-progress-modal-wrap"
      footer={[
        <Button
          key="close"
          disabled={authSuccessClosing}
          onClick={onClose}
        >
          {authSuccessClosing
            ? '3 秒后自动关闭'
            : (addJob?.status === 'running' ? '关闭 / 取消' : '关闭')}
        </Button>
      ]}
      closable={!authSuccessClosing}
      keyboard={!authSuccessClosing}
      maskClosable={!authSuccessClosing}
      onCancel={onClose}
      width={760}
    >
      {addJob ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <AuthJobStatusPanel
            job={addJob}
            title={subjectLabel || (addJob.authMode === 'oauth-device' ? '设备码授权' : 'OAuth 授权')}
            successClosing={authSuccessClosing}
          />

          {addJob.installRequired && addJob.setupPhase === 'awaiting-install-confirmation' ? (
            <Card size="small" title="需要安装 CLI" className="hud-panel hud-panel--sm aih-overlay-section">
              <Space direction="vertical" style={{ width: '100%' }}>
                <Text>检测到未安装 {providerNames[addJob.provider] || addJob.provider} CLI。</Text>
                <Text type="secondary" className="aih-overlay-hint">确认后将在后台静默安装；安装成功会自动继续账号授权。</Text>
                <Button type="primary" loading={cliInstallSubmitting} onClick={onConfirmCliInstall}>
                  确认并安装
                </Button>
              </Space>
            </Card>
          ) : null}

          {addJob.setupPhase === 'installing' ? (
            <InlineNote tone="info" description="安装输出会实时显示在下方日志中，成功后自动继续授权。">
              正在安装 CLI
            </InlineNote>
          ) : null}

          {Boolean(addJob.expiresAt || addJob.pollIntervalMs) && (
            <Card size="small" title="授权状态" className="hud-panel hud-panel--sm aih-overlay-section">
              {addJob.expiresAt ? (
                <div className="aih-kv">
                  <span className="hud-label">过期时间</span>
                  <span className="aih-kv-value">{dayjs(addJob.expiresAt).format('YYYY-MM-DD HH:mm:ss')}</span>
                </div>
              ) : null}
              {addJob.pollIntervalMs ? (
                <div className="aih-kv">
                  <span className="hud-label">建议轮询间隔</span>
                  <span className="aih-kv-value">{Math.round(addJob.pollIntervalMs / 1000)} 秒</span>
                </div>
              ) : null}
            </Card>
          )}

          {addJob.authMode === 'oauth-browser' && !addJob.installRequired && (
            <Card size="small" title="浏览器授权" className="hud-panel hud-panel--sm aih-overlay-section">
              {renderAuthDetail(
                '邮箱',
                getAuthJobIdentity(addJob, subjectLabel),
                { copyMessage: '已复制邮箱' }
              )}
              {renderAuthDetail(
                '授权链接',
                addJob.authorizationUrl || addJob.verificationUriComplete || addJob.verificationUri || '',
                { copyMessage: '已复制授权链接', openable: true }
              )}
              {addJob.callbackCaptureStatus ? (
                <InlineNote
                  className="auth-progress-capture-note"
                  tone={addJob.callbackCaptureStatus === 'unavailable' ? 'warning' : 'info'}
                  description={addJob.callbackCaptureStatus === 'unavailable'
                    ? (addJob.callbackCaptureError || '请授权后把浏览器地址栏里的完整回调地址粘贴到下方。')
                    : (addJob.callbackListeningUrl || addJob.redirectUri || '等待浏览器授权回调。')}
                >
                  {addJob.callbackCaptureStatus === 'unavailable'
                    ? '本地自动接收不可用'
                    : '本地自动接收已启动'}
                </InlineNote>
              ) : null}
              {addJob.status === 'running' ? (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Text type="secondary" className="aih-overlay-hint">{getCallbackUiCopy(addJob.provider).hint}</Text>
                  <Input.TextArea
                    value={authCallbackUrl}
                    onChange={(event) => onCallbackUrlChange(event.target.value)}
                    placeholder={getCallbackUiCopy(addJob.provider).placeholder}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                  />
                  <Button
                    type="primary"
                    onClick={onSubmitBrowserCallback}
                    loading={authCallbackSubmitting}
                    disabled={!canSubmitCallback}
                  >
                    {getCallbackUiCopy(addJob.provider).submitLabel}
                  </Button>
                </Space>
              ) : null}
            </Card>
          )}

          {addJob.authMode === 'oauth-device' && (addJob.userCode || addJob.verificationUri || addJob.verificationUriComplete) && (
            <Card size="small" title="设备码信息" className="hud-panel hud-panel--sm aih-overlay-section">
              {renderAuthDetail('验证码', addJob.userCode || '', { copyMessage: '已复制验证码', code: true })}
              {renderAuthDetail(
                '授权链接',
                addJob.verificationUriComplete || addJob.verificationUri || '',
                { copyMessage: '已复制授权链接', openable: true }
              )}
            </Card>
          )}

          <Collapse
            size="small"
            items={[
              {
                key: 'logs',
                label: '授权日志',
                children: (
                  <pre className="aih-log">
                    {String(addJob.logs || '').trimStart() || '等待供应商返回授权输出...'}
                  </pre>
                )
              }
            ]}
          />
        </Space>
      ) : null}
    </Modal>
  );
}