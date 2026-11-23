import { useEffect, useState } from 'react';
import { InputNumber } from 'antd';
import Button from '@/components/ui/AppButton';
import SettingSection, { SettingRow } from '@/components/ui/SettingSection';
import SettingStatusTag, { type SettingStatusState } from '@/components/ui/SettingStatusTag';
import SaveActionBar from '@/components/ui/SaveActionBar';
import { useLargePasteSettings } from './use-large-paste-settings';

interface PasteSaveFeedback {
  tone: 'success' | 'error';
  text: string;
}

/**
 * 设置页「会话输入」：大段粘贴自动转文本附件的阈值。
 * 修改的是当前 Server 的配置，与 `aih server config set --large-paste-chars <n>` 同步。
 */
export default function LargePasteSettingCard() {
  const { value, custom, saving, save, limits } = useLargePasteSettings();
  const [draft, setDraft] = useState<number | null>(value);
  const [feedback, setFeedback] = useState<PasteSaveFeedback | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const dirty = draft !== null && draft !== value;
  const status: SettingStatusState = saving
    ? 'saving'
    : feedback?.tone === 'error'
      ? 'error'
      : dirty
        ? 'dirty'
        : 'applied';

  const apply = async (next: number | null) => {
    setFeedback(null);
    try {
      const settings = await save(next);
      setFeedback({
        tone: 'success',
        text: next === null
          ? `已恢复默认（${settings.largePasteChars} 字）并生效`
          : `已应用：超过 ${settings.largePasteChars} 字自动转为附件`
      });
    } catch (error: unknown) {
      const data = typeof error === 'object' && error
        ? (error as { response?: { data?: { message?: string } } }).response?.data
        : undefined;
      setFeedback({
        tone: 'error',
        text: data?.message || '保存阈值失败'
      });
    }
  };

  return (
    <SettingSection
      title="会话输入"
      description="长文本粘贴超过阈值后自动转为文本附件。"
      status={<SettingStatusTag status={status} compact />}
      footer={
        <SaveActionBar
          dirty={dirty}
          saving={saving}
          onSave={() => { if (draft !== null) void apply(draft); }}
          onReset={() => {
            setDraft(value);
            setFeedback(null);
          }}
          status={status}
          saveLabel="保存阈值"
          cleanSaveLabel="已应用"
          effectSummary="保存后立即作用于当前 Server 的所有会话输入框"
          feedback={feedback?.text}
          feedbackTone={feedback?.tone ?? 'muted'}
          extraActions={
            custom ? (
              <Button disabled={saving} onClick={() => void apply(null)}>
                恢复默认
              </Button>
            ) : null
          }
        />
      }
    >
      <SettingRow
        title="粘贴转附件阈值"
        htmlFor="large-paste-chars"
        description={`达到设定字数时自动生成文本附件，范围 ${limits.min}–${limits.max} 字。`}
        persistedValue={`已应用：${value} 字${custom ? '（自定义）' : '（默认）'}`}
        caveat="等价 CLI：aih server config set --large-paste-chars <n>"
        control={
          <InputNumber
            id="large-paste-chars"
            aria-label="粘贴转附件阈值（字）"
            min={limits.min}
            max={limits.max}
            step={10}
            precision={0}
            value={draft}
            addonAfter="字"
            style={{ width: 156 }}
            onChange={(next) => {
              setDraft(typeof next === 'number' ? next : null);
              if (feedback) setFeedback(null);
            }}
            onPressEnter={() => { if (dirty && draft !== null) void apply(draft); }}
          />
        }
      />
    </SettingSection>
  );
}
