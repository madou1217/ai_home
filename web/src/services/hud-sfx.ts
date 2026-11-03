// Web Audio 微反馈合成器：原生 OscillatorNode 合成极短的机械提示音，不加载任何音频文件。
// 开关由 hud-preferences 的 sfx 决定；AudioContext 在首次用户手势时惰性创建
// （浏览器自动播放策略要求），不可用时静默降级。

import { hudPreferences } from '@/services/hud-preferences';

type Wave = OscillatorType;

const MASTER_GAIN = 0.035;

let context: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!context) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      context = new Ctor();
    } catch {
      return null;
    }
  }
  if (context.state === 'suspended') {
    void context.resume().catch(() => {});
  }
  return context;
}

function tone(frequency: number, duration: number, wave: Wave = 'sine', delay = 0) {
  if (!hudPreferences.get().sfx) return;
  const ctx = getContext();
  if (!ctx) return;
  try {
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(MASTER_GAIN, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    // 音效只是装饰，任何失败都不影响交互
  }
}

export const hudSfx = {
  /** 按键 / 导航点击 */
  click() {
    tone(1200, 0.03, 'triangle');
  },
  /** 弹窗 / 抽屉打开 */
  open() {
    tone(660, 0.05, 'sine');
    tone(990, 0.06, 'sine', 0.045);
  },
  /** 成功提示 */
  success() {
    tone(587, 0.08, 'sine');
    tone(880, 0.12, 'sine', 0.06);
  },
  /** 警告 / 错误提示 */
  warn() {
    tone(440, 0.1, 'sawtooth');
    tone(330, 0.15, 'sawtooth', 0.08);
  },
};
