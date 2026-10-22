// 全局划词翻译浮层。
//
// 交互：在任意页面选中一段文本 → 选区末尾出现一个小图标 → 点击弹出浮层并开始流式翻译。
// 快捷键 ⇧⌘T 跳过小图标直接翻译当前选区。
//
// 三条边界（不满足就会变成「碍事的弹窗」）：
//   1. 不在输入框 / 文本域 / contenteditable 里抢选区（用户是在编辑，不是在阅读）；
//   2. 选区太长（> MAX_FLOATING_SELECTION_CHARS）不弹，浮层不是文档翻译器；
//   3. 浮层里的目标语言只影响这一次（不写回默认值），避免一次临时切换污染页面默认。
//
// 目标语言 / 模型 / 默认值来自 translation-settings-store —— 与 /translation 页共用同一份设置。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Select, message } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import type { TranslationLanguage } from '@/types';
import { translationAPI } from '@/services/api';
import {
  AUTO_LANGUAGE,
  MAX_FLOATING_SELECTION_CHARS,
  buildLanguageOptions,
  computeFloatingAnchor,
  isSameTranslationLanguage,
  languageLabelOf,
  resolveTranslationSelection,
  shortcutLabel,
  shouldOfferFloatingTranslation,
  type FloatingAnchor,
} from './translation-utils';
import {
  getTranslationBootstrap,
  loadTranslationBootstrap,
  type TranslationBootstrap,
} from './translation-settings-store';
import {
  getTranslationFloatingPreferences,
  subscribeTranslationFloatingPreferences,
} from './translation-preferences';
import { useTranslationStream } from './use-translation';
import { useTranslationHistoryRecorder } from './use-translation-history';
import styles from './translation-floating.module.css';

const TRIGGER_SIZE = 28;
const PANEL_WIDTH = 380;
const PANEL_ESTIMATED_HEIGHT = 220;
const DEFAULT_TARGET = 'zh-Hans';

interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface TriggerState {
  text: string;
  rect: SelectionRect;
}

interface PanelState {
  text: string;
  rect: SelectionRect;
}

function isEditableNode(node: Node | null): boolean {
  let element: HTMLElement | null = null;
  if (node && node.nodeType === Node.ELEMENT_NODE) {
    element = node as HTMLElement;
  } else if (node && node.parentElement) {
    element = node.parentElement;
  }
  while (element) {
    const tag = element.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (element.isContentEditable) return true;
    element = element.parentElement;
  }
  return false;
}

function readSelection(): { text: string; rect: SelectionRect; anchorNode: Node | null } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString().trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  return {
    text,
    anchorNode: selection.anchorNode,
    rect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
  };
}

export default function TranslationFloatingPanel() {
  const [enabled, setEnabled] = useState(() => getTranslationFloatingPreferences().enabled);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [panelHeight, setPanelHeight] = useState(PANEL_ESTIMATED_HEIGHT);
  const [languages, setLanguages] = useState<TranslationLanguage[]>([]);
  const [panelTarget, setPanelTarget] = useState(DEFAULT_TARGET);
  const [panelSource, setPanelSource] = useState('');
  const [preparing, setPreparing] = useState(false);

  const bootstrapRef = useRef<TranslationBootstrap | null>(getTranslationBootstrap());
  const panelTargetRef = useRef(DEFAULT_TARGET);
  const openTokenRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const stream = useTranslationStream();
  useTranslationHistoryRecorder(stream.state);

  useEffect(
    () =>
      subscribeTranslationFloatingPreferences((preferences) => {
        setEnabled(preferences.enabled);
        if (!preferences.enabled) {
          setTrigger(null);
          setPanel(null);
        }
      }),
    [],
  );

  const closePanel = useCallback(() => {
    openTokenRef.current += 1;
    setPanel(null);
    setPreparing(false);
    stream.reset();
  }, [stream]);

  const runTranslation = useCallback(
    (text: string, target: string, bootstrap: TranslationBootstrap | null) => {
      const selection = resolveTranslationSelection(
        bootstrap?.settings || null,
        bootstrap?.models || [],
        {
          model: bootstrap?.defaultModel || bootstrap?.autoModel || '',
          provider: bootstrap?.defaultProvider || bootstrap?.autoProvider || '',
        },
      );
      void stream.run({
        text,
        source: AUTO_LANGUAGE,
        target,
        model: selection.model,
        provider: selection.provider,
      });
    },
    [stream],
  );

  const openPanel = useCallback(
    async (text: string, rect: SelectionRect) => {
      const token = ++openTokenRef.current;
      setTrigger(null);
      setPanel({ text, rect });
      setPanelSource('');
      setPreparing(true);
      stream.reset();

      // 语言检测与 bootstrap 并行：检测只读本地规则，不依赖模型/设置。
      const detectionPromise = translationAPI
        .detect(text.slice(0, 4000))
        .catch(() => null);

      let bootstrap = bootstrapRef.current || getTranslationBootstrap();
      if (!bootstrap) {
        try {
          bootstrap = await loadTranslationBootstrap();
        } catch (_error) {
          bootstrap = null;
        }
      }
      if (token !== openTokenRef.current) return;
      bootstrapRef.current = bootstrap;
      setLanguages(bootstrap?.languages || []);
      const target = bootstrap?.settings.target || DEFAULT_TARGET;
      panelTargetRef.current = target;
      setPanelTarget(target);

      const detection = await detectionPromise;
      if (token !== openTokenRef.current) return;
      const detected = String(detection?.code || '').trim();
      setPanelSource(detected);
      setPreparing(false);
      // 检测/加载期间用户可能已经改过目标语言，以最新选择为准。
      const currentTarget = panelTargetRef.current;
      // 原文已经是目标语言：停掉准备期间可能已启动的请求，不发翻译、不落历史记录。
      if (detected && detected === currentTarget) {
        stream.reset();
        return;
      }
      runTranslation(text, currentTarget, bootstrap);
    },
    [runTranslation, stream],
  );

  // 选区 → 小图标
  useEffect(() => {
    if (!enabled) {
      setTrigger(null);
      return;
    }

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-translation-floating]')) return;
      window.setTimeout(() => {
        const selection = readSelection();
        if (!selection) {
          setTrigger(null);
          return;
        }
        const offered = shouldOfferFloatingTranslation({
          selectionText: selection.text,
          inEditable: isEditableNode(selection.anchorNode),
          enabled,
        });
        setTrigger(offered ? { text: selection.text, rect: selection.rect } : null);
      }, 0);
    };

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) setTrigger(null);
    };

    const handleScroll = () => setTrigger(null);

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [enabled]);

  // 快捷键：⇧⌘T 直接翻译选区（显式按键，允许在输入框内使用）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel) {
        closePanel();
        return;
      }
      const isShortcut =
        (event.metaKey || event.ctrlKey) &&
        (event.altKey || event.shiftKey) &&
        String(event.key).toLowerCase() === 't';
      if (!isShortcut || !enabled) return;
      const selection = readSelection();
      if (!selection) return;
      if (selection.text.length > MAX_FLOATING_SELECTION_CHARS) return;
      event.preventDefault();
      void openPanel(selection.text, selection.rect);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enabled, panel, closePanel, openPanel]);

  // 点击浮层外部关闭
  useEffect(() => {
    if (!panel) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      // 语言下拉默认 portal 到 body，不在 panelRef 内；点选项时若按「外部点击」
      // 关闭面板，onChange 还没执行浮层就消失了。这里把下拉自身排除在外。
      if (target?.closest?.(`.${styles.targetSelectPopup}`)) return;
      closePanel();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [panel, closePanel]);

  // 面板实际高度与估算不同时重新夹取位置（长译文可能顶到视口外）
  useLayoutEffect(() => {
    if (!panel || !panelRef.current) return;
    const height = panelRef.current.offsetHeight;
    if (height && Math.abs(height - panelHeight) > 4) setPanelHeight(height);
  }, [panel, panelHeight, stream.state.text]);

  const triggerAnchor = useMemo<FloatingAnchor | null>(() => {
    if (!trigger || typeof window === 'undefined') return null;
    return computeFloatingAnchor(
      trigger.rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: TRIGGER_SIZE, height: TRIGGER_SIZE },
      6,
    );
  }, [trigger]);

  const panelAnchor = useMemo<FloatingAnchor | null>(() => {
    if (!panel || typeof window === 'undefined') return null;
    return computeFloatingAnchor(
      panel.rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: Math.min(PANEL_WIDTH, window.innerWidth - 24), height: panelHeight },
      12,
    );
  }, [panel, panelHeight]);

  const targetOptions = useMemo(
    () => buildLanguageOptions(languages, { includeAuto: false }),
    [languages],
  );

  const meta = stream.state.meta;
  const sameLanguage = isSameTranslationLanguage(AUTO_LANGUAGE, panelTarget, panelSource);
  const routeLabel = meta
    ? `${meta.fromLabel} → ${meta.toLabel}`
    : `${languageLabelOf(languages, panelSource)} → ${languageLabelOf(languages, panelTarget)}`;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {trigger && triggerAnchor ? (
        <button
          ref={triggerRef}
          type="button"
          data-translation-floating
          className={styles.trigger}
          style={{ left: triggerAnchor.left, top: triggerAnchor.top }}
          title={`翻译选中内容（${shortcutLabel()}）`}
          aria-label="翻译选中内容"
          onMouseDown={(event) => {
            // 阻止默认行为会让选区保持不变，点击时才有内容可翻。
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={() => void openPanel(trigger.text, trigger.rect)}
        >
          <span className={styles.triggerGlyph}>译</span>
        </button>
      ) : null}

      {panel && panelAnchor ? (
        <div
          ref={panelRef}
          data-translation-floating
          className={styles.panel}
          style={{ left: panelAnchor.left, top: panelAnchor.top }}
          role="dialog"
          aria-label="划词翻译"
        >
          <header className={styles.panelHeader}>
            <span className={styles.route}>{routeLabel}</span>
            <div className={styles.headerActions}>
              <Select
                size="small"
                className={styles.targetSelect}
                value={panelTarget}
                options={targetOptions}
                disabled={!targetOptions.length}
                popupMatchSelectWidth={false}
                popupClassName={styles.targetSelectPopup}
                onChange={(value) => {
                  panelTargetRef.current = value;
                  setPanelTarget(value);
                  if (!panel.text) return;
                  // 切到「原文语言」时立即停掉当前翻译，正文改为提示；切回其它语言重新翻译。
                  if (isSameTranslationLanguage(AUTO_LANGUAGE, value, panelSource)) {
                    stream.reset();
                    return;
                  }
                  runTranslation(panel.text, value, bootstrapRef.current);
                }}
              />
              <button
                type="button"
                className={styles.iconButton}
                aria-label="关闭"
                onClick={closePanel}
              >
                <CloseOutlined />
              </button>
            </div>
          </header>

          <div className={styles.panelBody}>
            {preparing ? (
              <span className={styles.placeholder}>正在准备翻译…</span>
            ) : sameLanguage ? (
              <span className={styles.placeholder}>
                原文已是{languageLabelOf(languages, panelTarget)}，无需翻译
              </span>
            ) : stream.state.text ? (
              <div className={styles.text}>
                {stream.state.text}
                {stream.busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
              </div>
            ) : stream.state.status === 'error' ? null : (
              <span className={styles.placeholder}>
                {stream.busy ? '正在翻译…' : '选中文本后点击「译」'}
              </span>
            )}
            {stream.state.status === 'error' && stream.state.error ? (
              <div className={styles.errorRow}>
                <span className={styles.errorText}>{stream.state.error.message}</span>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    if (panel.text) runTranslation(panel.text, panelTarget, bootstrapRef.current);
                  }}
                >
                  重试
                </button>
              </div>
            ) : null}
          </div>

          <footer className={styles.panelFooter}>
            <span className={styles.meta}>
              {meta ? `${meta.model}${meta.provider ? ` · ${meta.provider}` : ''}` : ''}
              {stream.state.status === 'done' && stream.state.elapsedMs
                ? ` · ${(stream.state.elapsedMs / 1000).toFixed(1)}s`
                : ''}
            </span>
            <div className={styles.footerActions}>
              {stream.busy ? (
                <button type="button" className={styles.textButton} onClick={stream.cancel}>
                  停止
                </button>
              ) : null}
              <button
                type="button"
                className={styles.textButton}
                disabled={!stream.state.text.trim()}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(stream.state.text);
                    message.success('译文已复制');
                  } catch (_error) {
                    message.error('复制失败，请手动选择译文');
                  }
                }}
              >
                <CheckOutlined /> 复制
              </button>
            </div>
          </footer>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
