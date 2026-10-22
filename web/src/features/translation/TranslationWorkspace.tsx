// AI 翻译工作台（桌面 / 平板）。
//
// 三件事必须一起成立才叫「能用」：
//   1. 源语言 / 目标语言 / 模型都是可见、可改、会被记住的默认值（下次打开还是这套）；
//   2. 译文是流式的，首字节就来，能中途停止且不清空已收到的部分；
//   3. 输入是「自动检测」时，页面要告诉用户它到底认成了什么语言（否则翻错了没人知道为什么）。
// 划词浮层复用同一份设置（translation-settings-store），所以这里改完语言，浮层立刻跟着变。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Input, Select, Switch, Tooltip, message } from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  SwapOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import { translationAPI } from '@/services/api';
import type { TranslationDetectionResponse } from '@/types';
import {
  AUTO_LANGUAGE,
  MAX_TRANSLATION_INPUT_CHARS,
  buildLanguageOptions,
  buildModelOptions,
  canSwapLanguages,
  canTranslate,
  countCharacters,
  exceedsInputLimit,
  isSameTranslationLanguage,
  languageLabelOf,
  modelOptionLabel,
  resolveTranslationSelection,
  shortcutLabel,
  swapLanguages,
} from './translation-utils';
import {
  saveTranslationSettings,
  type TranslationBootstrap,
} from './translation-settings-store';
import {
  getTranslationFloatingPreferences,
  setTranslationFloatingPreferences,
  subscribeTranslationFloatingPreferences,
} from './translation-preferences';
import { useTranslationBootstrap, useTranslationStream } from './use-translation';
import {
  useTranslationHistory,
  useTranslationHistoryRecorder,
} from './use-translation-history';
import { formatTranslationHistoryTime } from './translation-history';
import styles from './translation.module.css';

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

function describeFallback(bootstrap: TranslationBootstrap | null, model: string): string {
  if (!bootstrap || !model) return '';
  const known = bootstrap.models.some((item) => item.id === model);
  return known ? '' : model;
}

export default function TranslationWorkspace() {
  const { status, bootstrap, error: bootstrapError, reload } = useTranslationBootstrap();
  const stream = useTranslationStream();
  const history = useTranslationHistory();
  useTranslationHistoryRecorder(stream.state);

  const [text, setText] = useState('');
  const [source, setSource] = useState(AUTO_LANGUAGE);
  const [target, setTarget] = useState('zh-Hans');
  const [modelValue, setModelValue] = useState('');
  const [providerValue, setProviderValue] = useState('');
  const [detection, setDetection] = useState<TranslationDetectionResponse | null>(null);
  const [detectionText, setDetectionText] = useState('');
  const [detecting, setDetecting] = useState(false);
  const [floatingEnabled, setFloatingEnabled] = useState(
    () => getTranslationFloatingPreferences().enabled,
  );
  const detectionSequence = useRef(0);

  useEffect(() => {
    if (!bootstrap) return;
    const settings = bootstrap.settings;
    setSource(settings.source || AUTO_LANGUAGE);
    setTarget(settings.target || 'zh-Hans');
    setModelValue(settings.model || '');
    setProviderValue(settings.provider || '');
  }, [bootstrap]);

  useEffect(
    () =>
      subscribeTranslationFloatingPreferences((preferences) => {
        setFloatingEnabled(preferences.enabled);
      }),
    [],
  );

  // 自动检测：只在源语言为 auto 时探测，且 400ms 防抖——每敲一个字发一次请求既浪费也闪。
  useEffect(() => {
    if (source !== AUTO_LANGUAGE) {
      detectionSequence.current += 1;
      setDetection(null);
      setDetectionText('');
      return;
    }
    const sample = text.trim();
    if (!sample) {
      detectionSequence.current += 1;
      setDetection(null);
      setDetectionText('');
      return;
    }
    const sequence = ++detectionSequence.current;
    const timer = window.setTimeout(() => {
      translationAPI
        .detect(sample.slice(0, 2000))
        .then((response) => {
          if (sequence === detectionSequence.current) {
            setDetection(response);
            setDetectionText(sample);
          }
        })
        .catch(() => {
          if (sequence === detectionSequence.current) {
            setDetection(null);
            setDetectionText('');
          }
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [text, source]);

  const languages = bootstrap?.languages || [];
  const models = bootstrap?.models || [];
  const languageOptions = useMemo(() => buildLanguageOptions(languages), [languages]);
  const modelOptions = useMemo(
    () => buildModelOptions(models).map((option) => ({
      value: option.value,
      label: modelOptionLabel(option),
      title: option.label,
    })),
    [models],
  );

  const selection = useMemo(
    () =>
      resolveTranslationSelection(
        { model: modelValue, provider: providerValue },
        models,
        {
          model: bootstrap?.defaultModel || bootstrap?.autoModel || '',
          provider: bootstrap?.defaultProvider || bootstrap?.autoProvider || '',
        },
      ),
    [modelValue, providerValue, models, bootstrap],
  );

  const fallbackFrom = selection.fallback && models.length
    ? describeFallback(bootstrap, modelValue)
    : '';
  const chars = countCharacters(text);
  const overLimit = exceedsInputLimit(text);
  const busy = stream.busy;
  const resultText = stream.state.text;
  const canCopy = resultText.trim().length > 0;

  const persist = useCallback(
    (patch: { source?: string; target?: string; model?: string; provider?: string }) => {
      void saveTranslationSettings(patch).catch(() => {
        // 默认值保存失败不影响本次翻译；下一次修改会再试。
        message.warning('默认值保存失败，本次翻译不受影响');
      });
    },
    [],
  );

  const handleSourceChange = useCallback(
    (value: string) => {
      setSource(value);
      persist({ source: value });
    },
    [persist],
  );

  const handleTargetChange = useCallback(
    (value: string) => {
      setTarget(value);
      persist({ target: value });
    },
    [persist],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      const normalized = value || '';
      const hit = models.find((item) => item.id === normalized);
      const provider = normalized ? String(hit?.provider || '') : '';
      setModelValue(normalized);
      setProviderValue(provider);
      persist({ model: normalized, provider });
    },
    [models, persist],
  );

  const handleSwap = useCallback(() => {
    if (!canSwapLanguages(source, target)) return;
    const next = swapLanguages(source, target);
    setSource(next.source);
    setTarget(next.target);
    persist({ source: next.source, target: next.target });
  }, [source, target, persist]);

  const handleTranslate = useCallback(async () => {
    if (!canTranslate(text)) {
      message.info('先输入要翻译的内容');
      return;
    }
    if (exceedsInputLimit(text)) {
      message.warning(`单次最多 ${MAX_TRANSLATION_INPUT_CHARS} 字符`);
      return;
    }
    // 自动检测时以点击瞬间的检测结果为准：防抖里缓存的可能是上一段文本的结论，
    // 直接拿它判断「同语言」会把刚粘贴的新内容误跳过。
    let detectedCode = '';
    if (source === AUTO_LANGUAGE) {
      setDetecting(true);
      try {
        const response = await translationAPI.detect(text.trim().slice(0, 2000));
        detectedCode = response.code || '';
        setDetection(response);
        setDetectionText(text.trim());
      } catch (_error) {
        detectedCode = '';
      } finally {
        setDetecting(false);
      }
    }
    if (isSameTranslationLanguage(source, target, detectedCode)) {
      message.info('源语言与目标语言相同，无需翻译');
      return;
    }
    void stream.run({
      text,
      source,
      target,
      model: selection.model,
      provider: selection.provider,
    });
  }, [text, source, target, selection, stream]);

  const handleTextKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void handleTranslate();
        return;
      }
      if (event.key === 'Escape' && busy) {
        event.preventDefault();
        stream.cancel();
      }
    },
    [handleTranslate, busy, stream],
  );

  const handleCopy = useCallback(async () => {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(resultText);
      message.success('译文已复制');
    } catch (_error) {
      message.error('复制失败，请手动选择译文');
    }
  }, [canCopy, resultText]);

  const handleClear = useCallback(() => {
    setText('');
    stream.reset();
  }, [stream]);

  const handleCopyHistory = useCallback(async (entry: (typeof history.entries)[number]) => {
    try {
      await navigator.clipboard.writeText(entry.resultText);
      message.success('译文已复制');
    } catch (_error) {
      message.error('复制失败，请手动选择译文');
    }
  }, []);

  const detectionMatchesText = Boolean(
    detection && (!detectionText || text.trim().startsWith(detectionText)),
  );
  const sameLanguage = isSameTranslationLanguage(
    source,
    target,
    detectionMatchesText ? detection?.code : '',
  );

  const detectedLabel =
    source === AUTO_LANGUAGE && detection
      ? `${detection.label} · ${CONFIDENCE_LABEL[detection.confidence] || detection.confidence}`
      : '';

  const meta = stream.state.meta;
  const routeLabel = meta
    ? `${meta.fromLabel} → ${meta.toLabel}`
    : `${languageLabelOf(languages, source)} → ${languageLabelOf(languages, target)}`;

  return (
    <PageScaffold
      title="AI 翻译"
      code="TRANSLATE"
      subTitle="粘贴或选中文本即可翻译；划词浮层与页面共用同一套默认值。"
      extra={
        <div className={styles.floatingToggle}>
          <Tooltip title={`开启后选中任意页面文本可悬浮翻译（${shortcutLabel()} 直接翻译选区）`}>
            <span className={styles.floatingToggleLabel}>
              <TranslationOutlined /> 划词翻译
            </span>
          </Tooltip>
          <Switch
            size="small"
            checked={floatingEnabled}
            onChange={(checked) => {
              setFloatingEnabled(checked);
              setTranslationFloatingPreferences({ enabled: checked });
              message.success(checked ? '划词翻译已开启' : '划词翻译已关闭');
            }}
          />
          <kbd className={styles.kbd}>{shortcutLabel()}</kbd>
        </div>
      }
    >
      <div className={styles.workspace}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarGroup}>
            <span className={styles.fieldLabel}>源语言</span>
            <Select
              className={styles.languageSelect}
              value={source}
              options={languageOptions}
              optionFilterProp="label"
              showSearch
              onChange={handleSourceChange}
            />
            <Tooltip title={canSwapLanguages(source, target) ? '互换源语言与目标语言' : '自动检测时无法互换'}>
              <Button
                appVariant="icon"
                aria-label="互换语言"
                icon={<SwapOutlined />}
                disabled={!canSwapLanguages(source, target)}
                onClick={handleSwap}
              />
            </Tooltip>
            <span className={styles.fieldLabel}>目标语言</span>
            <Select
              className={styles.languageSelect}
              value={target}
              options={languageOptions.filter((option) => option.value !== AUTO_LANGUAGE)}
              optionFilterProp="label"
              showSearch
              onChange={handleTargetChange}
            />
          </div>

          <div className={styles.toolbarGroup}>
            <span className={styles.fieldLabel}>模型</span>
            <Select
              className={styles.modelSelect}
              value={modelValue}
              options={[
                {
                  value: '',
                  label: bootstrap?.defaultModel
                    ? `自动 · ${bootstrap.defaultModel}`
                    : '自动选择可用模型',
                },
                ...modelOptions,
              ]}
              optionFilterProp="label"
              showSearch
              popupMatchSelectWidth={false}
              onChange={handleModelChange}
            />
            <span className={styles.savedHint}>默认值自动保存</span>
          </div>
        </div>

        {fallbackFrom ? (
          <div className={styles.inlineNotice}>
            已保存的模型 {fallbackFrom} 不在当前模型目录中，本次改用{' '}
            {selection.model || '服务端默认模型'}
          </div>
        ) : null}

        {status === 'error' ? (
          <div className={styles.inlineError}>
            {bootstrapError || '加载翻译设置失败'}
            <Button appVariant="quiet" onClick={reload}>
              重试
            </Button>
          </div>
        ) : null}

        <div className={styles.panes}>
          <section className={styles.pane}>
            <header className={styles.paneHeader}>
              <span className={styles.paneTitle}>原文</span>
              <span className={styles.paneMeta}>{chars} 字符</span>
            </header>
            <Input.TextArea
              className={styles.sourceInput}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleTextKeyDown}
              placeholder="粘贴要翻译的内容，或直接在这里输入…"
              autoSize={false}
              spellCheck={false}
            />
            <footer className={styles.paneFooter}>
              <div className={styles.paneFooterLeft}>
                {sameLanguage ? (
                  <span className={styles.paneHint}>源语言与目标语言相同，无需翻译</span>
                ) : detectedLabel ? (
                  <span className={styles.detectChip}>检测到 {detectedLabel}</span>
                ) : (
                  <span className={styles.paneHint}>自动检测输入语言</span>
                )}
                {overLimit ? (
                  <span className={styles.limitWarning}>
                    超出 {chars - MAX_TRANSLATION_INPUT_CHARS} 字符
                  </span>
                ) : null}
              </div>
              <div className={styles.paneFooterRight}>
                <span className={styles.paneHint}>
                  <kbd className={styles.kbd}>⌘↵</kbd> 翻译
                </span>
                <Button
                  appVariant="quiet"
                  icon={<DeleteOutlined />}
                  disabled={!text && !resultText}
                  onClick={handleClear}
                >
                  清空
                </Button>
                <Button
                  type="primary"
                  icon={<TranslationOutlined />}
                  loading={busy || detecting}
                  disabled={!canTranslate(text) || overLimit || sameLanguage}
                  onClick={() => void handleTranslate()}
                >
                  {busy || detecting ? '翻译中' : '翻译'}
                </Button>
              </div>
            </footer>
          </section>

          <section className={styles.pane}>
            <header className={styles.paneHeader}>
              <span className={styles.paneTitle}>译文</span>
              <span className={styles.paneMeta}>{routeLabel}</span>
            </header>
            <div className={styles.output}>
              {resultText ? (
                <div className={styles.outputText}>
                  {resultText}
                  {busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
                </div>
              ) : (
                <div className={styles.outputPlaceholder}>
                  {busy ? '正在翻译…' : '译文会在这里流式出现'}
                </div>
              )}
            </div>
            {stream.state.status === 'error' && stream.state.error ? (
              <div className={styles.inlineError}>
                {stream.state.error.message}
                {stream.state.error.code ? (
                  <code className={styles.errorCode}>{stream.state.error.code}</code>
                ) : null}
                <Button appVariant="quiet" onClick={() => void handleTranslate()}>
                  重试
                </Button>
              </div>
            ) : null}
            <footer className={styles.paneFooter}>
              <div className={styles.paneFooterLeft}>
                {meta ? (
                  <span className={styles.paneHint}>
                    {meta.model}
                    {meta.provider ? ` · ${meta.provider}` : ''}
                  </span>
                ) : null}
                {stream.state.status === 'done' && stream.state.elapsedMs ? (
                  <span className={styles.paneHint}>
                    {(stream.state.elapsedMs / 1000).toFixed(1)}s
                  </span>
                ) : null}
                {stream.state.status === 'cancelled' ? (
                  <span className={styles.paneHint}>已停止，保留已翻译部分</span>
                ) : null}
              </div>
              <div className={styles.paneFooterRight}>
                {busy ? (
                  <Button appVariant="secondary" onClick={stream.cancel}>
                    停止
                  </Button>
                ) : null}
                <Button
                  appVariant="secondary"
                  icon={<CopyOutlined />}
                  disabled={!canCopy}
                  onClick={handleCopy}
                >
                  复制
                </Button>
              </div>
            </footer>
          </section>
        </div>
      </div>

      <section className={styles.history}>
        <header className={styles.paneHeader}>
          <span className={styles.paneTitle}>翻译记录</span>
          <div className={styles.historyHeaderRight}>
            <span className={styles.paneMeta}>
              {history.entries.length} 条 · 仅保存在本机
            </span>
            {history.entries.length ? (
              <Button appVariant="quiet" onClick={history.clear}>
                清空记录
              </Button>
            ) : null}
          </div>
        </header>
        {history.entries.length === 0 ? (
          <div className={styles.historyEmpty}>
            完成一次翻译后，原文 / 译文 / 模型会记录在这里。
          </div>
        ) : (
          <ul className={styles.historyList}>
            {history.entries.map((entry) => (
              <li key={entry.id} className={styles.historyItem}>
                <div className={styles.historyItemHeader}>
                  <span className={styles.historyRoute}>
                    {entry.sourceLabel || entry.sourceLang || '自动检测'} → {entry.targetLabel || entry.targetLang}
                  </span>
                  <span className={styles.historyMeta}>
                    {entry.model}
                    {entry.provider ? ` · ${entry.provider}` : ''}
                    {' · '}
                    {formatTranslationHistoryTime(entry.createdAt)}
                  </span>
                  <div className={styles.historyActions}>
                    <Button
                      appVariant="icon"
                      aria-label="复制这条译文"
                      title="复制这条译文"
                      icon={<CopyOutlined />}
                      onClick={() => void handleCopyHistory(entry)}
                    />
                    <Button
                      appVariant="icon"
                      aria-label="删除这条记录"
                      title="删除这条记录"
                      icon={<DeleteOutlined />}
                      onClick={() => history.remove(entry.id)}
                    />
                  </div>
                </div>
                <div className={styles.historyBody}>
                  <div className={styles.historySource} title={entry.sourceText}>
                    {entry.sourceText}
                  </div>
                  <div className={styles.historyResult} title={entry.resultText}>
                    {entry.resultText}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageScaffold>
  );
}
