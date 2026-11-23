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
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  MinusCircleOutlined,
  PlusOutlined,
  SwapOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import Button from '@/components/ui/AppButton';
import PageScaffold from '@/components/ui/PageScaffold';
import Reveal from '@/components/ui/Reveal';
import SectionCard from '@/components/ui/SectionCard';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag from '@/components/ui/SettingStatusTag';
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
import TranslationProviderSettings, { type TranslationProviderFeedback } from './TranslationProviderSettings';

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

const QUICK_START_EXAMPLES = [
  '你好，世界！',
  '请把这段产品说明翻译得更自然。',
  '展示本地 Server 调度、熔断、恢复和队列的真实运行态。',
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

interface TranslationRoutesSectionProps {
  routes: TranslationRoutePreference[];
  providers: TranslationProviderOption[];
  models: TranslationBootstrap['models'];
  modelOptions: Array<{ value: string; label: string; title: string }>;
  onAdd: () => void;
  onChange: (index: number, patch: Partial<TranslationRoutePreference>) => void;
  onToggleOperation: (index: number, operation: TranslationRoutePreference['operations'][number]) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onRemove: (index: number) => void;
}

function TranslationRoutesSection({
  routes,
  providers,
  models,
  modelOptions,
  onAdd,
  onChange,
  onToggleOperation,
  onMove,
  onRemove,
}: TranslationRoutesSectionProps) {
  return (
    <SettingSection
      title="翻译路由"
      description="按顺序尝试已启用的路由，每条可限定适用场景。"
      status={<SettingStatusTag status={routes.length ? 'applied' : 'unset'} label={routes.length ? `已设定 ${routes.length} 条` : '未设定'} compact />}
      extra={(
        <Button appVariant="secondary" icon={<PlusOutlined />} onClick={onAdd}>
          添加路由
        </Button>
      )}
      className={styles.routePanel}
    >
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
                  onChange={(enabled) => onChange(index, { enabled })}
                />
                <Select
                  size="small"
                  className={styles.routeProvider}
                  value={route.provider}
                  aria-label={`路由 ${index + 1} 引擎`}
                  placeholder="引擎"
                  options={providers.map((item) => ({ value: item.id, label: `${item.label}（${item.configured ? '已设定' : '未设定'}）` }))}
                  onChange={(provider) => {
                    const selected = providers.find((item) => item.id === provider);
                    onChange(index, {
                      provider,
                      model: selected?.config.defaultModel || models[0]?.id || '',
                      modelProvider: selected?.config.modelSource === 'gateway' ? models[0]?.provider || '' : '',
                    });
                  }}
                />
                {gatewayModels ? (
                  <Select
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
                      onChange(index, {
                        model,
                        ...(selected?.provider ? { modelProvider: selected.provider } : {}),
                      });
                    }}
                  />
                ) : (
                  <Input
                    size="small"
                    className={styles.routeModel}
                    value={route.model}
                    aria-label={`路由 ${index + 1} 模型`}
                    placeholder={descriptor?.config.defaultModel || 'default'}
                    onChange={(event) => onChange(index, { model: event.target.value })}
                  />
                )}
                {gatewayModels ? (
                  <Input
                    size="small"
                    className={styles.routeModelProvider}
                    value={route.modelProvider || ''}
                    aria-label={`路由 ${index + 1} 模型提供方`}
                    placeholder="模型提供方"
                    onChange={(event) => onChange(index, { modelProvider: event.target.value })}
                  />
                ) : null}
                <div className={styles.routeOperations} aria-label={`路由 ${index + 1} 操作`}>
                  {ROUTE_OPERATIONS.map((operation) => (
                    <label key={operation.value} className={styles.routeOperation}>
                      <input
                        type="checkbox"
                        checked={route.operations.includes(operation.value)}
                        onChange={() => onToggleOperation(index, operation.value)}
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
                    onClick={() => onMove(index, -1)}
                  />
                  <Button
                    appVariant="icon"
                    aria-label={`路由 ${index + 1} 下移`}
                    icon={<ArrowDownOutlined />}
                    disabled={index === routes.length - 1}
                    onClick={() => onMove(index, 1)}
                  />
                  <Button
                    appVariant="icon"
                    aria-label={`删除路由 ${index + 1}`}
                    icon={<MinusCircleOutlined />}
                    onClick={() => onRemove(index)}
                  />
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className={styles.routeEmpty}>
          <span>尚未设定额外路由，默认使用上方模型。</span>
          <Button appVariant="quiet" size="small" icon={<PlusOutlined />} onClick={onAdd}>
            添加第一条路由
          </Button>
        </div>
      )}
    </SettingSection>
  );
}

interface TranslationHistorySectionProps {
  entries: ReturnType<typeof useTranslationHistory>['entries'];
  onClear: () => void;
  onCopy: (entry: ReturnType<typeof useTranslationHistory>['entries'][number]) => void;
  onRemove: (id: string) => void;
  onTryExample: () => void;
}

function TranslationHistorySection({
  entries,
  onClear,
  onCopy,
  onRemove,
  onTryExample,
}: TranslationHistorySectionProps) {
  return (
    <SectionCard
      title="翻译记录"
      className={styles.historyCard}
      bodyStyle={{ padding: 0 }}
      extra={(
        <div className={styles.historyHeaderRight}>
          <span className={styles.paneMeta}>{entries.length} 条 · 仅保存在本机</span>
          {entries.length ? (
            <Button
              appVariant="quiet"
              aria-label="清空翻译记录"
              onClick={onClear}
            >
              清空记录
            </Button>
          ) : null}
        </div>
      )}
    >
      {entries.length === 0 ? (
        <div className={styles.historyEmpty}>
          <strong>暂无翻译记录</strong>
          <span>完成一次翻译后，原文、译文与模型信息会保存在本机。</span>
          <Button appVariant="secondary" size="small" onClick={onTryExample}>
            填入示例开始翻译
          </Button>
        </div>
      ) : (
        <ul className={styles.historyList}>
          {entries.map((entry, index) => (
            <li key={entry.id} data-history-item className={`${styles.historyItem} ${index === 0 ? styles.historyItemLatest : ''}`}>
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
                    onClick={() => onCopy(entry)}
                  />
                  <Button
                    appVariant="icon"
                    aria-label="删除这条记录"
                    title="删除这条记录"
                    icon={<DeleteOutlined />}
                    onClick={() => onRemove(entry.id)}
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
    </SectionCard>
  );
}

export default function TranslationWorkspace() {
  const { status, bootstrap, error: bootstrapError, reload } = useTranslationBootstrap();
  const stream = useTranslationStream();
  const history = useTranslationHistory();
  useTranslationHistoryRecorder(stream.state);

  const sourceInputRef = useRef<{ resizableTextArea?: { textArea?: HTMLTextAreaElement } } | null>(null);

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
  const [providerFeedback, setProviderFeedback] = useState<Record<string, TranslationProviderFeedback>>({});
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
      setProviderFeedback((current) => ({
        ...current,
        [provider]: { tone: 'success', message: '已保存并立即可用' },
      }));
    }).catch(() => {
      setProviderError('保存失败，请检查字段和服务地址');
      setProviderFeedback((current) => ({
        ...current,
        [provider]: { tone: 'error', message: '保存失败，请检查字段与服务地址' },
      }));
    }).finally(() => setSavingProvider(''));
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

  // 改语言 = 用户想看新语言的译文：有原文就直接重译，不再要求再点一次「翻译」。
  const retranslateOnLanguageChange = useRef(false);

  const handleSourceChange = useCallback(
    (value: string) => {
      intentSequence.current += 1;
      retranslateOnLanguageChange.current = true;
      setSource(value);
      persist({ source: value });
    },
    [persist],
  );

  const handleTargetChange = useCallback(
    (value: string) => {
      intentSequence.current += 1;
      retranslateOnLanguageChange.current = true;
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
    retranslateOnLanguageChange.current = true;
    setSource(next.source);
    setTarget(next.target);
    persist({ source: next.source, target: next.target });
  }, [source, target, persist]);

  const requestTranslation = useCallback(
    (detectedCode: string, confidence: 'high' | 'medium' | 'low' | undefined, policy: TranslationTargetPolicy) => {
      const intent = resolveLanguageIntent(
        {
          source,
          target,
          detected: detectedCode,
          confidence,
          targetPolicy: policy,
          allowAutoSource: bootstrap?.settings.executionTarget === 'aih-server',
        },
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
    [bootstrap, languages, requestRoutes, selection.model, selection.provider, source, stream, target, text],
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

  useEffect(() => {
    if (!retranslateOnLanguageChange.current) return;
    retranslateOnLanguageChange.current = false;
    if (!canTranslate(text) || exceedsInputLimit(text)) return;
    stream.cancel();
    void handleTranslate('confirm');
    // 只响应语言变化；handleTranslate 每次渲染都会换引用。
  }, [source, target]);

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
  const detectedStatus = detecting
    ? '正在检测原文'
    : detectedLabel || (source === AUTO_LANGUAGE ? '等待输入后自动检测' : languageLabelOf(languages, source));
  const executionTarget = bootstrap?.settings.executionTarget === 'direct-provider'
    ? 'Provider 直连'
    : 'AIH Server';

  const languageIntent = resolveLanguageIntent(
    {
      source,
      target,
      detected: detectionMatchesText ? detection?.code : '',
      confidence: detectionMatchesText ? detection?.confidence : undefined,
      targetPolicy,
      allowAutoSource: bootstrap?.settings.executionTarget === 'aih-server',
    },
    languages,
  );
  const sameLanguage = languageIntent.state === 'same_language';
  const allowAutoSource = bootstrap?.settings.executionTarget === 'aih-server';
  const showConfirmation = Boolean(text.trim()) && !confirmationDismissed && languageIntent.state !== 'ready';
  const intentMessage = sameLanguage
    ? `原文已是${languageLabelOf(languages, target)}，请选择其它目标语言后再开始翻译。`
    : languageIntent.reason === 'source_detection_required'
      ? (allowAutoSource ? '正在交给翻译模型自动判断原文语言。' : '此翻译引擎需要源语言，请先重新识别或选择源语言。')
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
    // 每段一译完就写进页面（不等整页结束），撤销仍是一个整体。
    const undoSegments: Array<() => void> = [];
    pageUndoRef.current = () => { while (undoSegments.length) undoSegments.pop()?.(); };
    try {
      await translator(segments, controller.signal, (item) => {
        if (!controller.signal.aborted && item.text.trim()) {
          undoSegments.push(applyPageTranslation([item], pageMode));
          setPageApplied(true);
        }
        setPageProgress((current) => {
          const next = current.filter((entry) => entry.segment.id !== item.segment.id);
          next.push(item);
          return next.sort((a, b) => a.segment.index - b.segment.index);
        });
      });
      if (controller.signal.aborted) setPageCancelled(true);
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

  const pageFailedCount = pageProgress.filter((item) => Boolean(item.error)).length;
  const configuredProviderCount = providers.filter((item) => item.configured).length;
  const handleTryQuickExample = useCallback(() => {
    handleTextChange(QUICK_START_EXAMPLES[0]);
    sourceInputRef.current?.resizableTextArea?.textArea?.focus();
  }, [handleTextChange]);

  return (
    <PageScaffold
      title="翻译工作台"
      code="TRANSLATE"
      subTitle="统一处理选区、整页与长文本翻译，划词浮层共用语言与模型默认值。"
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
        {status === 'loading' ? (
          <div className={styles.inlineNotice} role="status" aria-live="polite">
            正在读取翻译语言与默认模型…
          </div>
        ) : null}

        {status === 'error' ? (
          <div className={styles.inlineError} role="alert">
            <span>{bootstrapError || '加载翻译设置失败'}</span>
            <Button appVariant="quiet" onClick={reload}>
              重试
            </Button>
          </div>
        ) : null}

        <div className={styles.heroBar}>
          <div className={`${styles.languageToolbar} ${styles.heroLanguageControl}`}>
            <div className={styles.languageField}>
              <label className={styles.fieldLabel} htmlFor="translation-source-language">源语言</label>
              <Select
                id="translation-source-language"
                className={styles.languageSelect}
                value={source}
                options={languageOptions}
                optionFilterProp="label"
                showSearch
                aria-label="选择源语言"
                onChange={handleSourceChange}
              />
            </div>
            <Tooltip title={canSwapLanguages(source, target) ? '互换源语言与目标语言' : '自动检测时无法互换'}>
              <Button
                appVariant="icon"
                aria-label="互换语言"
                icon={<SwapOutlined />}
                disabled={!canSwapLanguages(source, target)}
                onClick={handleSwap}
              />
            </Tooltip>
            <div className={`${styles.languageField} ${styles.targetLanguageField}`}>
              <label className={styles.fieldLabel} htmlFor="translation-target-language">目标语言</label>
              <Select
                id="translation-target-language"
                className={`${styles.languageSelect} ${styles.targetLanguageSelect}`}
                value={target}
                options={languageOptions.filter((option) => option.value !== AUTO_LANGUAGE)}
                optionFilterProp="label"
                showSearch
                aria-label="选择目标语言"
                onChange={handleTargetChange}
              />
            </div>
          </div>
          <div className={styles.heroMeta}>
            <span className={styles.metaReadout} role="status">
              识别：{detectedStatus}
            </span>
            <span className={styles.metaReadout} title={selection.model || bootstrap?.defaultModel || '自动选择可用模型'}>
              模型：{selection.model || bootstrap?.defaultModel || '自动选择'} · {executionTarget}
            </span>
          </div>
        </div>

        <div className={styles.panes}>
          <section className={`${styles.pane} ${styles.paneSource}`} aria-labelledby="translation-source-title">
            <header className={styles.paneHeader}>
              <span id="translation-source-title" className={styles.paneTitle}>原文输入</span>
              <span className={styles.paneMeta}>{chars} 字符</span>
            </header>
            <Input.TextArea
              ref={sourceInputRef}
              className={styles.sourceInput}
              value={text}
              onChange={(event) => handleTextChange(event.target.value)}
              onKeyDown={handleTextKeyDown}
              aria-label="原文输入"
              placeholder="粘贴要翻译的内容，或直接在这里输入…"
              autoSize={false}
              spellCheck={false}
            />
            {!text && !busy ? (
              <div className={styles.sourceEmptyState} aria-label="快速开始示例">
                <span className={styles.sourceEmptyEyebrow}>快速示例</span>
                <div className={styles.quickExamples}>
                  {QUICK_START_EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      className={styles.quickExample}
                      onClick={() => handleTextChange(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
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
                  <span className={styles.limitWarning} role="alert">
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
                  aria-label="清空原文和译文"
                  disabled={!text && !resultText}
                  onClick={handleClear}
                >
                  清空
                </Button>
                <Button
                  type="primary"
                  className={styles.primaryAction}
                  aria-label="开始翻译"
                  icon={<TranslationOutlined />}
                  loading={busy || detecting}
                  disabled={!canTranslate(text) || overLimit || sameLanguage}
                  onClick={() => void handleTranslate()}
                >
                  {busy || detecting ? '翻译中' : '开始翻译'}
                </Button>
              </div>
            </footer>
            <Reveal open={showConfirmation}>
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
            </Reveal>
          </section>

          <section className={`${styles.pane} ${styles.paneResult}`} data-phase={feedback.phase} aria-labelledby="translation-result-title" aria-busy={feedback.active}>
            <header className={styles.paneHeader}>
              <span id="translation-result-title" className={styles.paneTitle}>译文输出</span>
              <span className={styles.paneMeta}>{routeLabel}</span>
            </header>
            <Reveal open={stream.state.status !== 'idle' || detecting}>
              <div className={styles.translationStatus} role="status" aria-live="polite">
                <span className={styles.statusCaption}>{feedback.label}</span>
                <span className={styles.statusElapsed}>{feedback.elapsedLabel}</span>
              </div>
            </Reveal>
            <div className={styles.output} aria-label="译文输出">
              {resultText ? (
                <div className={styles.outputText}>
                  {resultText}
                  {busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
                </div>
              ) : feedback.active ? (
                <div className={styles.waitingState} role="status" aria-live="polite">
                  <span>{feedback.hint}</span>
                </div>
              ) : (
                <div className={styles.outputEmpty}>
                  <strong>等待翻译内容</strong>
                  <span>在左侧输入原文后开始翻译，译文会流式显示在这里。</span>
                  <Button appVariant="secondary" size="small" onClick={handleTryQuickExample}>
                    填入示例文本
                  </Button>
                </div>
              )}
            </div>
            {stream.state.status === 'error' && stream.state.error ? (
              <div className={styles.inlineError} role="alert">
                <span>{stream.state.error.message}</span>
                {stream.state.error.code ? (
                  <code className={styles.errorCode}>{stream.state.error.code}</code>
                ) : null}
                <Button appVariant="quiet" aria-label="重试翻译" onClick={() => void handleTranslate()}>
                  重试
                </Button>
              </div>
            ) : null}
            <footer className={`${styles.paneFooter} ${styles.resultToolbar}`}>
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
                  <Button appVariant="secondary" aria-label="停止翻译" onClick={stream.cancel}>
                    停止生成
                  </Button>
                ) : null}
                {stream.state.status === 'cancelled' ? (
                  <Button appVariant="secondary" aria-label="重新翻译" onClick={() => void handleTranslate()}>重新翻译</Button>
                ) : null}
                {canCopy ? (
                  <Button
                    appVariant="secondary"
                    className={copied ? styles.copyConfirmed : undefined}
                    aria-label={copied ? '已复制译文' : '复制译文'}
                    icon={copied ? <CheckOutlined /> : <CopyOutlined />}
                    onClick={handleCopy}
                  >
                    {copied ? '已复制' : '复制'}
                  </Button>
                ) : null}
              </div>
            </footer>
          </section>
        </div>

        {fallbackFrom ? (
          <div className={styles.inlineNotice} role="status">
            已保存的模型 {fallbackFrom} 当前不可用，本次改用{' '}
            {selection.model || '服务端默认模型'}
          </div>
        ) : null}

        <section className={styles.pageTranslationPanel} aria-labelledby="translation-page-title">
          <div className={styles.pageTranslationHeader}>
            <div>
              <span id="translation-page-title" className={styles.paneTitle}>整页翻译</span>
              <span className={styles.routeHint}>识别正文段落后并发翻译，支持原文旁注或替换原文。</span>
            </div>
            <div className={styles.pageTranslationActions}>
              <Select
                size="small"
                value={pageMode}
                aria-label="整页翻译显示方式"
                options={[{ value: 'side-by-side', label: '原文旁注' }, { value: 'replace', label: '替换原文' }]}
                onChange={setPageMode}
              />
              {pageBusy ? (
                <Button appVariant="quiet" aria-label="停止整页翻译" onClick={() => pageAbortRef.current?.abort()}>
                  停止
                </Button>
              ) : (
                <Button appVariant="secondary" onClick={() => void translateCurrentPage()}>
                  {pageFailedCount || pageCancelled ? '重试页面翻译' : '翻译当前页面'}
                </Button>
              )}
              {pageApplied && !pageBusy ? (
                <Button
                  appVariant="quiet"
                  aria-label="撤回页面译文"
                  onClick={() => {
                    pageUndoRef.current?.();
                    pageUndoRef.current = null;
                    setPageProgress([]);
                    setPageApplied(false);
                  }}
                >
                  撤回页面译文
                </Button>
              ) : null}
            </div>
          </div>
          <Reveal open={Boolean(pageBusy || pageProgress.length || pageCancelled)}>
            <div className={styles.pageTranslationProgress} role="status" aria-live="polite">
              <span>{pageBusy ? '正在翻译页面' : pageCancelled ? '已停止页面翻译' : '页面翻译完成'} · 已处理 {pageProgress.length} 段</span>
              {pageFailedCount ? <span className={styles.limitWarning}>失败 {pageFailedCount} 段，可重试</span> : null}
            </div>
          </Reveal>
        </section>

        <details className={styles.advancedTranslationSettings}>
          <summary>
            <span className={styles.settingsSummaryTitle}>高级设置</span>
            <span className={styles.savedHint}>
              默认模型、系统取词、Provider（已设定 {configuredProviderCount}/{providers.length}）与路由
            </span>
            <span className={styles.settingsSummaryHint}>展开配置</span>
          </summary>
          <div className={styles.advancedSettingsBody}>
            <SettingSection
              title="常规偏好"
              description="变更会立即保存并同步到划词浮层与整页翻译。"
              className={styles.generalSettingsSection}
            >
              <SettingRow
                title="默认模型"
                htmlFor="translation-default-model"
                description="留空时由服务端按可用账号自动选择。"
                persistedValue={modelValue ? `已保存：${modelValue}` : '已保存：自动选择'}
                status={<SettingStatusTag status={modelValue ? 'applied' : 'unset'} label={modelValue ? '已设定' : '自动'} compact />}
                control={(
                  <Select
                    id="translation-default-model"
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
                )}
              />
              <SettingRow
                title="完成后自动复制"
                description="整段翻译成功后自动复制译文到剪贴板。"
                status={<SettingStatusTag status={autoCopy ? 'applied' : 'unset'} label={autoCopy ? '已开启' : '未开启'} compact />}
                control={(
                  <div className={styles.copySettingsControl}>
                    <Switch
                      size="small"
                      checked={autoCopy}
                      aria-label="完成后自动复制"
                      onChange={(checked) => { setAutoCopy(checked); persist({ autoCopy: checked }); }}
                    />
                    {autoCopy ? (
                      <Select
                        size="small"
                        value={copyScope}
                        aria-label="自动复制范围"
                        options={[{ value: 'selection', label: '选区' }, { value: 'page', label: '页面' }, { value: 'all', label: '全部' }]}
                        onChange={(value) => { setCopyScope(value); persist({ copyScope: value }); }}
                      />
                    ) : null}
                  </div>
                )}
              />
              <SettingRow
                title="系统级取词"
                description="桌面取词开关、执行目标与全局快捷键。"
                layout="stacked"
                control={<SystemTranslationControl persistedExecutionTarget={bootstrap?.settings.executionTarget} />}
              />
            </SettingSection>

            <TranslationProviderSettings
              providers={providers}
              drafts={providerDrafts}
              saving={savingProvider}
              error={providerError}
              feedbackByProvider={providerFeedback}
              onChange={(provider, field, value) => {
                setProviderDrafts((current) => ({ ...current, [provider]: { ...current[provider], [field]: value } }));
                setProviderFeedback((current) => {
                  if (!current[provider]) return current;
                  const next = { ...current };
                  delete next[provider];
                  return next;
                });
              }}
              onReset={(provider) => {
                setProviderDrafts((current) => ({ ...current, [provider]: {} }));
                setProviderFeedback((current) => {
                  if (!current[provider]) return current;
                  const next = { ...current };
                  delete next[provider];
                  return next;
                });
              }}
              onSave={saveProvider}
              onReload={reloadProviders}
            />

            <TranslationRoutesSection
              routes={routes}
              providers={providers}
              models={models}
              modelOptions={modelOptions}
              onAdd={handleAddRoute}
              onChange={handleRouteChange}
              onToggleOperation={toggleRouteOperation}
              onMove={handleMoveRoute}
              onRemove={handleRemoveRoute}
            />
          </div>
        </details>

        <TranslationHistorySection
          entries={history.entries}
          onClear={history.clear}
          onCopy={(entry) => void handleCopyHistory(entry)}
          onRemove={history.remove}
          onTryExample={handleTryQuickExample}
        />
      </div>
    </PageScaffold>
  );
}
