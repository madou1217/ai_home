import { useEffect, useState } from 'react';
import { InputNumber, message } from 'antd';
import Button from '@/components/ui/AppButton';
import SettingsGroupCard, { SettingsItem } from '@/components/settings/SettingsGroupCard';
import { useLargePasteSettings } from './use-large-paste-settings';

/**
 * 设置页「会话输入」：大段粘贴自动转文本附件的阈值。
 * 改的是当前 Server 的配置，和 `aih server config set --large-paste-chars <n>` 是同一个值。
 */
export default function LargePasteSettingCard() {
  const { value, custom, saving, save, limits } = useLargePasteSettings();
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== null && draft !== value;

  const apply = async (next: number | null) => {
    try {
      const settings = await save(next);
      message.success(next === null
        ? `已恢复默认：粘贴 ${settings.largePasteChars} 字以上转为附件`
        : `已保存：粘贴 ${settings.largePasteChars} 字以上转为附件`);
    } catch (error: unknown) {
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string } } }).response?.data : undefined;
      message.error(data?.message || '保存失败');
    }
  };

  return (
    <SettingsGroupCard
      title="会话输入"
      description="粘贴的文字超过阈值时，自动变成文本附件（显示预览和文件路径），不再整段塞进输入框。"
    >
      <SettingsItem
        title="大段粘贴转附件阈值"
        subtitle={`当前 ${value} 字${custom ? '' : '（默认）'}。最小 ${limits.min}，CLI：aih server config set --large-paste-chars <n>`}
        action={(
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <InputNumber
              id="large-paste-chars"
              aria-label="大段粘贴转附件阈值（字）"
              min={limits.min}
              max={limits.max}
              step={10}
              precision={0}
              value={draft}
              addonAfter="字"
              style={{ width: 150 }}
              onChange={(next) => setDraft(typeof next === 'number' ? next : null)}
              onPressEnter={() => { if (dirty && draft !== null) void apply(draft); }}
            />
            <Button type="primary" disabled={!dirty} loading={saving} onClick={() => draft !== null && void apply(draft)}>
              保存
            </Button>
            {custom ? (
              <Button disabled={saving} onClick={() => void apply(null)}>恢复默认</Button>
            ) : null}
          </div>
        )}
      />
    </SettingsGroupCard>
  );
}
