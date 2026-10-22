import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Select, message } from 'antd';
import { CopyOutlined, SwapOutlined } from '@ant-design/icons';
import {
  AUTO_LANGUAGE,
  MAX_TRANSLATION_INPUT_CHARS,
  buildLanguageOptions,
  buildModelOptions,
  canSwapLanguages,
  canTranslate,
  countCharacters,
  exceedsInputLimit,
  modelOptionLabel,
  resolveTranslationSelection,
  swapLanguages,
} from '@/features/translation/translation-utils';
import { saveTranslationSettings } from '@/features/translation/translation-settings-store';
import {
  useTranslationBootstrap,
  useTranslationStream,
} from '@/features/translation/use-translation';
import {
  useTranslationHistory,
  useTranslationHistoryRecorder,
} from '@/features/translation/use-translation-history';
import { formatTranslationHistoryTime } from '@/features/translation/translation-history';
import { translationAPI } from '@/services/api';
import MobileBoot from '@/mobile/MobileBoot';
import { HudSection, MobilePage, MobileToolbar } from '@/mobile/ui';
import type { TranslationDetectionResponse } from '@/types';
import styles from './MobileTranslation.module.css';

/**
 * 移动端 AI 翻译（/translation）。
 * 与桌面页共用同一份默认设置与同一个流式 hook，只是布局改成单列：
 * 语言 → 输入 → 动作 → 译文，避免在窄屏上做双栏。
 */
export default function MobileTranslation() {
  const { status, bootstrap, error, reload } = useTranslationBootstrap();
  const stream = useTranslationStream();
  const history = useTranslationHistory();
  useTranslationHistoryRecorder(stream.state);
  const [text, setText] = useState('');
  const [source, setSource] = useState(AUTO_LANGUAGE);
  const [target, setTarget] = useState('zh-Hans');
  const [modelValue, setModelValue] = useState('');
  const [providerValue, setProviderValue] = useState('');
  const [detection, setDetection] = useState<TranslationDetectionResponse | null>(null);
  const detectionSequence = useRef(0);

  useEffect(() => {
    if (!bootstrap) return;
    setSource(bootstrap.settings.source || AUTO_LANGUAGE);
    setTarget(bootstrap.settings.target || 'zh-Hans');
    setModelValue(bootstrap.settings.model || '');
    setProviderValue(bootstrap.settings.provider || '');
  }, [bootstrap]);

  useEffect(() => {
    if (source !== AUTO_LANGUAGE) {
      detectionSequence.current += 1;
      setDetection(null);
      return;
    }
    const sample = text.trim();
    if (!sample) {
      detectionSequence.current += 1;
      setDetection(null);
      return;
    }
    const sequence = ++detectionSequence.current;
    const timer = window.setTimeout(() => {
      translationAPI
        .detect(sample.slice(0, 1200))
        .then((response) => {
          if (sequence === detectionSequence.current) setDetection(response);
        })
        .catch(() => {
          if (sequence === detectionSequence.current) setDetection(null);
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [text, source]);

  const languages = bootstrap?.languages || [];
  const models = bootstrap?.models || [];
  const languageOptions = useMemo(() => buildLanguageOptions(languages), [languages]);
  const targetOptions = useMemo(
    () => languageOptions.filter((option) => option.value !== AUTO_LANGUAGE),
    [languageOptions],
  );
  const modelOptions = useMemo(
    () =>
      buildModelOptions(models).map((option) => ({
        value: option.value,
        label: modelOptionLabel(option),
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

  const persist = useCallback((patch: { source?: string; target?: string; model?: string; provider?: string }) => {
    void saveTranslationSettings(patch).catch(() => {
      // 默认值保存失败不影响本次翻译。
    });
  }, []);

  const handleTranslate = useCallback(() => {
    if (!canTranslate(text)) {
      message.info('先输入要翻译的内容');
      return;
    }
    if (exceedsInputLimit(text)) {
      message.warning(`单次最多 ${MAX_TRANSLATION_INPUT_CHARS} 字符`);
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

  const copyResult = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(stream.state.text);
      message.success('译文已复制');
    } catch (_error) {
      message.error('复制失败，请手动选择译文');
    }
  }, [stream.state.text]);

  if (status === 'loading' && !bootstrap) {
    return <MobileBoot label="LOADING TRANSLATE" />;
  }

  const chars = countCharacters(text);
  const overLimit = exceedsInputLimit(text);
  const busy = stream.busy;
  const resultText = stream.state.text;
  const meta = stream.state.meta;

  return (
    <MobilePage
      toolbar={
        <MobileToolbar
          start={<span className={styles.toolbarCode}>TRANSLATE</span>}
        >
          {busy ? (
            <Button size="small" onClick={stream.cancel}>
              停止
            </Button>
          ) : (
            <Button size="small" type="primary" disabled={!canTranslate(text) || overLimit} onClick={handleTranslate}>
              翻译
            </Button>
          )}
        </MobileToolbar>
      }
    >
      {status === 'error' ? (
        <div className={styles.inlineError}>
          {error || '加载翻译设置失败'}
          <button type="button" className={styles.linkButton} onClick={reload}>
            重试
          </button>
        </div>
      ) : null}

      <HudSection title="翻译" code="IN">
        <div className={styles.languageRow}>
          <Select
            className={styles.languageSelect}
            value={source}
            options={languageOptions}
            optionFilterProp="label"
            showSearch
            onChange={(value) => {
              setSource(value);
              persist({ source: value });
            }}
          />
          <Button
            size="small"
            aria-label="互换语言"
            icon={<SwapOutlined />}
            disabled={!canSwapLanguages(source, target)}
            onClick={() => {
              if (!canSwapLanguages(source, target)) return;
              const next = swapLanguages(source, target);
              setSource(next.source);
              setTarget(next.target);
              persist({ source: next.source, target: next.target });
            }}
          />
          <Select
            className={styles.languageSelect}
            value={target}
            options={targetOptions}
            optionFilterProp="label"
            showSearch
            onChange={(value) => {
              setTarget(value);
              persist({ target: value });
            }}
          />
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
          onChange={(value) => {
            const normalized = value || '';
            const hit = models.find((item) => item.id === normalized);
            const provider = normalized ? String(hit?.provider || '') : '';
            setModelValue(normalized);
            setProviderValue(provider);
            persist({ model: normalized, provider });
          }}
        />

        <Input.TextArea
          className={styles.input}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="粘贴或输入要翻译的内容…"
          autoSize={{ minRows: 5, maxRows: 12 }}
          spellCheck={false}
        />

        <div className={styles.inputMeta}>
          <span className={overLimit ? styles.limitWarning : styles.counter}>
            {chars} / {MAX_TRANSLATION_INPUT_CHARS}
          </span>
          {source === AUTO_LANGUAGE && detection ? (
            <span className={styles.detectChip}>检测到 {detection.label}</span>
          ) : null}
        </div>
      </HudSection>

      <HudSection
        title="译文"
        code="OUT"
        extra={
          resultText ? (
            <button type="button" className={styles.linkButton} onClick={copyResult}>
              <CopyOutlined /> 复制
            </button>
          ) : null
        }
      >
        {meta ? (
          <div className={styles.resultMeta}>
            {meta.fromLabel} → {meta.toLabel}
            {meta.model ? ` · ${meta.model}` : ''}
          </div>
        ) : null}
        <div className={styles.result}>
          {resultText ? (
            <div className={styles.resultText}>
              {resultText}
              {busy ? <span className={styles.cursor} aria-hidden="true" /> : null}
            </div>
          ) : (
            <span className={styles.placeholder}>
              {busy ? '正在翻译…' : '译文会在这里出现'}
            </span>
          )}
        </div>
        {stream.state.status === 'error' && stream.state.error ? (
          <div className={styles.inlineError}>
            {stream.state.error.message}
            <button type="button" className={styles.linkButton} onClick={handleTranslate}>
              重试
            </button>
          </div>
        ) : null}
      </HudSection>

      <HudSection
        title="翻译记录"
        code="LOG"
        extra={
          history.entries.length ? (
            <button type="button" className={styles.linkButton} onClick={history.clear}>
              清空
            </button>
          ) : null
        }
      >
        {history.entries.length === 0 ? (
          <span className={styles.placeholder}>
            完成一次翻译后，原文 / 译文 / 模型会记录在这里。
          </span>
        ) : (
          <div className={styles.historyList}>
            {history.entries.map((entry) => (
              <div key={entry.id} className={styles.historyItem}>
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
                </div>
                <div className={styles.historySource} title={entry.sourceText}>
                  {entry.sourceText}
                </div>
                <div className={styles.historyResult} title={entry.resultText}>
                  {entry.resultText}
                </div>
                <div className={styles.historyActions}>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(entry.resultText);
                        message.success('译文已复制');
                      } catch (_error) {
                        message.error('复制失败，请手动选择译文');
                      }
                    }}
                  >
                    <CopyOutlined /> 复制译文
                  </button>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => history.remove(entry.id)}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </HudSection>
    </MobilePage>
  );
}
