import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, QRCode, Spin, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import {
  KIMI_DESKTOP_SESSION_POLL_MS,
  getKimiDesktopSessionStatusTagColor,
  getKimiDesktopSessionStatusText,
  resolveKimiDesktopPollPhase,
  resolveKimiDesktopSessionExpiryDelay
} from '@/features/accounts/kimi-desktop-login';
import type { KimiDesktopLoginPhase } from '@/features/accounts/kimi-desktop-login';

interface KimiDesktopLoginModalProps {
  open: boolean;
  accountRef: string;
  accountLabel: string;
  onClose: () => void;
  onSuccess?: () => void;
}

export function KimiDesktopLoginModal({ open, accountRef, accountLabel, onClose, onSuccess }: KimiDesktopLoginModalProps) {
  const [phase, setPhase] = useState<KimiDesktopLoginPhase>('loading');
  const [qrUrl, setQrUrl] = useState('');
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    onCloseRef.current = onClose;
    onSuccessRef.current = onSuccess;
  }, [onClose, onSuccess]);

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

  const startSession = useCallback(async () => {
    const generation = ++generationRef.current;
    stopPolling();
    setPhase('loading');
    setQrUrl('');
    try {
      const result = await accountsAPI.startKimiDesktopSession(accountRef);
      if (generationRef.current !== generation) return;
      if (!result.ok || !result.qrUrl || !result.code) {
        setPhase('error');
        message.error(result.error || '生成登录二维码失败');
        return;
      }
      const expiryDelayMs = resolveKimiDesktopSessionExpiryDelay(result.expiresAtMs);
      if (expiryDelayMs === null) {
        setPhase('error');
        message.error('登录二维码缺少有效期，请重新生成');
        return;
      }
      setQrUrl(result.qrUrl);
      if (expiryDelayMs === 0) {
        setPhase('STATUS_EXPIRED');
        return;
      }
      setPhase('STATUS_PENDING');
      const code = result.code;
      const expiresAtMs = result.expiresAtMs;
      expiryTimerRef.current = setTimeout(() => {
        if (generationRef.current !== generation) return;
        stopPolling();
        setPhase('STATUS_EXPIRED');
      }, expiryDelayMs);
      pollTimerRef.current = setInterval(async () => {
        try {
          const polled = await accountsAPI.pollKimiDesktopSession(accountRef, code);
          if (generationRef.current !== generation) return;
          if (!polled.ok || !polled.status) {
            stopPolling();
            setPhase('error');
            message.error(polled.error || '查询扫码状态失败');
            return;
          }
          const nextPhase = resolveKimiDesktopPollPhase(polled.status, expiresAtMs);
          setPhase(nextPhase);
          if (nextPhase === 'STATUS_SUCCESS') {
            stopPolling();
            message.success('桌面登录成功，session 已托管');
            if (onSuccessRef.current) onSuccessRef.current();
            else onCloseRef.current();
          } else if (nextPhase === 'STATUS_EXPIRED') {
            stopPolling();
          }
        } catch (pollError: any) {
          if (generationRef.current !== generation) return;
          if (resolveKimiDesktopSessionExpiryDelay(expiresAtMs) === 0) {
            stopPolling();
            setPhase('STATUS_EXPIRED');
            return;
          }
          stopPolling();
          setPhase('error');
          message.error(pollError?.response?.data?.error || pollError?.message || '查询扫码状态失败');
        }
      }, KIMI_DESKTOP_SESSION_POLL_MS);
    } catch (startError: any) {
      if (generationRef.current !== generation) return;
      setPhase('error');
      message.error(startError?.response?.data?.error || startError?.message || '生成登录二维码失败');
    }
  }, [accountRef, stopPolling]);

  useEffect(() => {
    if (!open || !accountRef) return undefined;
    void startSession();
    return () => {
      generationRef.current += 1;
      stopPolling();
    };
  }, [open, accountRef, startSession, stopPolling]);

  const qrStatus = phase === 'STATUS_SCANNED' ? 'scanned' : phase === 'STATUS_EXPIRED' ? 'expired' : 'active';

  return (
    <Modal
      open={open}
      title={accountLabel ? `桌面托管登录 · ${accountLabel}` : '桌面托管登录'}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
      width={360}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '8px 0' }}>
        {phase === 'loading' ? (
          <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Spin />
          </div>
        ) : qrUrl ? (
          <QRCode
            value={qrUrl}
            size={200}
            status={qrStatus}
            onRefresh={phase === 'STATUS_EXPIRED' ? () => void startSession() : undefined}
          />
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tag color={getKimiDesktopSessionStatusTagColor(phase)} style={{ margin: 0 }}>
            {getKimiDesktopSessionStatusText(phase)}
          </Tag>
          {phase === 'error' || phase === 'STATUS_EXPIRED' ? (
            <Button size="small" onClick={() => void startSession()}>
              重新生成
            </Button>
          ) : null}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          使用微信扫码确认后，桌面登录态将由 ai-home 托管，二维码约 3 分钟内有效。
        </Typography.Text>
      </div>
    </Modal>
  );
}
