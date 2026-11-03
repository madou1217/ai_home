import { writeClipboardText } from '@/utils/clipboard';
import { Button, Card, Collapse, Input, Modal, Space, Tooltip, Typography, message } from 'antd';
import { CopyOutlined, GlobalOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { providerNames } from '@/components/chat/ProviderIcon';
import { InlineNote } from '@/components/ui/InlineNote';
import { openExternalUrl } from '@/services/open-external-url';
import type { AccountAddJob } from '@/types';
import type { ProviderAuthMethodSources } from '@/services/api';
import './account-overlays.css';

const { Text } = Typography;

// Native CLI strategies may keep a CLI running and want an authorization code
// pasted in, while direct OAuth strategies accept a browser callback URL.
// Centralizing the strings (and the "must wait for the code prompt" gate) keeps
// the modal driven by strategy data instead of provider-specific branches.
type CallbackUiCopy = {
  hint: string;
  placeholder: string;
  submitLabel: string;
  emptyWarning: string;
  submitSuccess: string;
  requiresAwaitingCode: boolean;
};

export function getCallbackUiCopy(provider?: string, authStrategy = ''): CallbackUiCopy {
  if (authStrategy === 'native-cli') {
    return {
      hint: '授权后如果页面显示 authorization code，把完整授权码粘贴到这里，系统会写回 Antigravity CLI。',
      placeholder: '粘贴 Google 授权页返回的完整授权码',
      submitLabel: '提交授权码',
      emptyWarning: '请粘贴授权码',
      submitSuccess: '授权码已提交，正在确认授权结果',
      requiresAwaitingCode: true
    };
  }
  if (authStrategy === 'aih-google-oauth') {
    return {
      hint: '授权完成后，把浏览器地址栏里的完整回调地址粘贴到这里。AI Home 会直接换取 Antigravity OAuth 凭据，不需要安装 CLI 或 Desktop。',
      placeholder: '粘贴 Google 授权完成后的完整回调地址',
      submitLabel: '提交回调地址',
      emptyWarning: '请粘贴完整回调地址',
      submitSuccess: '回调地址已提交，正在确认授权结果',
      requiresAwaitingCode: false
    };
  }
  // kiro 只有 refresh_token 这一种认证方式会用到这个「粘贴并提交」入口
  // （设备码方式由服务端直接透出验证码，不需要粘贴），所以 provider 级别的文案就足够精确。
  if (provider === 'kiro') {
    return {
      hint: 'Kiro Desktop / Google / GitHub 账号：从 Kiro IDE 的 ~/.aws/sso/cache/kiro-auth-token.json 取出 refreshToken 粘贴到这里。',
      placeholder: 'refresh_token',
      submitLabel: '导入账号',
      emptyWarning: '请粘贴 refresh_token',
      submitSuccess: 'refresh_token 已提交，正在导入账号',
      requiresAwaitingCode: false
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
  pluginLoginSubmitValue: string;
  pluginLoginSubmitSubmitting: boolean;
  cliInstallSubmitting: boolean;
  canSubmitCallback: boolean;
  authSources: ProviderAuthMethodSources | null;
  localImportSubmitting: boolean;
  localInstallSubmitting: boolean;
  localScanSubmitting: boolean;
  socialSubmitting: boolean;
  onClose: () => void;
  onCallbackUrlChange: (url: string) => void;
  onSubmitBrowserCallback: () => void;
  onPluginLoginSubmitValueChange: (value: string) => void;
  onSubmitPluginLogin: () => void;
  onLocalImport: (sourceId: string) => void;
  onInstallLocalClient: (kind?: 'desktop' | 'cli') => void;
  onScanHostAccounts: () => void;
  onConfirmCliInstall: () => void;
  /** 切到 social（Google / Github）设备流 —— 与 Builder ID 是两套协议。 */
  onStartSocialDevice: (loginProvider: 'Google' | 'Github') => void;
}

export function AuthProgressModal({
  open,
  job: addJob,
  subjectLabel,
  successClosing: authSuccessClosing,
  callbackUrl: authCallbackUrl,
  callbackSubmitting: authCallbackSubmitting,
  pluginLoginSubmitValue,
  pluginLoginSubmitSubmitting,
  cliInstallSubmitting,
  canSubmitCallback,
  authSources,
  localImportSubmitting,
  localInstallSubmitting,
  localScanSubmitting,
  socialSubmitting,
  onClose,
  onCallbackUrlChange,
  onSubmitBrowserCallback,
  onPluginLoginSubmitValueChange,
  onSubmitPluginLogin,
  onLocalImport,
  onInstallLocalClient,
  onScanHostAccounts,
  onConfirmCliInstall,
  onStartSocialDevice
}: AuthProgressModalProps) {
  // 扫描来源（handler = host-account-scan）：本机登录态是整批的，走既有「扫描本机账号」入库。
  const preferredSource = authSources
    ? (authSources.sources || []).find((source) => source.id === authSources.preferredSourceId) || null
    : null;
  // social 设备流来源（handler = social-device-code）：只有它可用时才渲染切换按钮 ——
  // 界面不按 provider 名判断，只认来源链的结论。
  const socialDeviceSource = authSources
    ? (authSources.sources || []).find((source) => source.handler === 'social-device-code' && source.available) || null
    : null;
  const localScanSource = preferredSource && preferredSource.handler === 'host-account-scan' ? preferredSource : null;
  // 本机导入来源：可用、且是「读本机登录态直接入库」的实现（不是整批扫描）。与认证方式无关——
  // claude/codex/gemini/kimi 等 provider 的宿主登录态都走这一张卡片。
  const localImportSource = preferredSource
    && preferredSource.kind === 'local'
    && preferredSource.handler !== 'host-account-scan'
    ? preferredSource
    : null;
  const copyText = async (value: string, successMessage: string) => {
    const text = String(value || '').trim();
    if (!text) return;
    try {
      await writeClipboardText(text);
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

          {addJob.pluginLogin && addJob.canSubmit && addJob.status === 'running' && (
            <Card size="small" title="提交授权结果" className="hud-panel hud-panel--sm aih-overlay-section">
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Text type="secondary" className="aih-overlay-hint">
                  {addJob.submitPlaceholder || '粘贴授权码、回调地址或凭据，由插件完成登录。'}
                </Text>
                <Input.TextArea
                  value={pluginLoginSubmitValue}
                  onChange={(event) => onPluginLoginSubmitValueChange(event.target.value)}
                  placeholder={addJob.submitPlaceholder || '粘贴授权结果'}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                />
                <Button
                  type="primary"
                  loading={pluginLoginSubmitSubmitting}
                  disabled={!pluginLoginSubmitValue.trim()}
                  onClick={onSubmitPluginLogin}
                >
                  {addJob.submitLabel || '提交'}
                </Button>
              </Space>
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
                  tone={addJob.callbackCaptureStatus === 'listening' ? 'info' : 'warning'}
                  description={addJob.callbackCaptureStatus === 'listening'
                    ? (addJob.callbackListeningUrl || addJob.redirectUri || '等待浏览器授权回调。')
                    : (addJob.callbackCaptureError
                      || (addJob.callbackCaptureStatus === 'manual_only'
                        // 自定义协议（zcode://）不是 HTTP，本地收不到回调：唯一路径是手填。
                        ? '授权完成后浏览器会跳到一个本机应用地址，aih 收不到。请把浏览器地址栏里的完整地址复制粘贴到下方。'
                        : '请授权后把浏览器地址栏里的完整回调地址粘贴到下方。'))}
                >
                  {addJob.callbackCaptureStatus === 'listening'
                    ? '本地自动接收已启动'
                    : (addJob.callbackCaptureStatus === 'manual_only' ? '需要手动粘贴回调地址' : '本地自动接收不可用')}
                </InlineNote>
              ) : null}
              {addJob.status === 'running' && !addJob.pluginLogin ? (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Text type="secondary" className="aih-overlay-hint">{getCallbackUiCopy(addJob.provider, addJob.authStrategy).hint}</Text>
                  <Input.TextArea
                    value={authCallbackUrl}
                    onChange={(event) => onCallbackUrlChange(event.target.value)}
                    placeholder={getCallbackUiCopy(addJob.provider, addJob.authStrategy).placeholder}
                    autoSize={{ minRows: 2, maxRows: 4 }}
                  />
                  <Button
                    type="primary"
                    onClick={onSubmitBrowserCallback}
                    loading={authCallbackSubmitting}
                    disabled={!canSubmitCallback}
                  >
                    {getCallbackUiCopy(addJob.provider, addJob.authStrategy).submitLabel}
                  </Button>
                </Space>
              ) : null}
            </Card>
          )}

          {localImportSource && addJob.status === 'running' ? (
            <Card size="small" title="从本机导入" className="hud-panel hud-panel--sm aih-overlay-section">
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Text type="secondary" className="aih-overlay-hint">
                  检测到本机 {providerNames[addJob.provider] || addJob.provider} 登录态，可直接导入，无需手动导出凭据。
                </Text>
                <Button
                  type="primary"
                  loading={localImportSubmitting}
                  onClick={() => onLocalImport(localImportSource.id)}
                >
                  从本机导入
                </Button>
              </Space>
            </Card>
          ) : null}

          {localScanSource && addJob.status === 'running' ? (
            <Card size="small" title="本机登录态" className="hud-panel hud-panel--sm aih-overlay-section">
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Text type="secondary" className="aih-overlay-hint">
                  检测到本机登录态，可直接扫描入库，不需要粘贴任何东西。
                </Text>
                <Button type="primary" loading={localScanSubmitting} onClick={onScanHostAccounts}>
                  扫描本机账号
                </Button>
              </Space>
            </Card>
          ) : null}

          {!localImportSource && !localScanSource && authSources && authSources.installableSourceId ? (
            <Card size="small" title="本机登录态" className="hud-panel hud-panel--sm aih-overlay-section">
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Text type="secondary" className="aih-overlay-hint">
                  未检测到本机登录态；装上对应客户端后即可一键导入。
                </Text>
                <Button
                  loading={localInstallSubmitting}
                  disabled={addJob.status !== 'running'}
                  onClick={() => onInstallLocalClient(authSources.sources
                    .find((source) => source.id === authSources.installableSourceId)?.requiresApp === 'cli' ? 'cli' : 'desktop')}
                >
                  安装客户端
                </Button>
              </Space>
            </Card>
          ) : null}

          {addJob.authMode === 'oauth-refresh-token' && (
            <Card size="small" title="refresh_token 导入" className="hud-panel hud-panel--sm aih-overlay-section">
              {renderAuthDetail('账号', getAuthJobIdentity(addJob, subjectLabel), { copyMessage: '已复制账号' })}
              {addJob.status === 'running' && !addJob.pluginLogin ? (
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
              {/* Google / GitHub 账号是**另一套设备流**（不是 Builder ID 的 AWS SSO OIDC）。
                  两者都能远程完成；这里给的是「当前这条走不通就换那条」的出口。 */}
              {socialDeviceSource && addJob.status === 'running' ? (
                <Space direction="vertical" style={{ width: '100%' }} size="small">
                  <Text type="secondary" className="aih-overlay-hint">
                    用 Google / GitHub 账号登录？那是另一套设备流（与 Builder ID 不通用）。
                  </Text>
                  <Space size={8}>
                    <Button size="small" loading={socialSubmitting} onClick={() => onStartSocialDevice('Google')}>
                      用 Google 登录
                    </Button>
                    <Button size="small" loading={socialSubmitting} onClick={() => onStartSocialDevice('Github')}>
                      用 GitHub 登录
                    </Button>
                  </Space>
                </Space>
              ) : null}
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
