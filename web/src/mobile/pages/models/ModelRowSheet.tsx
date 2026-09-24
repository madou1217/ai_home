import { CopyOutlined, RightOutlined } from '@ant-design/icons';
import { history } from '@umijs/max';
import ProviderIcon, { providerNames } from '@/components/chat/ProviderIcon';
import { isGlobalModelVisible, type GlobalModelRow } from '@/features/models/model-catalog';
import { DetailSheet, HudIconButton, HudSection, KeyValue, MonoList, SwipeRow } from '@/mobile/ui';
import styles from './MobileModels.module.css';

interface Props {
  row: GlobalModelRow | null;
  displayLabel: string;
  onClose: () => void;
  onCopyId: (modelId: string) => void;
}

/** 与 Accounts 页进入「账号模型」的路径构造一致 */
const accountModelsPath = (provider: string, accountRef: string) => (
  `/accounts/${encodeURIComponent(provider)}/${encodeURIComponent(accountRef)}/models`
);

/** 模型详情抽屉：桌面全局行的全部字段 + 承载该模型的账号（点按进入该账号的模型管理页）。 */
export default function ModelRowSheet({ row, displayLabel, onClose, onCopyId }: Props) {
  const visible = row ? isGlobalModelVisible(row) : false;
  return (
    <DetailSheet
      open={Boolean(row)}
      onClose={onClose}
      code="MODEL"
      title={row ? (displayLabel || row.id) : ''}
      footer={row ? (
        <HudIconButton
          icon={<CopyOutlined />}
          label="复制模型 ID"
          tone="primary"
          showLabel
          onClick={() => onCopyId(row.id)}
        />
      ) : null}
    >
      {row ? (
        <div className={styles.sheetStack}>
          <KeyValue
            rows={[
              { key: 'id', label: '模型 ID', value: row.id },
              ...(displayLabel ? [{ key: 'label', label: '显示名', value: displayLabel, mono: false }] : []),
              {
                key: 'providers',
                label: '来源',
                mono: false,
                value: row.providers.length > 0 ? row.providers.map((provider) => providerNames[provider] || provider).join(' / ') : '未知来源'
              },
              { key: 'owner', label: 'owned_by', value: row.owned_by || 'aih' },
              { key: 'object', label: 'object', value: row.object },
              { key: 'visible', label: '可见性', value: visible ? '可见' : '不可见', tone: visible ? 'ok' : 'muted' },
              { key: 'enabled', label: '启用账号', value: row.enabledCount, tone: row.enabledCount > 0 ? 'ok' : 'muted' },
              ...(row.disabledCount > 0 ? [{ key: 'disabled', label: '停用账号', value: row.disabledCount, tone: 'warn' as const }] : []),
              ...(row.manualCount > 0 ? [{ key: 'manual', label: '手动', value: row.manualCount, tone: 'info' as const }] : [])
            ]}
          />
          {row.accounts.length > 0 ? (
            <HudSection title="账号" code="ACCT" count={row.accounts.length}>
              <MonoList ariaLabel="承载该模型的账号">
                {row.accounts.map((account) => {
                  const enabled = account.model.enabled !== false;
                  return (
                    <SwipeRow
                      key={account.key}
                      ariaLabel={`${account.label} 的模型管理`}
                      onTap={() => {
                        onClose();
                        history.push(accountModelsPath(account.model.provider, account.key));
                      }}
                    >
                      <span className="mhud-row__icon"><ProviderIcon provider={account.model.provider} size={20} /></span>
                      <span className="mhud-row__main">
                        <span className="mhud-row__title">{account.label}</span>
                        <span className="mhud-row__meta">
                          {providerNames[account.model.provider] || account.model.provider}
                          {account.model.manual ? ' · 手动' : ''}
                          {account.model.defaultModel ? ' · 默认' : ''}
                        </span>
                      </span>
                      <span className="mhud-row__side">
                        <span className={`mhud-status ${enabled ? 'mhud-tone--ok' : 'mhud-tone--muted'}`}>
                          <span className={`hud-led ${enabled ? 'hud-led--ok' : 'hud-led--err'}`} aria-hidden="true" />
                          {enabled ? 'ON' : 'OFF'}
                        </span>
                      </span>
                      <RightOutlined className={styles.chevron} aria-hidden="true" />
                    </SwipeRow>
                  );
                })}
              </MonoList>
            </HudSection>
          ) : null}
        </div>
      ) : null}
    </DetailSheet>
  );
}
