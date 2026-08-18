import { useEffect, useRef, useState } from 'react';
import { Tag } from 'antd';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { zcodeCaptchaAPI } from '@/services/api';
import type { ZcodeCaptchaChallenge, ZcodeCaptchaEvent } from '@/services/api';

// zcode OAuth 计划账号推理每请求强制阿里云 Captcha 2.0：服务端收到 3007 后经
// accounts watch 推 zcode-captcha 事件，本组件加载阿里 SDK 求解（先无感
// startTracelessVerification，失败转 popup 弹窗），success/fail(terminal pass)
// 拿到一次性 verify param 后回传 complete，服务端带验证码头重发上游。

declare global {
  interface Window {
    AliyunCaptchaConfig?: { region: string; prefix: string };
    initAliyunCaptcha?: (options: {
      SceneId: string;
      mode: string;
      language: string;
      showErrorTip: boolean;
      element: string;
      button: string;
      getInstance?: (instance: AliyunCaptchaInstance) => void;
      success?: (captchaVerifyParam: string) => void;
      fail?: (error: unknown) => void;
      onError?: (error: unknown) => void;
    }) => void;
  }
}

interface AliyunCaptchaInstance {
  show?: () => void;
  startTracelessVerification?: () => void;
}

const ALIYUN_CAPTCHA_SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

let sdkLoadingPromise: Promise<boolean> | null = null;

// 幂等加载阿里 Captcha SDK（桌面端同款 CDN）。
function loadAliyunCaptchaSdk(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (typeof window.initAliyunCaptcha === 'function') return Promise.resolve(true);
  if (sdkLoadingPromise) return sdkLoadingPromise;
  sdkLoadingPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = ALIYUN_CAPTCHA_SDK_URL;
    script.async = true;
    script.onload = () => resolve(typeof window.initAliyunCaptcha === 'function');
    script.onerror = () => {
      sdkLoadingPromise = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return sdkLoadingPromise;
}

// fail 回调的 err 可能是 JSON 字符串；携带 captchaVerifyParam 表示终端判定
// 其实已通过（terminal pass），直接用它，不必再弹窗。
function extractTerminalPassParam(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      return String(parsed && parsed.captchaVerifyParam || '');
    } catch (_error) {
      return '';
    }
  }
  if (typeof error === 'object') {
    return String((error as { captchaVerifyParam?: unknown }).captchaVerifyParam || '');
  }
  return '';
}

interface ActiveVerification {
  challenge: ZcodeCaptchaChallenge;
  phase: 'traceless' | 'interactive';
}

interface ZcodeCaptchaBridgeProps {
  event?: ZcodeCaptchaEvent | null;
}

function cleanupSdkDom(challengeId: string) {
  ['zcode-captcha-container', 'zcode-captcha-button'].forEach((prefix) => {
    const node = document.getElementById(`${prefix}-${challengeId}`);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  });
}

export default function ZcodeCaptchaBridge({ event }: ZcodeCaptchaBridgeProps) {
  const [queue, setQueue] = useState<ZcodeCaptchaChallenge[]>([]);
  const [active, setActive] = useState<ActiveVerification | null>(null);
  const activeRef = useRef<ActiveVerification | null>(null);
  activeRef.current = active;

  const completeChallenge = async (challenge: ZcodeCaptchaChallenge, verifyParam: string) => {
    cleanupSdkDom(challenge.id);
    setActive(null);
    await zcodeCaptchaAPI.complete(challenge.id, verifyParam, challenge.region).catch(() => {});
  };

  const dismissChallenge = async (challenge: ZcodeCaptchaChallenge) => {
    cleanupSdkDom(challenge.id);
    setActive(null);
    await zcodeCaptchaAPI.dismiss(challenge.id).catch(() => {});
  };

  const runVerification = async (challenge: ZcodeCaptchaChallenge) => {
    setActive({ challenge, phase: 'traceless' });
    const sdkReady = await loadAliyunCaptchaSdk();
    if (!sdkReady || typeof window.initAliyunCaptcha !== 'function') {
      await dismissChallenge(challenge);
      return;
    }
    // 阿里 SDK 需要可挂载元素，display:none 会导致弹窗失败；桌面端同款做法：
    // aria-hidden + 视觉离屏的 1px 容器。
    const container = document.createElement('div');
    container.id = `zcode-captcha-container-${challenge.id}`;
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;';
    const button = document.createElement('button');
    button.id = `zcode-captcha-button-${challenge.id}`;
    button.type = 'button';
    container.appendChild(button);
    document.body.appendChild(container);

    window.AliyunCaptchaConfig = { region: challenge.region, prefix: challenge.prefix };
    window.initAliyunCaptcha({
      SceneId: challenge.sceneId,
      mode: 'popup',
      language: challenge.language || 'cn',
      showErrorTip: false,
      element: `#${container.id}`,
      button: `#${button.id}`,
      getInstance: (instance: AliyunCaptchaInstance) => {
        // 优先无感验证；不可用或失败转 interactive 弹窗给人点。
        try {
          if (instance && typeof instance.startTracelessVerification === 'function') {
            instance.startTracelessVerification();
            return;
          }
        } catch (_error) { /* fall through to interactive */ }
        setActive((current) => (current ? { ...current, phase: 'interactive' } : current));
        try {
          if (instance && typeof instance.show === 'function') instance.show();
        } catch (_error) {
          void dismissChallenge(challenge);
        }
      },
      success: (captchaVerifyParam: string) => {
        void completeChallenge(challenge, String(captchaVerifyParam || ''));
      },
      fail: (error: unknown) => {
        const terminalPass = extractTerminalPassParam(error);
        if (terminalPass) {
          void completeChallenge(challenge, terminalPass);
          return;
        }
        // 无感失败 → 转 interactive 弹窗。
        setActive((current) => (current ? { ...current, phase: 'interactive' } : current));
      },
      onError: () => {
        void dismissChallenge(challenge);
      }
    });
  };

  // 页面加载时恢复服务端未完成的挑战（刷新不丢验证）。
  useEffect(() => {
    let cancelled = false;
    zcodeCaptchaAPI.fetchPending()
      .then((challenges) => {
        if (cancelled || challenges.length === 0) return;
        setQueue((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...challenges.filter((item) => !known.has(item.id))];
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // accounts watch 事件：required 入队；resolved/expired 出队（别的标签页已处理
  // 或服务端已超时，正在跑的直接清理，不再回传 dismiss）。
  useEffect(() => {
    if (!event || !event.challenge) return;
    const { state, challenge } = event;
    if (state === 'required') {
      setQueue((current) => (
        current.some((item) => item.id === challenge.id) || activeRef.current?.challenge.id === challenge.id
          ? current
          : [...current, challenge]
      ));
      return;
    }
    if (state === 'resolved' || state === 'expired') {
      setQueue((current) => current.filter((item) => item.id !== challenge.id));
      if (activeRef.current?.challenge.id === challenge.id) {
        cleanupSdkDom(challenge.id);
        setActive(null);
      }
    }
  }, [event]);

  // 串行消费队列：阿里 SDK popup 单实例，多账号并发时逐个跑。
  useEffect(() => {
    if (active || queue.length === 0) return;
    const challenge = queue[0];
    setQueue((current) => current.filter((item) => item.id !== challenge.id));
    void runVerification(challenge);
  }, [active, queue]);

  if (!active) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }}
    >
      <Tag icon={<SafetyCertificateOutlined />} color="processing" style={{ marginInlineEnd: 0 }}>
        {active.phase === 'interactive' ? 'ZCode 需要在弹窗中完成人机验证' : 'ZCode 人机验证中…'}
      </Tag>
    </div>
  );
}
