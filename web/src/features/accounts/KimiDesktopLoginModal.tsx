import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, QRCode, Spin, Tag, Typography, message } from 'antd';
import { accountsAPI } from '@/services/api';
import {
  getKimiDesktopSessionStatusTagColor,
  getKimiDesktopSessionStatusText,
  resolveKimiDesktopSessionExpiryDelay
} from '@/features/accounts/kimi-desktop-login';
import type { KimiDesktopLoginPhase } from '@/features/accounts/kimi-desktop-login';
import './account-overlays.css';

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
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const onCloseRef = useRef(onClose);
  const onSuccessRef = useRef(onSuccess);

  useEffect(() => {
    onCloseRef.current = onClose;
    onSuccessRef.current = onSuccess;
  }, [onClose, onSuccess]);

  const stopPolling = useCallback(() => {
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
      expiryTimerRef.current = setTimeout(() => {
        if (generationRef.current !== generation) return;
        stopPolling();
        setPhase('STATUS_EXPIRED');
      }, expiryDelayMs);
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
      <div className="kimi-desktop-login">
        {phase === 'loading' || qrUrl ? (
          <div className="kimi-desktop-login-frame hud-panel hud-panel--sm">
            {phase === 'loading' ? (
              <div className="kimi-desktop-login-loading">
                <Spin />
              </div>
            ) : (
              <QRCode
                value={qrUrl}
                size={200}
                status={qrStatus}
                onRefresh={phase === 'STATUS_EXPIRED' ? () => void startSession() : undefined}
              />
            )}
          </div>
        ) : null}
        <div className="kimi-desktop-login-state">
          <Tag color={getKimiDesktopSessionStatusTagColor(phase)}>
            {getKimiDesktopSessionStatusText(phase)}
          </Tag>
          {phase === 'error' || phase === 'STATUS_EXPIRED' ? (
            <Button size="small" onClick={() => void startSession()}>
              重新生成
            </Button>
          ) : null}
        </div>
        <Typography.Text type="secondary" className="aih-overlay-hint">
          使用微信扫码确认后，桌面登录态将由 ai-home 托管，二维码约 3 分钟内有效。
        </Typography.Text>
      </div>
    </Modal>
  );
}
