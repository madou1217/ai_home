import { Input, Modal, Segmented } from 'antd';
import Button from '@/components/ui/AppButton';
import InlineNote from '@/components/ui/InlineNote';
import type { ImportMode } from './account-import-export';

interface ImportAccountsModalProps {
  open: boolean;
  importing: boolean;
  canSubmit: boolean;
  mode: ImportMode;
  fileName: string;
  importText: string;
  onModeChange: (mode: ImportMode) => void;
  onPickFile: () => void;
  onTextChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/**
 * 导入账号：只接受 aih 自己导出的账号文件（WebUI「导出」或 `aih export` 生成），
 * 同一身份更新原账号、新身份新增，重复导入不会多出账号。
 */
export function ImportAccountsModal({
  open,
  importing,
  canSubmit,
  mode,
  fileName,
  importText,
  onModeChange,
  onPickFile,
  onTextChange,
  onSubmit,
  onCancel
}: ImportAccountsModalProps) {
  return (
    <Modal
      title="导入账号"
      open={open}
      onOk={onSubmit}
      onCancel={onCancel}
      okText="导入"
      cancelText="取消"
      confirmLoading={importing}
      okButtonProps={{ disabled: !canSubmit }}
    >
      <div className="aih-overlay-stack">
        <Segmented
          value={mode}
          onChange={(value) => onModeChange(value as ImportMode)}
          options={[
            { label: '文件', value: 'file' },
            { label: '粘贴', value: 'text' }
          ]}
        />
        {mode === 'file' ? (
          <InlineNote
            key="file"
            className="aih-fade-in"
            tone={fileName ? 'success' : 'info'}
            description="选择 aih 导出的账号文件（可多选）。已有的账号会更新凭据，不会重复添加。"
            action={
              <Button size="small" onClick={onPickFile}>
                {fileName ? '重新选择' : '选择文件'}
              </Button>
            }
          >
            {fileName ? `已选择 ${fileName}` : '选择 .json 账号文件'}
          </InlineNote>
        ) : null}
        {mode === 'text' ? (
          <div key="text" className="accounts-import-paste aih-fade-in">
            <InlineNote tone="info" description="粘贴导出文件的完整内容，或单个账号的 JSON。">
              粘贴 aih 账号 JSON
            </InlineNote>
            <Input.TextArea
              id="account-import-text"
              rows={10}
              placeholder={'{\n  "kind": "aih-accounts",\n  "version": 1,\n  "accounts": [ … ]\n}'}
              value={importText}
              onChange={(e) => onTextChange(e.target.value)}
            />
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
