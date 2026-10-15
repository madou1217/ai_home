import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Space, Tabs, Tag, Typography, message } from 'antd';
import { kiroNativeLoginAPI } from '@/services/kiro-native-login';
import { openExternalUrl } from '@/services/open-external-url';
import {
  getKiroLoginStatusTagColor,
  getKiroLoginStatusText,
  isKiroLoginTerminal,
  resolveKiroLoginExpiryDelay,
  resolveKiroLoginPhase,
  resolveKiroLoginPollIntervalMs
} from '@/features/accounts/kiro-native-login';
import type { KiroNativeLoginPhase } from '@/features/accounts/kiro-native-login';
import './account-overlays.css';
import './KiroNativeLoginModal.css';

interface KiroNativeLoginModalProps {
  open: boolean;
  onClose: () => void;
  onAdded?: () => void | Promise<void>;
}

/**
 * Kiro 免 CLI 登录：设备码（Builder ID / IAM Identity Center）与 refresh_token 两条入口。
 * 用户只要在**任意设备**打开验证地址并输入 code 即可（SSH / 无浏览器环境同样可用）。
 */
export function KiroNativeLoginModal({ open, onClose, onAdded }: KiroNativeLoginModalProps) {
  const [tab, setTab] = useState<'device' | 'refresh-token'>('device');
  const [phase, setPhase] = useState<KiroNativeLoginPhase>('loading');
  const [userCode, setUserCode] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [profileArn, setProfileArn] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onAddedRef = useRef(onAdded);

  useEffect(() => {
    onCloseRef.current = onClose;
    onAddedRef.current = onAdded;
  }, [onClose, onAdded]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (expiryTimerRef.current !== null) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const finishSuccess = useCallback(async (label: string) => {
    message.success(label);
    if (onAddedRef.current) await onAddedRef.current();
    onCloseRef.current();
  }, []);

  const startDeviceLogin = useCallback(async () => {
    const generation = ++generationRef.current;
    stopPolling();
    setPhase('loading');
    setUserCode('');
    setVerifyUrl('');
    try {
      const started = await kiroNativeLoginAPI.start();
      if (generationRef.current !== generation) return;
      if (!started.ok || !started.flowId || !started.userCode) {
        setPhase('error');
        message.error(started.error || '获取设备码失败');
        return;
      }
      const expiryDelayMs = resolveKiroLoginExpiryDelay(started.expiresAtMs);
      if (expiryDelayMs === null) {
        setPhase('error');
        message.error('设备码缺少有效期，请重新获取');
        return;
      }
      setUserCode(started.userCode);
      setVerifyUrl(started.verificationUriComplete || started.verificationUri || '');
      if (expiryDelayMs === 0) {
        setPhase('expired');
        return;
      }
      setPhase('pending');
      const { flowId } = started;
      const expiresAtMs = started.expiresAtMs;
      expiryTimerRef.current = setTimeout(() => {
        if (generationRef.current !== generation) return;
        stopPolling();
        setPhase('expired');
      }, expiryDelayMs);
      pollTimerRef.current = setInterval(async () => {
        try {
          const polled = await kiroNativeLoginAPI.poll(flowId);
          if (generationRef.current !== generation) return;
          if (!polled.ok || !polled.status) {
            // flow 404（过期/服务重启）或上游硬错误：停下让用户重新发起，不空转。
            stopPolling();
            setPhase('error');
            message.error(polled.error || '查询授权状态失败');
            return;
          }
          const nextPhase = resolveKiroLoginPhase(polled.status, expiresAtMs);
          setPhase(nextPhase);
          if (isKiroLoginTerminal(nextPhase)) {
            stopPolling();
            if (nextPhase === 'authorized') {
              await finishSuccess('Kiro 账号已加入');
            } else if (nextPhase === 'denied') {
              message.warning('授权被拒绝，请重新获取设备码');
            }
          }
        } catch (pollError: any) {
          if (generationRef.current !== generation) return;
          stopPolling();
          setPhase('error');
          message.error(pollError?.response?.data?.error || pollError?.message || '查询授权状态失败');
        }
      }, resolveKiroLoginPollIntervalMs(started.intervalSeconds));
    } catch (startError: any) {
      if (generationRef.current !== generation) return;
      setPhase('error');
      message.error(startError?.response?.data?.error || startError?.message || '获取设备码失败');
    }
  }, [finishSuccess, stopPolling]);

  useEffect(() => {
    if (!open) {
      generationRef.current += 1;
      stopPolling();
      return undefined;
    }
    setTab('device');
    setRefreshToken('');
    setProfileArn('');
    void startDeviceLogin();
    return () => {
      generationRef.current += 1;
      stopPolling();
    };
  }, [open, startDeviceLogin, stopPolling]);

  const submitRefreshToken = useCallback(async () => {
    const token = refreshToken.trim();
    if (!token) {
      message.warning('请粘贴 refresh_token');
      return;
    }
    setSubmitting(true);
    try {
      const imported = await kiroNativeLoginAPI.importRefreshToken({
        refreshToken: token,
        profileArn: profileArn.trim() || undefined
      });
      if (!imported.ok) {
        message.error(imported.error || '导入失败');
        return;
      }
      await finishSuccess('Kiro 账号已加入');
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '导入失败');
    } finally {
      setSubmitting(false);
    }
  }, [finishSuccess, profileArn, refreshToken]);

  const devicePanel = (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={8} align="center">
        <Tag color={getKiroLoginStatusTagColor(phase)}>{getKiroLoginStatusText(phase)}</Tag>
        <Button size="small" onClick={() => void startDeviceLogin()}>
          重新获取
        </Button>
      </Space>
      {userCode ? (
        <div className="kiro-native-login-code">
          <Typography.Text type="secondary">在验证页面输入下面的代码</Typography.Text>
          <Typography.Text className="aih-mono-input" copyable strong style={{ fontSize: 20, letterSpacing: 2 }}>
            {userCode}
          </Typography.Text>
          {verifyUrl ? (
            <Button type="link" size="small" onClick={() => void openExternalUrl(verifyUrl)}>
              打开验证页面
            </Button>
          ) : null}
        </div>
      ) : null}
      <Typography.Text type="secondary" className="aih-overlay-hint">
        在任意设备（手机 / 另一台电脑）打开验证页面并输入代码即可完成授权；SSH、无浏览器环境同样可用，
        不需要在本机安装 kiro CLI 或 Kiro IDE。
      </Typography.Text>
    </Space>
  );

  const refreshTokenPanel = (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Typography.Text type="secondary" className="aih-overlay-hint">
        适用于 Kiro Desktop / Google / GitHub 登录的账号：从 Kiro IDE 的
        <Typography.Text code>~/.aws/sso/cache/kiro-auth-token.json</Typography.Text>
        里取出 <Typography.Text code>refreshToken</Typography.Text> 粘贴到下面。
      </Typography.Text>
      <Input.TextArea
        value={refreshToken}
        onChange={(event) => setRefreshToken(event.target.value)}
        placeholder="refresh_token"
        autoSize={{ minRows: 3, maxRows: 6 }}
        className="aih-mono-input"
      />
      <Input
        value={profileArn}
        onChange={(event) => setProfileArn(event.target.value)}
        placeholder="profileArn（可选，企业账号可留空）"
      />
      <Button type="primary" loading={submitting} onClick={() => void submitRefreshToken()}>
        导入并加入账号
      </Button>
    </Space>
  );

  return (
    <Modal
      open={open}
      title="Kiro 免 CLI 登录"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      width={440}
    >
      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as 'device' | 'refresh-token')}
        items={[
          { key: 'device', label: '设备码授权', children: devicePanel },
          { key: 'refresh-token', label: 'refresh_token 导入', children: refreshTokenPanel }
        ]}
      />
    </Modal>
  );
}

export default KiroNativeLoginModal;
