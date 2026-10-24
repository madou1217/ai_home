import { Input, Tag } from 'antd';
import Button from '@/components/ui/AppButton';
import type { TranslationProviderOption } from '@/types';
import styles from './translation.module.css';

interface Props {
  providers: TranslationProviderOption[];
  drafts: Record<string, Record<string, string>>;
  saving: string;
  error: string;
  onChange: (provider: string, field: string, value: string) => void;
  onSave: (provider: string, config: Record<string, string>) => void;
  onReload: () => void;
}

export default function TranslationProviderSettings({ providers, drafts, saving, error, onChange, onSave, onReload }: Props) {
  return (
    <details className={styles.providerSettings}>
      <summary>翻译引擎设置 <span className={styles.savedHint}>配置服务地址和凭据</span></summary>
      {error ? <div className={styles.inlineError} role="status">{error}<Button appVariant="quiet" onClick={onReload}>重试</Button></div> : null}
      {!providers.length && !error ? <span className={styles.savedHint}>正在读取引擎目录…</span> : null}
      {providers.map((provider) => {
        const fields = Object.entries(provider.config.fieldDefinitions || {}).filter(([name]) => provider.config.fields.includes(name));
        const draft = drafts[provider.id] || {};
        return (
          <section key={provider.id} className={styles.providerSettingsRow} aria-label={`${provider.label} 设置`}>
            <div className={styles.providerSettingsHeading}>
              <strong>{provider.label}</strong>
              <Tag color={provider.configured && provider.executable ? 'success' : 'default'}>{provider.configured && provider.executable ? '可用' : '待配置'}</Tag>
              <span className={styles.savedHint}>{provider.metadata.accessLabel}</span>
            </div>
            <span className={styles.savedHint}>{provider.metadata.accessDescription}</span>
            <span className={styles.savedHint}>支持：{provider.operations.join(' / ')}{provider.capabilities.streaming ? ' · 流式输出' : ' · 完整结果'}</span>
            {fields.length ? <div className={styles.providerFields}>
              {fields.map(([name, field]) => (
                <label key={name} className={styles.providerField}>
                  <span className={styles.fieldLabel}>{field.label}{field.required ? ' *' : ''}</span>
                  {field.secret ? <Input.Password
                    size="small"
                    autoComplete="new-password"
                    value={draft[name] || ''}
                    placeholder={provider.secretConfigured[name] ? '已保存，留空保留' : '尚未配置'}
                    onChange={(event) => onChange(provider.id, name, event.target.value)}
                  /> : <Input
                    size="small"
                    value={draft[name] ?? provider.values[name] ?? ''}
                    placeholder={field.placeholder || field.defaultValue}
                    onChange={(event) => onChange(provider.id, name, event.target.value)}
                  />}
                </label>
              ))}
              <Button appVariant="secondary" loading={saving === provider.id} disabled={Boolean(saving)} onClick={() => onSave(provider.id, Object.fromEntries(Object.entries(draft).filter(([name, value]) => !provider.config.fieldDefinitions?.[name]?.secret || Boolean(value.trim()))))}>保存</Button>
              {fields.filter(([name, field]) => field.secret && provider.secretConfigured[name]).map(([name]) => <Button key={name} appVariant="quiet" disabled={Boolean(saving)} onClick={() => onSave(provider.id, { [name]: '' })}>清除密钥</Button>)}
            </div> : null}
          </section>
        );
      })}
    </details>
  );
}
