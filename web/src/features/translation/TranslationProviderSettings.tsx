import { Input, Tabs } from 'antd';
import AppButton from '@/components/ui/AppButton';
import SaveActionBar from '@/components/ui/SaveActionBar';
import { SettingRow, SettingSection } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import type { TranslationProviderOption } from '@/types';
import { getTranslationProviderStatus } from './translation-targets';
import styles from './translation.module.css';

export interface TranslationProviderFeedback {
  tone: 'success' | 'error';
  message: string;
}

interface Props {
  providers: TranslationProviderOption[];
  drafts: Record<string, Record<string, string>>;
  saving: string;
  error: string;
  feedbackByProvider?: Record<string, TranslationProviderFeedback>;
  onChange: (provider: string, field: string, value: string) => void;
  onReset?: (provider: string) => void;
  onSave: (provider: string, config: Record<string, string>) => void;
  onReload: () => void;
}

function resolveProviderConfigTag(provider: TranslationProviderOption): {
  status: SettingStatusState;
  label: string;
} {
  const status = getTranslationProviderStatus(provider);
  if (status.state === 'unavailable') {
    return { status: 'error', label: '不可用' };
  }
  if (status.state === 'configured') {
    return { status: 'saved', label: '已设定' };
  }
  return { status: 'unset', label: '未设定' };
}

function buildProviderPatch(
  provider: TranslationProviderOption,
  draft: Record<string, string>,
): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [name, value] of Object.entries(draft)) {
    const field = provider.config.fieldDefinitions?.[name];
    if (!field) continue;
    if (field.secret) {
      if (value.trim()) {
        patch[name] = value;
      }
      continue;
    }
    const persisted = provider.values[name] ?? '';
    if (value !== persisted) {
      patch[name] = value;
    }
  }
  return patch;
}

interface ProviderPanelProps {
  provider: TranslationProviderOption;
  draft: Record<string, string>;
  saving: string;
  feedback?: TranslationProviderFeedback;
  onChange: (provider: string, field: string, value: string) => void;
  onReset?: (provider: string) => void;
  onSave: (provider: string, config: Record<string, string>) => void;
}

function ProviderConfigPanel({
  provider,
  draft,
  saving,
  feedback,
  onChange,
  onReset,
  onSave,
}: ProviderPanelProps) {
  const fields = Object.entries(provider.config.fieldDefinitions || {})
    .filter(([name]) => provider.config.fields.includes(name));
  const configTag = resolveProviderConfigTag(provider);
  const missingFields = provider.missingFields.map(
    (name) => provider.config.fieldDefinitions?.[name]?.label || name,
  );
  const patch = buildProviderPatch(provider, draft);
  const isDirty = Object.keys(patch).length > 0;
  const isSaving = saving === provider.id;
  const secretFieldsConfigured = fields.filter(
    ([name, field]) => field.secret && provider.secretConfigured[name],
  );
  const capabilitySummary = `${provider.metadata.accessLabel} · 支持 ${(provider.capabilities.operations || []).join(' / ')}${provider.capabilities.streaming ? ' · 流式输出' : ' · 完整结果'}`;

  return (
    <SettingSection
      title={provider.label}
      description={provider.metadata.accessDescription}
      status={<SettingStatusTag status={configTag.status} label={configTag.label} compact />}
      className={styles.providerSection}
      footer={fields.length ? (
        <SaveActionBar
          dirty={isDirty}
          saving={isSaving}
          disabled={Boolean(saving) && !isSaving}
          onSave={() => onSave(provider.id, patch)}
          onReset={onReset ? () => onReset(provider.id) : undefined}
          saveLabel="保存配置"
          cleanSaveLabel="已保存"
          resetLabel="放弃修改"
          status={isSaving ? 'saving' : feedback?.tone === 'error' ? 'error' : isDirty ? 'dirty' : configTag.status}
          statusLabel={isSaving ? '保存中' : feedback?.tone === 'error' ? '保存失败' : isDirty ? '未保存' : configTag.label}
          effectSummary="保存后立即可用于翻译路由与请求"
          feedback={feedback?.message}
          feedbackTone={feedback?.tone === 'error' ? 'error' : feedback?.tone === 'success' ? 'success' : 'muted'}
          extraActions={secretFieldsConfigured.length ? (
            <>
              {secretFieldsConfigured.map(([name, field]) => (
                <AppButton
                  key={name}
                  appVariant="quiet"
                  disabled={Boolean(saving)}
                  onClick={() => onSave(provider.id, { [name]: '' })}
                >
                  清除{field.label}
                </AppButton>
              ))}
            </>
          ) : undefined}
        />
      ) : undefined}
    >
      <div className={styles.providerMetaStrip}>
        <span className={styles.savedHint}>{capabilitySummary}</span>
        {missingFields.length ? (
          <span className={styles.providerMissingFields} role="status">
            未设定必填项：{missingFields.join('、')}
          </span>
        ) : null}
        {!provider.executable ? (
          <span className={styles.providerMissingFields} role="status">
            当前环境无法执行此引擎
          </span>
        ) : null}
      </div>

      {fields.length ? (
        fields.map(([name, field]) => {
          const inputId = `translation-provider-${provider.id}-${name}`;
          const persistedText = field.secret
            ? (provider.secretConfigured[name] ? '已保存：已设定（留空保留原密钥）' : '已保存：未设定')
            : (provider.values[name] ? `已保存：${provider.values[name]}` : '已保存：未设定');
          const fieldDirty = field.secret
            ? Boolean((draft[name] || '').trim())
            : name in draft && draft[name] !== (provider.values[name] ?? '');
          const fieldStatus: SettingStatusState = fieldDirty
            ? 'dirty'
            : (field.secret ? provider.secretConfigured[name] : Boolean(provider.values[name]))
              ? 'saved'
              : 'unset';

          return (
            <SettingRow
              key={name}
              htmlFor={inputId}
              title={`${field.label}${field.required ? ' *' : ''}`}
              persistedValue={persistedText}
              status={
                <SettingStatusTag
                  status={fieldStatus}
                  label={fieldStatus === 'dirty' ? '未保存' : fieldStatus === 'saved' ? '已设定' : '未设定'}
                  compact
                />
              }
              control={field.secret ? (
                <Input.Password
                  id={inputId}
                  size="small"
                  autoComplete="new-password"
                  value={draft[name] || ''}
                  placeholder={provider.secretConfigured[name] ? '输入新密钥以替换' : '请输入密钥'}
                  onChange={(event) => onChange(provider.id, name, event.target.value)}
                />
              ) : (
                <Input
                  id={inputId}
                  size="small"
                  value={draft[name] ?? provider.values[name] ?? ''}
                  placeholder={field.placeholder || field.defaultValue}
                  onChange={(event) => onChange(provider.id, name, event.target.value)}
                />
              )}
            />
          );
        })
      ) : (
        <div className={styles.providerNoFields}>
          <span className={styles.savedHint}>该引擎由本机或网关直接提供，无需额外凭据。</span>
        </div>
      )}
    </SettingSection>
  );
}

export default function TranslationProviderSettings({
  providers,
  drafts,
  saving,
  error,
  feedbackByProvider,
  onChange,
  onReset,
  onSave,
  onReload,
}: Props) {
  return (
    <section
      className={styles.providerSettings}
      aria-label="翻译 Provider 配置"
      aria-busy={!providers.length && !error}
    >
      {error ? (
        <div className={styles.inlineError} role="alert">
          <span>{error}</span>
          <AppButton appVariant="quiet" onClick={onReload}>重试</AppButton>
        </div>
      ) : null}
      {!providers.length && !error ? (
        <span className={styles.savedHint} role="status" aria-live="polite">
          正在读取引擎配置…
        </span>
      ) : null}
      {providers.length > 3 ? (
        <Tabs
          className={styles.providerTabs}
          animated={false}
          items={providers.map((provider) => {
            const tag = resolveProviderConfigTag(provider);
            return {
              key: provider.id,
              label: `${provider.label}（${tag.label}）`,
              children: (
                <ProviderConfigPanel
                  provider={provider}
                  draft={drafts[provider.id] || {}}
                  saving={saving}
                  feedback={feedbackByProvider?.[provider.id]}
                  onChange={onChange}
                  onReset={onReset}
                  onSave={onSave}
                />
              ),
            };
          })}
        />
      ) : (
        <div className={styles.providerStack}>
          {providers.map((provider) => (
            <ProviderConfigPanel
              key={provider.id}
              provider={provider}
              draft={drafts[provider.id] || {}}
              saving={saving}
              feedback={feedbackByProvider?.[provider.id]}
              onChange={onChange}
              onReset={onReset}
              onSave={onSave}
            />
          ))}
        </div>
      )}
    </section>
  );
}
