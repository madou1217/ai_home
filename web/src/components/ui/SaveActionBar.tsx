import { memo, type CSSProperties, type ReactNode } from 'react';
import { SaveOutlined } from '@ant-design/icons';
import Button from './AppButton';
import SettingStatusTag, { type SettingStatusState } from './SettingStatusTag';
import './SaveActionBar.css';

export interface SaveActionBarProps {
  /** 是否存在未保存变更；clean 时自动禁用保存按钮 */
  dirty: boolean;
  /** 保存中状态 */
  saving?: boolean;
  /** 外部额外禁用条件（如加载中、表单校验未通过） */
  disabled?: boolean;
  /** 保存触发回调；若用于 Form submit 可传 htmlType="submit" 并省略 onSave */
  onSave?: () => void;
  /** 放弃当前未保存更改（恢复到已持久化值） */
  onReset?: () => void;
  /** 按钮提交类型：button（默认）或 submit */
  htmlType?: 'button' | 'submit';
  /** 主保存按钮文案（默认：dirty 时“保存更改”，clean 时“已保存”） */
  saveLabel?: string;
  /** clean 时的按钮文案，避免“未改也能保存”的错觉 */
  cleanSaveLabel?: string;
  /** 重置按钮文案（默认“放弃修改”） */
  resetLabel?: string;
  /** 状态标签：不传时自动按 saving / error / dirty 推断 */
  status?: SettingStatusState;
  /** 状态标签覆盖文案 */
  statusLabel?: ReactNode;
  /** 明确说明点击保存后会发生什么（如“保存后立即生效”或“保存后需重启生效”） */
  effectSummary: string;
  /** 靠近控件的反馈文案（如最近一次保存成功或错误原因） */
  feedback?: ReactNode;
  /** 反馈语义 */
  feedbackTone?: 'muted' | 'success' | 'error';
  /** 附加操作（例如“清除代理”“一键重启服务”） */
  extraActions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * 统一保存操作栏：
 * - clean 时禁用保存按钮并明确显示已同步状态；
 * - 显式展示生效预期（立即生效 / 需重启 / 下一轮生效）；
 * - 在控件旁就近展示保存成功或失败反馈，不依赖转瞬即逝的 toast。
 */
export const SaveActionBar = memo(function SaveActionBar({
  dirty,
  saving = false,
  disabled = false,
  onSave,
  onReset,
  htmlType = 'button',
  saveLabel = '保存更改',
  cleanSaveLabel = '已保存',
  resetLabel = '放弃修改',
  status,
  statusLabel,
  effectSummary,
  feedback,
  feedbackTone = 'muted',
  extraActions,
  className,
  style
}: SaveActionBarProps) {
  const resolvedStatus: SettingStatusState = status ?? (
    saving
      ? 'saving'
      : feedbackTone === 'error'
        ? 'error'
        : dirty
          ? 'dirty'
          : 'saved'
  );
  const saveDisabled = disabled || saving || !dirty;
  const buttonText = saving ? '保存中…' : dirty ? saveLabel : cleanSaveLabel;

  return (
    <div
      className={['hos-save-action-bar', className].filter(Boolean).join(' ')}
      style={style}
    >
      <div className="hos-save-action-bar-info">
        <div className="hos-save-action-bar-status-row">
          <SettingStatusTag status={resolvedStatus} label={statusLabel} compact />
          <span className="hos-save-action-bar-effect">{effectSummary}</span>
        </div>
        {feedback ? (
          <div
            className={`hos-save-action-bar-feedback hos-save-action-bar-feedback--${feedbackTone}`}
            role={feedbackTone === 'error' ? 'alert' : 'status'}
            aria-live={feedbackTone === 'error' ? 'assertive' : 'polite'}
          >
            {feedback}
          </div>
        ) : null}
      </div>

      <div className="hos-save-action-bar-actions">
        {extraActions}
        {onReset && dirty ? (
          <Button disabled={saving} onClick={onReset} disableDebounce>
            {resetLabel}
          </Button>
        ) : null}
        <Button
          type="primary"
          htmlType={htmlType}
          icon={<SaveOutlined />}
          disabled={saveDisabled}
          loading={saving}
          onClick={htmlType === 'submit' ? undefined : onSave}
        >
          {buttonText}
        </Button>
      </div>
    </div>
  );
});

export default SaveActionBar;
