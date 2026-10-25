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
  ArrowDownOutlined,
  ArrowUpOutlined,
  CopyOutlined,
  DeleteOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  SwapOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import { translationAPI } from '@/services/api';
import type { TranslationDetectionResponse, TranslationRoutePreference, TranslationProviderOption } from '@/types';
import {
  AUTO_LANGUAGE,
  MAX_TRANSLATION_INPUT_CHARS,
  buildLanguageOptions,
  buildModelOptions,
  canSwapLanguages,
  canTranslate,
  countCharacters,
  exceedsInputLimit,
  formatTranslationRouteLabel,
  languageLabelOf,
  modelOptionLabel,
  resolveTranslationSelection,
  shortcutLabel,
  swapLanguages,
} from './translation-utils';
import {
  saveTranslationSettings,
  resolveTranslationRoutesForRequest,
  shouldAutoCopy,
  writeTranslationClipboard,
  type TranslationBootstrap,
} from './translation-settings-store';
import {
  getTranslationFloatingPreferences,
  setTranslationFloatingPreferences,
  subscribeTranslationFloatingPreferences,
} from './translation-preferences';
import { useTranslationBootstrap, useTranslationStream } from './use-translation';
import {
  resolveLanguageIntent,
  type TranslationTargetPolicy,
} from './language-intent';
import { useTranslationFeedback } from './use-translation-feedback';
import {
  useTranslationHistory,
  useTranslationHistoryRecorder,
} from './use-translation-history';
import { formatTranslationHistoryTime } from './translation-history';
import { applyPageTranslation, collectPageSegments, createBoundedPageTranslator, type PageTranslationMode, type TranslationPageProgress } from './page-translation';
import styles from './translation.module.css';
import SystemTranslationControl from './SystemTranslationControl';
import TranslationProviderSettings from './TranslationProviderSettings';

const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高置信',
  medium: '中置信',
  low: '低置信',
};

function describeFallback(bootstrap: TranslationBootstrap | null, model: string): string {
  if (!bootstrap || !model) return '';
  const known = bootstrap.models.find((item) => item.id === model);
  const available = known?.availableAccountCount;
  return known && (available === undefined || Number(available) > 0) ? '' : model;
}

const ROUTE_OPERATIONS: Array<{ value: TranslationRoutePreference['operations'][number]; label: string }> = [
  { value: 'selection', label: '选区' },
  { value: 'batch', label: '批量' },
  { value: 'page', label: '页面' },
  { value: 'replace', label: '替换' },
];

function createRoutePreference(index: number, model: { id: string; provider: string } | undefined): TranslationRoutePreference {
  const modelId = model?.id || '';
  const modelProvider = model?.provider || '';
  return {
    id: `route:${Date.now().toString(36)}:${index}`,
    provider: 'aih-gateway',
    model: modelId,
    ...(modelProvider ? { modelProvider } : {}),
    enabled: true,
    priority: index,
    operations: ['selection'],
  };
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
  const [targetPolicy, setTargetPolicy] = useState<TranslationTargetPolicy>('saved');
  const [autoCopy, setAutoCopy] = useState(false);
  const [copyScope, setCopyScope] = useState<'selection' | 'page' | 'all'>('selection');
  const [routes, setRoutes] = useState<TranslationRoutePreference[]>([]);
  const [providers, setProviders] = useState<TranslationProviderOption[]>([]);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, Record<string, string>>>({});
  const [savingProvider, setSavingProvider] = useState('');
  const [providerError, setProviderError] = useState('');
  const [pageMode, setPageMode] = useState<PageTranslationMode>('side-by-side');
  const [pageProgress, setPageProgress] = useState<TranslationPageProgress[]>([]);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageApplied, setPageApplied] = useState(false);
  const [pageCancelled, setPageCancelled] = useState(false);
  const pageAbortRef = useRef<AbortController | null>(null);
  const pageUndoRef = useRef<(() => void) | null>(null);
  const reloadProviders = useCallback(() => {
    setProviderError('');
    void translationAPI.listProviders().then(setProviders).catch(() => setProviderError('读取翻译引擎配置失败'));
  }, []);
  useEffect(reloadProviders, [reloadProviders]);
  const saveProvider = useCallback((provider: string, config: Record<string, string>) => {
    setSavingProvider(provider);
    setProviderError('');
    void translationAPI.saveProvider(provider, config).then((catalog) => {
      setProviders(catalog);
      setProviderDrafts((current) => ({ ...current, [provider]: {} }));
      message.success('引擎配置已保存');
    }).catch(() => setProviderError('保存失败，请检查字段和服务地址')).finally(() => setSavingProvider(''));
  }, []);
  const [confirmationDismissed, setConfirmationDismissed] = useState(false);
  const [floatingEnabled, setFloatingEnabled] = useState(
    () => getTranslationFloatingPreferences().enabled,
  );
  const detectionSequence = useRef(0);
  const intentSequence = useRef(0);

  useEffect(() => {
    if (!bootstrap) return;
    const settings = bootstrap.settings;
    setSource(settings.source || AUTO_LANGUAGE);
    setTarget(settings.target || 'zh-Hans');
    setModelValue(settings.model || '');
    setProviderValue(settings.provider || '');
    setTargetPolicy(settings.targetPolicy || 'saved');
    setAutoCopy(settings.autoCopy === true);
    setCopyScope(settings.copyScope || 'selection');
    setRoutes(Array.isArray(settings.routes) ? settings.routes : []);
  }, [bootstrap]);

  useEffect(
    () =>
      subscribeTranslationFloatingPreferences((preferences) => {
        setFloatingEnabled(preferences.enabled);
      }),
    [],
  );

  useEffect(() => {
    intentSequence.current += 1;
    setDetecting(false);
    setConfirmationDismissed(false);
    setTargetPolicy((policy) => policy === 'same-language' || policy === 'explicit' ? 'saved' : policy);
  }, [source, target, text]);

  useEffect(() => () => {
    intentSequence.current += 1;
    pageAbortRef.current?.abort();
    pageUndoRef.current?.();
    setPageApplied(false);
  }, []);

  useEffect(() => {
    if (targetPolicy === 'explicit' && stream.state.status !== 'streaming') {
      setTargetPolicy('saved');
    }
  }, [stream.state.status, targetPolicy]);

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
  const requestRoutes = useMemo(
    () => resolveTranslationRoutesForRequest(routes, {
      configuredModel: modelValue,
      configuredProvider: providerValue,
      fallback: selection.fallback,
    }),
    [modelValue, providerValue, routes, selection.fallback],
  );
  const chars = countCharacters(text);
  const overLimit = exceedsInputLimit(text);
  const busy = stream.busy;
  const resultText = stream.state.text;
  const feedback = useTranslationFeedback(stream.state, detecting);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number>();
  const autoCopiedRequest = useRef<object | null>(null);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => setCopied(false), [resultText]);
  useEffect(() => {
    const request = stream.state.request;
    if (!autoCopy || stream.state.status !== 'done' || !request || autoCopiedRequest.current === request) return;
    const meta = stream.state.meta;
    if (meta && meta.from && meta.to && meta.from === meta.to) return;
    if (!shouldAutoCopy({ scope: copyScope, client: 'webui', mode: 'selection', event: { type: 'done', text: resultText } })) return;
    autoCopiedRequest.current = request;
    void writeTranslationClipboard(resultText).then(() => {
      window.clearTimeout(copyTimer.current);
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => {});
  }, [autoCopy, copyScope, resultText, stream.state.request, stream.state.status]);
  const canCopy = resultText.trim().length > 0;

  const persist = useCallback(
    (patch: { source?: string; target?: string; model?: string; provider?: string; targetPolicy?: TranslationTargetPolicy; autoCopy?: boolean; copyScope?: 'selection' | 'page' | 'all'; routes?: TranslationRoutePreference[] }) => {
      void saveTranslationSettings(patch).catch(() => {
        // 默认值保存失败不影响本次翻译；下一次修改会再试。
        message.warning('默认值保存失败，本次翻译不受影响');
      });
    },
    [],
  );

  const handleSourceChange = useCallback(
    (value: string) => {
      intentSequence.current += 1;
      setSource(value);
      persist({ source: value });
    },
    [persist],
  );

  const handleTargetChange = useCallback(
    (value: string) => {
      intentSequence.current += 1;
      setTarget(value);
      setTargetPolicy('confirm');
      setConfirmationDismissed(false);
      persist({ target: value });
    },
    [persist],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      // Model/provider changes invalidate an in-flight language preflight. The
      // continuation captures the selected model and routes, so allowing it
      // to complete would submit a request against stale routing settings.
      intentSequence.current += 1;
      setDetecting(false);
      const normalized = value || '';
      const hit = models.find((item) => item.id === normalized);
      const provider = normalized ? String(hit?.provider || '') : '';
      setModelValue(normalized);
      setProviderValue(provider);
      persist({ model: normalized, provider });
    },
    [models, persist],
  );

  const updateRoutes = useCallback((next: TranslationRoutePreference[]) => {
    // Route edits are also request intent changes. Invalidate detection before
    // persisting the new order so a pending callback cannot use the old chain.
    // Cancel the active stream as well; otherwise buffered deltas from the old
    // route could appear after the user has selected a new route.
    intentSequence.current += 1;
    setDetecting(false);
    stream.cancel();
    const pageWasBusy = pageBusy || Boolean(pageAbortRef.current);
    pageAbortRef.current?.abort();
    pageAbortRef.current = null;
    if (pageWasBusy) {
      setPageBusy(false);
      setPageCancelled(true);
    }
    const normalized = next.map((route, priority) => ({ ...route, priority }));
    setRoutes(normalized);
    persist({ routes: normalized });
  }, [pageBusy, persist, stream]);

  const handleAddRoute = useCallback(() => {
    updateRoutes([...routes, createRoutePreference(routes.length, models[0])]);
  }, [models, routes, updateRoutes]);

  const handleRemoveRoute = useCallback((index: number) => {
    updateRoutes(routes.filter((_route, routeIndex) => routeIndex !== index));
  }, [routes, updateRoutes]);

  const handleMoveRoute = useCallback((index: number, direction: -1 | 1) => {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= routes.length) return;
    const next = routes.slice();
    const [route] = next.splice(index, 1);
    next.splice(nextIndex, 0, route);
    updateRoutes(next);
  }, [routes, updateRoutes]);

  const handleRouteChange = useCallback((index: number, patch: Partial<TranslationRoutePreference>) => {
    updateRoutes(routes.map((route, routeIndex) => routeIndex === index ? { ...route, ...patch } : route));
  }, [routes, updateRoutes]);

  const toggleRouteOperation = useCallback((index: number, operation: TranslationRoutePreference['operations'][number]) => {
    const route = routes[index];
    if (!route) return;
    const operations = route.operations.includes(operation)
      ? route.operations.filter((item) => item !== operation)
      : [...route.operations, operation];
    handleRouteChange(index, { operations });
  }, [handleRouteChange, routes]);

  const handleSwap = useCallback(() => {
    if (!canSwapLanguages(source, target)) return;
    const next = swapLanguages(source, target);
    setSource(next.source);
    setTarget(next.target);
    persist({ source: next.source, target: next.target });
  }, [source, target, persist]);

  const requestTranslation = useCallback(
    (detectedCode: string, confidence: 'high' | 'medium' | 'low' | undefined, policy: TranslationTargetPolicy) => {
      const intent = resolveLanguageIntent(
        { source, target, detected: detectedCode, confidence, targetPolicy: policy },
        languages,
      );
      if (intent.state !== 'ready') {
        setConfirmationDismissed(false);
        return false;
      }
      void stream.run({
        text,
        source,
        target: intent.target,
        targetPolicy: policy,
        ...(requestRoutes.length ? { routes: requestRoutes } : { model: selection.model, provider: selection.provider }),
      });
      return true;
    },
    [languages, requestRoutes, selection.model, selection.provider, source, stream, target, text],
  );

  const handleTranslate = useCallback(async (policyOverride?: TranslationTargetPolicy) => {
    const intentToken = ++intentSequence.current;
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
    let detectedConfidence: 'high' | 'medium' | 'low' | undefined;
    if (source === AUTO_LANGUAGE) {
      setDetecting(true);
      try {
        const response = await translationAPI.detect(text.trim().slice(0, 2000));
        if (intentSequence.current !== intentToken) return;
        detectedCode = response.code || '';
        detectedConfidence = response.confidence;
        setDetection(response);
        setDetectionText(text.trim());
      } catch (_error) {
        if (intentSequence.current !== intentToken) return;
        detectedCode = '';
      } finally {
        if (intentSequence.current === intentToken) setDetecting(false);
      }
    }
    if (intentSequence.current !== intentToken) return;
    const policy = policyOverride || targetPolicy;
    if (requestTranslation(detectedCode, detectedConfidence || detection?.confidence, policy)) {
      setTargetPolicy(policy);
    }
  }, [text, source, target, targetPolicy, detection, requestTranslation]);

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
      await writeTranslationClipboard(resultText);
      window.clearTimeout(copyTimer.current);
      setCopied(true);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch (_error) {
      message.error('复制失败，请手动选择译文');
    }
  }, [canCopy, resultText]);

  const handleClear = useCallback(() => {
    intentSequence.current += 1;
    setDetecting(false);
    setText('');
    stream.reset();
  }, [stream]);

  const handleTextChange = useCallback((value: string) => {
    intentSequence.current += 1;
    setText(value);
  }, []);

  const handleCopyHistory = useCallback(async (entry: (typeof history.entries)[number]) => {
    try {
      await writeTranslationClipboard(entry.resultText);
      message.success('译文已复制');
    } catch (_error) {
      message.error('复制失败，请手动选择译文');
    }
  }, []);

  const detectionMatchesText = Boolean(
    detection && (!detectionText || text.trim().startsWith(detectionText)),
  );
  const detectedLabel =
    source === AUTO_LANGUAGE && detection
      ? `${detection.label} · ${CONFIDENCE_LABEL[detection.confidence] || detection.confidence}`
      : '';

  const languageIntent = resolveLanguageIntent(
    {
      source,
      target,
      detected: detectionMatchesText ? detection?.code : '',
      confidence: detectionMatchesText ? detection?.confidence : undefined,
      targetPolicy,
    },
    languages,
  );
  const sameLanguage = languageIntent.state === 'same_language';
  const showConfirmation = Boolean(text.trim()) && !confirmationDismissed && languageIntent.state !== 'ready';
  const intentMessage = sameLanguage
    ? `原文已是${languageLabelOf(languages, target)}，请选择其它目标语言后再开始翻译。`
    : languageIntent.reason === 'source_detection_required'
      ? '无法确定原文语言，请先重新识别后再开始翻译。'
      : languageIntent.reason === 'low_confidence'
        ? '语言识别不确定，请先选择目标语言后再开始翻译。'
        : '请选择目标语言后再开始翻译。';
  const handleKeepOriginal = useCallback(() => {
    intentSequence.current += 1;
    setDetecting(false);
    stream.reset();
    setConfirmationDismissed(true);
    setTargetPolicy('same-language');
  }, [stream]);

  const translateCurrentPage = useCallback(async () => {
    if (pageBusy) return;
    const segments = collectPageSegments(document);
    if (!segments.length) { message.info('当前页面没有可翻译的正文'); return; }
    pageAbortRef.current?.abort();
    pageUndoRef.current?.();
    const controller = new AbortController();
    pageAbortRef.current = controller;
    setPageProgress([]);
    setPageCancelled(false);
    setPageBusy(true);
    const translator = createBoundedPageTranslator({
      concurrency: 3,
      translate: async (segmentText, signal) => {
        const detected = source === AUTO_LANGUAGE
          ? await translationAPI.detect(segmentText.slice(0, 2000), { signal })
          : null;
        const from = detected?.code || source;
        if (from && from !== AUTO_LANGUAGE && from === target) return '';
        let output = '';
        await translationAPI.stream({ text: segmentText, source: from || AUTO_LANGUAGE, target, targetPolicy: 'saved', ...(requestRoutes.length ? { routes: requestRoutes, operation: 'page' } : { model: selection.model, provider: selection.provider }), operation: 'page' }, {
          signal,
          onEvent: (event) => {
            if (event.type === 'delta') output += event.content;
            if (event.type === 'error') throw new Error(event.message || '页面翻译失败');
          },
        });
        return output;
      },
    });
    try {
      const progress = await translator(segments, controller.signal, (item) => setPageProgress((current) => {
        const next = current.filter((entry) => entry.segment.id !== item.segment.id);
        next.push(item);
        return next.sort((a, b) => a.segment.index - b.segment.index);
      }));
      if (!controller.signal.aborted) {
        pageUndoRef.current = applyPageTranslation(progress, pageMode);
        setPageApplied(true);
      } else setPageCancelled(true);
    } finally {
      if (pageAbortRef.current === controller) {
        pageAbortRef.current = null;
        setPageBusy(false);
      }
    }
  }, [pageBusy, pageMode, requestRoutes, selection.model, selection.provider, source, target]);

  const meta = stream.state.meta;
  const routeLabel = meta
    ? formatTranslationRouteLabel({ fromLabel: meta.fromLabel, toLabel: meta.toLabel, sameLanguage })
    : formatTranslationRouteLabel({
      fromLabel: languageLabelOf(languages, source),
      toLabel: languageLabelOf(languages, target),
      sameLanguage,
    });

  return (
    <PageScaffold
      title="AI 翻译"
      code="TRANSLATE"
      subTitle="粘贴或选中文本即可翻译；划词浮层与页面共用同一套默认值。"
      extra={
        <div className={styles.translationControls}>
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
            <span className={styles.savedHint}>{selection.model || bootstrap?.defaultModel || '自动选择可用模型'}</span>
            <span className={styles.savedHint}>高级设置可修改</span>
          </div>
          <div className={styles.toolbarGroup}>
            <span className={styles.fieldLabel}>完成后复制</span>
            <Switch size="small" checked={autoCopy} onChange={(checked) => { setAutoCopy(checked); persist({ autoCopy: checked }); }} />
            {autoCopy ? <Select size="small" value={copyScope} options={[{ value: 'selection', label: '选区' }, { value: 'page', label: '页面' }, { value: 'all', label: '全部' }]} onChange={(value) => { setCopyScope(value); persist({ copyScope: value }); }} /> : null}
            <span className={styles.savedHint}>仅在整段成功完成后复制</span>
          </div>
        </div>

        <section className={styles.pageTranslationPanel} aria-labelledby="translation-page-title">
          <div className={styles.pageTranslationHeader}>
            <div>
              <span id="translation-page-title" className={styles.paneTitle}>整页翻译</span>
              <span className={styles.routeHint}>识别正文段落后有界并发翻译，支持旁注或替换。</span>
            </div>
            <div className={styles.pageTranslationActions}>
              <Select
                size="small"
                value={pageMode}
                aria-label="整页翻译显示方式"
                options={[{ value: 'side-by-side', label: '原文旁注' }, { value: 'replace', label: '替换原文' }]}
                onChange={setPageMode}
              />
              {pageBusy ? <Button appVariant="quiet" onClick={() => pageAbortRef.current?.abort()}>停止</Button> : <Button appVariant="secondary" onClick={() => void translateCurrentPage()}>翻译当前页面</Button>}
              {pageApplied && !pageBusy ? <Button appVariant="quiet" onClick={() => { pageUndoRef.current?.(); pageUndoRef.current = null; setPageProgress([]); setPageApplied(false); }}>撤回页面译文</Button> : null}
            </div>
          </div>
          {pageBusy || pageProgress.length || pageCancelled ? (
            <div className={styles.pageTranslationProgress} role="status" aria-live="polite">
              <span>{pageBusy ? '正在翻译页面' : pageCancelled ? '已停止页面翻译' : '页面翻译完成'} · 已处理 {pageProgress.length} 段</span>
              {pageProgress.some((item) => item.error) ? <span className={styles.limitWarning}>部分段落失败，可重试</span> : null}
            </div>
          ) : null}
        </section>

        <details className={styles.advancedTranslationSettings}>
          <summary>高级设置 <span className={styles.savedHint}>Provider、模型、路由和服务凭据</span></summary>
          <section className={styles.modelSettings} aria-labelledby="translation-model-settings-title">
            <div className={styles.routeHeader}>
              <div>
                <span id="translation-model-settings-title" className={styles.paneTitle}>默认模型</span>
                <span className={styles.routeHint}>用于手动翻译、系统取词和浏览器整页翻译；留空时由服务端按可用账号自动选择。</span>
              </div>
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
                aria-label="默认翻译模型"
              />
            </div>
          </section>
          <section className={styles.systemSettings} aria-labelledby="translation-system-settings-title">
            <div>
              <span id="translation-system-settings-title" className={styles.paneTitle}>系统级取词</span>
              <span className={styles.routeHint}>macOS 全局选词、右键入口和辅助功能授权。</span>
            </div>
            <SystemTranslationControl persistedExecutionTarget={bootstrap?.settings.executionTarget} />
          </section>
          <TranslationProviderSettings
            providers={providers}
            drafts={providerDrafts}
            saving={savingProvider}
            error={providerError}
            onChange={(provider, field, value) => setProviderDrafts((current) => ({ ...current, [provider]: { ...current[provider], [field]: value } }))}
            onSave={saveProvider}
            onReload={reloadProviders}
          />

          <section className={styles.routePanel} aria-labelledby="translation-route-title">
          <header className={styles.routeHeader}>
            <div>
              <span id="translation-route-title" className={styles.paneTitle}>翻译路由</span>
              <span className={styles.routeHint}>按顺序尝试启用的模型；每条路由可限定使用场景。</span>
            </div>
            <Button appVariant="secondary" icon={<PlusOutlined />} onClick={handleAddRoute}>
              添加路由
            </Button>
          </header>
          {routes.length ? (
            <ol className={styles.routeList}>
              {routes.map((route, index) => {
                const descriptor = providers.find((item) => item.id === route.provider);
                const gatewayModels = descriptor?.config.modelSource === 'gateway';
                const routeModelOptions = route.model && !modelOptions.some((option) => option.value === route.model)
                  ? [{ value: route.model, label: route.model, title: route.model }, ...modelOptions]
                  : modelOptions;
                return (
                  <li key={route.id} className={styles.routeRow}>
                    <span className={styles.routeOrder}>{index + 1}</span>
                    <Switch
                      size="small"
                      checked={route.enabled}
                      aria-label={`启用路由 ${index + 1}`}
                      onChange={(enabled) => handleRouteChange(index, { enabled })}
                    />
                    <Select
                      size="small"
                      className={styles.routeProvider}
                      value={route.provider}
                      aria-label={`路由 ${index + 1} 引擎`}
                      placeholder="引擎"
                      options={providers.map((item) => ({ value: item.id, label: `${item.label}${item.configured ? '' : ' · 待配置'}` }))}
                      onChange={(provider) => {
                        const selected = providers.find((item) => item.id === provider);
                        handleRouteChange(index, { provider, model: selected?.config.defaultModel || models[0]?.id || '', modelProvider: selected?.config.modelSource === 'gateway' ? models[0]?.provider || '' : '' });
                      }}
                    />
                    {gatewayModels ? <Select
                      size="small"
                      className={styles.routeModel}
                      value={route.model || undefined}
                      options={routeModelOptions}
                      showSearch
                      optionFilterProp="label"
                      placeholder="模型"
                      aria-label={`路由 ${index + 1} 模型`}
                      onChange={(model) => {
                        const selected = models.find((item) => item.id === model);
                        handleRouteChange(index, {
                          model,
                          ...(selected?.provider ? { modelProvider: selected.provider } : {}),
                        });
                      }}
                    /> : <Input
                      size="small"
                      className={styles.routeModel}
                      value={route.model}
                      aria-label={`路由 ${index + 1} 模型`}
                      placeholder={descriptor?.config.defaultModel || 'default'}
                      onChange={(event) => handleRouteChange(index, { model: event.target.value })}
                    />}
                    {gatewayModels ? <Input
                      size="small"
                      className={styles.routeModelProvider}
                      value={route.modelProvider || ''}
                      aria-label={`路由 ${index + 1} 模型提供方`}
                      placeholder="模型提供方"
                      onChange={(event) => handleRouteChange(index, { modelProvider: event.target.value })}
                    /> : null}
                    <div className={styles.routeOperations} aria-label={`路由 ${index + 1} 操作`}>
                      {ROUTE_OPERATIONS.map((operation) => (
                        <label key={operation.value} className={styles.routeOperation}>
                          <input
                            type="checkbox"
                            checked={route.operations.includes(operation.value)}
                            onChange={() => toggleRouteOperation(index, operation.value)}
                          />
                          {operation.label}
                        </label>
                      ))}
                    </div>
                    <div className={styles.routeActions}>
                      <Button
                        appVariant="icon"
                        aria-label={`路由 ${index + 1} 上移`}
                        icon={<ArrowUpOutlined />}
                        disabled={index === 0}
                        onClick={() => handleMoveRoute(index, -1)}
                      />
                      <Button
                        appVariant="icon"
                        aria-label={`路由 ${index + 1} 下移`}
                        icon={<ArrowDownOutlined />}
                        disabled={index === routes.length - 1}
                        onClick={() => handleMoveRoute(index, 1)}
                      />
                      <Button
                        appVariant="icon"
                        aria-label={`删除路由 ${index + 1}`}
                        icon={<MinusCircleOutlined />}
                        onClick={() => handleRemoveRoute(index)}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className={styles.routeEmpty}>尚未配置额外路由。添加后可按优先级尝试多个模型。</div>
          )}
          </section>
        </details>

        {fallbackFrom ? (
          <div className={styles.inlineNotice}>
            已保存的模型 {fallbackFrom} 当前不可用，本次改用{' '}
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
              onChange={(event) => handleTextChange(event.target.value)}
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
            {showConfirmation ? (
              <div className={styles.languageIntentStrip} role="status">
                <span>{intentMessage}</span>
                <Select
                  size="small"
                  value={target || undefined}
                  options={buildLanguageOptions(languages, { includeAuto: false })}
                  aria-label="确认目标语言"
                  onChange={handleTargetChange}
                />
                <Button appVariant="quiet" onClick={handleKeepOriginal}>保持原文</Button>
                {sameLanguage ? <Button appVariant="secondary" onClick={() => void handleTranslate('explicit')}>仍然翻译</Button> : null}
              </div>
            ) : null}
          </section>

          <section className={styles.pane} data-phase={feedback.phase} aria-busy={feedback.active}>
            <header className={styles.paneHeader}>
              <span className={styles.paneTitle}>译文</span>
              <span className={styles.paneMeta}>{routeLabel}</span>
            </header>
            {stream.state.status !== 'idle' || detecting ? (
              <div className={styles.translationStatus} role="status">
                <span className={styles.statusDot} aria-hidden="true" />
                <span key={feedback.phase} className={styles.statusCaption}>{feedback.label}</span>
                <span className={styles.statusElapsed}>{feedback.elapsedLabel}</span>
              </div>
            ) : null}
            <div className={styles.output}>
              {resultText ? (
                <div className={styles.outputText}>
                  {resultText}
                  {busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
                </div>
              ) : feedback.active ? (
                <div className={styles.waitingState}>
                  <span>{feedback.hint}</span>
                  <div className={styles.waitingSkeleton} aria-hidden="true"><span /><span /><span /></div>
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
                    停止生成
                  </Button>
                ) : null}
                {stream.state.status === 'cancelled' ? (
                  <Button appVariant="secondary" onClick={() => void handleTranslate()}>重新翻译</Button>
                ) : null}
                {canCopy ? <Button
                  appVariant="secondary"
                  icon={<CopyOutlined />}
                  onClick={handleCopy}
                >
                  {copied ? '已复制' : '复制'}
                </Button> : null}
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
