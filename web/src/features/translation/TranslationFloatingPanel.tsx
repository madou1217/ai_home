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
import { CheckOutlined, CloseOutlined, CopyOutlined, PushpinOutlined, PushpinFilled, ReloadOutlined, TranslationOutlined } from '@ant-design/icons';
import type { TranslationLanguage } from '@/types';
import { translationAPI } from '@/services/api';
import {
  AUTO_LANGUAGE,
  MAX_FLOATING_SELECTION_CHARS,
  buildLanguageOptions,
  computeFloatingAnchor,
  languageLabelOf,
  resolveTranslationSelection,
  shortcutLabel,
  shouldOfferFloatingTranslation,
  type FloatingAnchor,
} from './translation-utils';
import {
  getTranslationBootstrap,
  loadTranslationBootstrap,
  resolveTranslationRoutesForRequest,
  shouldAutoCopy,
  writeTranslationClipboard,
  type TranslationBootstrap,
} from './translation-settings-store';
import {
  getTranslationFloatingPreferences,
  subscribeTranslationFloatingPreferences,
} from './translation-preferences';
import { useTranslationStream } from './use-translation';
import { resolveLanguageIntent, type TranslationTargetPolicy } from './language-intent';
import { useTranslationHistoryRecorder } from './use-translation-history';
import { useFloatingPanelPosition } from './use-floating-panel-position';
import { useSystemTranslationFocus } from './use-system-translation-focus';
import { useTranslationFeedback } from './use-translation-feedback';
import styles from './translation-floating.module.css';

const TRIGGER_SIZE = 28;
const PANEL_WIDTH = 408;
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
  const [panelConfidence, setPanelConfidence] = useState<'high' | 'medium' | 'low' | undefined>();
  const [preparing, setPreparing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [closing, setClosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [preparationCancelled, setPreparationCancelled] = useState(false);
  const [targetPolicy, setTargetPolicy] = useState<TranslationTargetPolicy>('saved');
  const [autoCopy, setAutoCopy] = useState(false);
  const [copyScope, setCopyScope] = useState<'selection' | 'page' | 'all'>('selection');
  const [confirmationDismissed, setConfirmationDismissed] = useState(false);
  const closeTimer = useRef<number>();
  const copyTimer = useRef<number>();
  const autoCopiedRequest = useRef<object | null>(null);

  const bootstrapRef = useRef<TranslationBootstrap | null>(getTranslationBootstrap());
  const panelTargetRef = useRef(DEFAULT_TARGET);
  const openTokenRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const { position, viewportRevision, dragging, resetPosition, pinToTop, ...dragHandlers } = useFloatingPanelPosition(panelRef);
  const stream = useTranslationStream();
  useTranslationHistoryRecorder(stream.state);
  useSystemTranslationFocus();

  useEffect(() => () => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(copyTimer.current);
  }, []);

  useEffect(() => {
    const request = stream.state.request;
    if (!autoCopy || stream.state.status !== 'done' || !request || autoCopiedRequest.current === request) return;
    const meta = stream.state.meta;
    if (meta && meta.from && meta.to && meta.from === meta.to) return;
    if (!shouldAutoCopy({ scope: copyScope, client: 'floating', mode: 'selection', event: { type: 'done', text: stream.state.text } })) return;
    autoCopiedRequest.current = request;
    void writeTranslationClipboard(stream.state.text).then(() => {
      window.clearTimeout(copyTimer.current); setCopied(true); copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [autoCopy, copyScope, stream.state.request, stream.state.status, stream.state.text]);

  useEffect(
    () =>
      subscribeTranslationFloatingPreferences((preferences) => {
        setEnabled(preferences.enabled);
        if (!preferences.enabled) {
          setTrigger(null);
          setPanel(null);
          openTokenRef.current += 1;
          setPreparing(false);
          window.clearTimeout(closeTimer.current);
          setClosing(false);
          setPinned(false);
          resetPosition();
          stream.reset();
        }
      }),
    [],
  );

  const closePanel = useCallback(() => {
    openTokenRef.current += 1;
    window.clearTimeout(closeTimer.current);
    setTrigger(null);
    setClosing(true);
    setPreparing(false);
    stream.cancel();
    closeTimer.current = window.setTimeout(() => {
      setPanel(null);
      setClosing(false);
      setPinned(false);
      resetPosition();
      stream.reset();
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160);
  }, [stream]);

  const runTranslation = useCallback(
    (text: string, target: string, bootstrap: TranslationBootstrap | null, detected = panelSource, confidence = panelConfidence, policy: TranslationTargetPolicy = targetPolicy) => {
      const intent = resolveLanguageIntent(
        { source: AUTO_LANGUAGE, target, detected, confidence, targetPolicy: policy },
        bootstrap?.languages || languages,
      );
      if (intent.state !== 'ready') {
        setConfirmationDismissed(false);
        return false;
      }
      setCopied(false);
      setPreparationCancelled(false);
      const selection = resolveTranslationSelection(
        bootstrap?.settings || null,
        bootstrap?.models || [],
        {
          model: bootstrap?.defaultModel || bootstrap?.autoModel || '',
          provider: bootstrap?.defaultProvider || bootstrap?.autoProvider || '',
        },
      );
      const requestRoutes = resolveTranslationRoutesForRequest(bootstrap?.settings.routes || [], {
        configuredModel: bootstrap?.settings.model || '',
        configuredProvider: bootstrap?.settings.provider || '',
        fallback: selection.fallback,
      });
      void stream.run({
        text,
        source: AUTO_LANGUAGE,
        target: intent.target,
        targetPolicy: policy,
        ...(requestRoutes.length ? { routes: requestRoutes } : { model: selection.model, provider: selection.provider }),
      });
    },
    [languages, panelConfidence, panelSource, stream, targetPolicy],
  );

  const openPanel = useCallback(
    async (text: string, rect: SelectionRect) => {
      const token = ++openTokenRef.current;
      window.clearTimeout(closeTimer.current);
      setClosing(false);
      setCopied(false);
      setPreparationCancelled(false);
      setTrigger(null);
      if (!pinned) resetPosition();
      setPanel({ text, rect });
      setPanelSource('');
      setPanelConfidence(undefined);
      setTargetPolicy('saved');
      setConfirmationDismissed(false);
      setPreparing(true);
      stream.reset();

      // 语言检测与 bootstrap 并行：检测只读本地规则，不依赖模型/设置。
      const detectionPromise = translationAPI
        .detect(text.slice(0, 4000))
        .catch(() => null);

      let bootstrap = getTranslationBootstrap() || bootstrapRef.current;
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
      setAutoCopy(bootstrap?.settings.autoCopy === true);
      setCopyScope(bootstrap?.settings.copyScope || 'selection');
      const target = bootstrap?.settings.target || DEFAULT_TARGET;
      panelTargetRef.current = target;
      setPanelTarget(target);

      const detection = await detectionPromise;
      if (token !== openTokenRef.current) return;
      const detected = String(detection?.code || '').trim();
      setPanelSource(detected);
      const confidence = detection?.confidence;
      setPanelConfidence(confidence);
      setPreparing(false);
      // 检测/加载期间用户可能已经改过目标语言，以最新选择为准。
      const currentTarget = panelTargetRef.current;
      runTranslation(text, currentTarget, bootstrap, detected, confidence, 'saved');
    },
    [runTranslation, stream, pinned, resetPosition],
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
    if (!panel || pinned || closing) return;
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
  }, [panel, pinned, closing, closePanel]);

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
  }, [trigger, viewportRevision]);

  const panelAnchor = useMemo<FloatingAnchor | null>(() => {
    void viewportRevision;
    if (!panel || typeof window === 'undefined') return null;
    return computeFloatingAnchor(
      panel.rect,
      { width: window.innerWidth, height: window.innerHeight },
      { width: Math.min(PANEL_WIDTH, window.innerWidth - 24), height: panelHeight },
      12,
    );
  }, [panel, panelHeight, viewportRevision]);

  const targetOptions = useMemo(
    () => buildLanguageOptions(languages, { includeAuto: false }),
    [languages],
  );

  const meta = stream.state.meta;
  const languageIntent = resolveLanguageIntent(
    { source: AUTO_LANGUAGE, target: panelTarget, detected: panelSource, confidence: panelConfidence, targetPolicy },
    languages,
  );
  const sameLanguage = languageIntent.state === 'same_language';
  const showConfirmation = Boolean(panel && !preparing && !confirmationDismissed && languageIntent.state !== 'ready');
  const feedback = useTranslationFeedback(preparationCancelled ? { ...stream.state, status: 'cancelled' } : stream.state, preparing, sameLanguage);
  const hasOutput = Boolean(stream.state.text.trim());
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
          <TranslationOutlined className={styles.triggerGlyph} />
        </button>
      ) : null}

      {panel && panelAnchor ? (
        <div
          ref={panelRef}
          data-translation-floating
          className={`${styles.panel} ${pinned ? styles.panelPinned : ''} ${closing ? styles.panelClosing : ''} ${dragging ? styles.panelDragging : ''}`}
          style={position || { left: panelAnchor.left, top: panelAnchor.top }}
          data-phase={feedback.phase}
          data-pinned={pinned}
          aria-busy={feedback.active}
          role="dialog"
          aria-label="划词翻译"
        >
          <header className={styles.panelHeader} {...dragHandlers} title="拖动标题移动面板">
            <div className={styles.headerSummary}>
              <TranslationOutlined className={styles.headerIcon} />
              <span className={styles.route}>{routeLabel}</span>
            </div>
            <div className={styles.headerActions} data-panel-actions>
              <Select
                size="small"
                className={styles.targetSelect}
                value={panelTarget}
                options={targetOptions}
                aria-label="目标语言"
                disabled={preparing || !targetOptions.length}
                popupMatchSelectWidth={false}
                popupClassName={styles.targetSelectPopup}
                onChange={(value) => {
                  panelTargetRef.current = value;
                  setPanelTarget(value);
                  if (!panel.text) return;
                  setTargetPolicy('confirm');
                  setConfirmationDismissed(false);
                  runTranslation(panel.text, value, bootstrapRef.current, panelSource, panelConfidence, 'confirm');
                }}
              />
              <button
                type="button"
                className={`${styles.iconButton} ${pinned ? styles.pinned : ''}`}
                aria-label={pinned ? '取消置顶' : '置顶面板'}
                aria-pressed={pinned}
                title={pinned ? '取消置顶' : '固定并置顶（点击外部不关闭）'}
                onClick={() => {
                  if (!pinned) pinToTop();
                  setPinned((value) => !value);
                }}
              >
                {pinned ? <PushpinFilled /> : <PushpinOutlined />}
              </button>
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
          <div className={styles.statusRow}>
            <span className={styles.phase} role="status">
              <span className={styles.phaseDot} aria-hidden="true" />
              <span key={feedback.phase} className={styles.statusLabel}>{feedback.label}</span>
            </span>
            <span className={styles.statusAside}>
              {pinned ? <span className={styles.pinBadge}><PushpinFilled /> 已置顶</span> : null}
              {feedback.active || stream.state.status !== 'idle' ? <span className={styles.elapsed}>{feedback.elapsedLabel}</span> : null}
            </span>
          </div>
          <div className={styles.sourcePreview} title={panel.text}>{panel.text}</div>
          <div className={styles.panelBody}>
            {sameLanguage && !preparing ? (
              <span className={styles.placeholder}>
                原文已是{languageLabelOf(languages, panelTarget)}，无需翻译
              </span>
            ) : hasOutput ? (
              <div className={styles.text}>
                {stream.state.text}
                {stream.busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
              </div>
            ) : feedback.active ? (
              <div className={styles.loadingState}>
                <div className={styles.loadingCaption}><span className={styles.loadingOrb} aria-hidden="true" />{feedback.hint}</div>
                <div className={styles.skeleton} aria-hidden="true"><span /><span /><span /></div>
              </div>
            ) : feedback.phase === 'cancelled' ? (
              <span className={styles.placeholder}>已停止生成，点击「重新翻译」继续。</span>
            ) : null}
            {stream.state.status === 'error' && stream.state.error ? (
              <div className={styles.errorRow} role="alert">
                <span className={styles.errorText}>{stream.state.error.message}</span>
              </div>
            ) : null}
            {showConfirmation ? (
              <div className={styles.languageIntentStrip} role="status">
                <span>{sameLanguage ? '原文与目标语言相同。请选择目标语言，或确认仍然翻译。' : '目标语言需要确认。'}</span>
                <button type="button" className={styles.textButton} onClick={() => { stream.reset(); setConfirmationDismissed(true); setTargetPolicy('same-language'); }}>保持原文</button>
                <button type="button" className={styles.textButton} onClick={() => { setTargetPolicy('explicit'); runTranslation(panel.text, panelTarget, bootstrapRef.current, panelSource, panelConfidence, 'explicit'); }}>仍然翻译</button>
              </div>
            ) : null}
          </div>

          <footer className={styles.panelFooter}>
            <span className={styles.meta} title={meta?.model}>
              {meta?.model || (preparing ? '正在准备翻译服务' : 'AI 翻译')}
            </span>
            <div className={styles.footerActions}>
              {feedback.active ? (
                <button type="button" className={styles.textButton} onClick={() => {
                  if (preparing) {
                    openTokenRef.current += 1;
                    setPreparing(false);
                    setPreparationCancelled(true);
                  }
                  stream.cancel();
                }}>
                  <span className={styles.stopGlyph} aria-hidden="true" />
                  停止
                </button>
              ) : null}
              {!feedback.active && !sameLanguage ? (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    if (preparationCancelled) void openPanel(panel.text, panel.rect);
                    else if (panel.text) runTranslation(panel.text, panelTarget, bootstrapRef.current, panelSource, panelConfidence, targetPolicy);
                  }}
                >
                  <ReloadOutlined /> {feedback.phase === 'error' ? '重试' : '重新翻译'}
                </button>
              ) : null}
              {hasOutput ? <button
                type="button"
                className={`${styles.textButton} ${copied ? styles.copied : ''}`}
                onClick={async () => {
                  try {
                    await writeTranslationClipboard(stream.state.text);
                    window.clearTimeout(copyTimer.current);
                    setCopied(true);
                    copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
                  } catch (_error) {
                    message.error('复制失败，请手动选择译文');
                  }
                }}
              >
                <span key={String(copied)} className={styles.copyLabel}>{copied ? <CheckOutlined /> : <CopyOutlined />} {copied ? '已复制' : '复制'}</span>
              </button> : null}
            </div>
          </footer>
        </div>
      ) : null}
    </>,
    document.body,
  );
}
