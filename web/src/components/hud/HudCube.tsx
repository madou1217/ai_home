import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { hudSfx } from '@/services/hud-sfx';
import styles from './HudCube.module.css';

export type HudCubeMode = 'brand' | 'loading' | 'empty' | 'idle';
export type HudCubeTone = 'cyan' | 'ok' | 'warn' | 'err' | 'violet';

export interface HudCubeProps {
  /** 立方体边长（px）；外层舞台自动留出 1.5x 弹跳余量，不挤压周围布局 */
  size?: number;
  mode?: HudCubeMode;
  tone?: HudCubeTone;
  /** 是否允许悬停/点击/键盘触发果冻弹跳与 90° 切面翻转 */
  interactive?: boolean;
  /** 交互态无障碍名称；不传且非交互时自动 aria-hidden */
  label?: string;
  onActivate?: () => void;
  className?: string;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 3D 切面赛博玻璃魔方（HudCube）：
 * - 真实 6 切面 preserve-3d 透视几何 + 内部全息能量棱核 + 地面接触光环
 * - 一次性挂载入场（data-entering）与可重触发点击脉冲（data-impulse=a|b）完全解耦，脉冲结束后回到无动画静止态，绝不二次重播入场弹跳，也不遮蔽悬停/按压形变
 * - 使用 span[role="button"] 兼容 ProLayout 顶栏容器嵌套，零 validateDOMNesting 告警
 * - 严格遵循 prefers-reduced-motion（完全归零位移/缩放/旋转与脉冲）及 HUD SFX 开关
 */
export const HudCube = memo(function HudCube({
  size = 28,
  mode = 'brand',
  tone = 'cyan',
  interactive = mode === 'brand' || mode === 'empty',
  label,
  onActivate,
  className,
}: HudCubeProps) {
  const [entering, setEntering] = useState(() => mode !== 'loading' && !prefersReducedMotion());
  const [turnSteps, setTurnSteps] = useState(0);
  const [impulse, setImpulse] = useState<'a' | 'b' | null>(null);
  const lastImpulseRef = useRef<'a' | 'b'>('b');
  const impulseRef = useRef<'a' | 'b' | null>(null);
  const enterTimerRef = useRef<number | null>(null);
  const clearTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (mode !== 'loading' && !prefersReducedMotion()) {
      enterTimerRef.current = window.setTimeout(() => {
        setEntering(false);
        enterTimerRef.current = null;
      }, 720);
    }
    return () => {
      if (enterTimerRef.current !== null) {
        window.clearTimeout(enterTimerRef.current);
        enterTimerRef.current = null;
      }
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, [mode]);

  const clearEntrance = useCallback(() => {
    if (enterTimerRef.current !== null) {
      window.clearTimeout(enterTimerRef.current);
      enterTimerRef.current = null;
    }
    setEntering(false);
  }, []);

  const clearImpulse = useCallback(() => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    impulseRef.current = null;
    setImpulse(null);
  }, []);

  const handleJellyAnimationEnd = useCallback((event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.animationName.includes('cubeDropLand')) {
      clearEntrance();
      return;
    }
    const activeImpulse = impulseRef.current;
    if (
      (activeImpulse === 'a' && event.animationName.includes('cubeImpulseA'))
      || (activeImpulse === 'b' && event.animationName.includes('cubeImpulseB'))
    ) {
      clearImpulse();
    }
  }, [clearEntrance, clearImpulse]);

  const triggerBounce = useCallback(() => {
    clearEntrance();
    if (prefersReducedMotion()) {
      clearImpulse();
    } else {
      const nextImpulse = lastImpulseRef.current === 'a' ? 'b' : 'a';
      lastImpulseRef.current = nextImpulse;
      impulseRef.current = nextImpulse;
      setTurnSteps((current) => current + 1);
      setImpulse(nextImpulse);
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
      clearTimerRef.current = window.setTimeout(() => {
        impulseRef.current = null;
        setImpulse(null);
        clearTimerRef.current = null;
      }, 720);
    }
    hudSfx.jelly();
    onActivate?.();
  }, [clearEntrance, clearImpulse, onActivate]);

  const handleClick = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!interactive) return;
    event.preventDefault();
    event.stopPropagation();
    triggerBounce();
  }, [interactive, triggerBounce]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (!interactive) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      triggerBounce();
    }
  }, [interactive, triggerBounce]);

  const cubeStyle = {
    '--cube-size': `${size}px`,
    '--cube-turn': `${turnSteps * 90}deg`,
  } as CSSProperties;

  const rootClasses = [
    styles.root,
    styles[`mode_${mode}`],
    styles[`tone_${tone}`],
    interactive ? styles.interactive : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <span
      className={rootClasses}
      style={cubeStyle}
      data-hud-cube="true"
      data-entering={entering ? 'true' : undefined}
      data-impulse={impulse || undefined}
      role={interactive ? 'button' : (label ? 'img' : undefined)}
      tabIndex={interactive ? 0 : undefined}
      aria-hidden={!interactive && !label ? 'true' : undefined}
      aria-label={interactive ? (label || '触发全息魔方果冻弹跳') : label}
      title={interactive ? (label || '点击弹跳全息棱镜') : undefined}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
    >
      <span className={styles.pad} aria-hidden="true" />
      <span className={styles.jelly} aria-hidden="true" onAnimationEnd={handleJellyAnimationEnd}>
        <span className={styles.scene}>
          <span className={styles.rotor}>
            <span className={styles.coreA} />
            <span className={styles.coreB} />
            <span className={`${styles.face} ${styles.faceFront}`} />
            <span className={`${styles.face} ${styles.faceRight}`} />
            <span className={`${styles.face} ${styles.faceBack}`} />
            <span className={`${styles.face} ${styles.faceLeft}`} />
            <span className={`${styles.face} ${styles.faceTop}`} />
            <span className={`${styles.face} ${styles.faceBottom}`} />
          </span>
        </span>
      </span>
    </span>
  );
});

export default HudCube;
