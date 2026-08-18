import { Alert, Button, Input, Modal, Segmented, Select } from 'antd';
import { PASTE_TEMPLATES } from '@/features/accounts/account-import-export';
import type { ImportMode, PasteTemplate } from '@/features/accounts/account-import-export';

interface ImportAccountsModalProps {
  open: boolean;
  importing: boolean;
  canSubmit: boolean;
  mode: ImportMode;
  fileName: string;
  pasteTemplate: PasteTemplate;
  importText: string;
  onModeChange: (mode: ImportMode) => void;
  onTemplateChange: (template: PasteTemplate) => void;
  onTextChange: (text: string) => void;
  onPickFile: () => void;
  onPickFolder: () => void;
  onFillTemplate: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function ImportAccountsModal({
  open,
  importing,
  canSubmit,
  mode,
  fileName,
  pasteTemplate,
  importText,
  onModeChange,
  onTemplateChange,
  onTextChange,
  onPickFile,
  onPickFolder,
  onFillTemplate,
  onSubmit,
  onCancel
}: ImportAccountsModalProps) {
  const activePasteTemplate = PASTE_TEMPLATES[pasteTemplate];
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Segmented
          value={mode}
          onChange={(value) => onModeChange(value as ImportMode)}
          options={[
            { label: '文件', value: 'file' },
            { label: '文件夹', value: 'folder' },
            { label: '粘贴', value: 'text' },
            { label: 'CLIProxyAPI', value: 'cliproxyapi' }
          ]}
        />
        {mode === 'file' ? (
          <Alert
            type={fileName ? 'success' : 'info'}
            showIcon
            message={fileName ? `已选择 ${fileName}` : '选择 JSON / JSONL / ZIP 文件'}
            description="支持迁移 JSON、Antigravity Manager、JSONL 和 zip 导入包。"
            action={
              <Button size="small" onClick={onPickFile}>
                {fileName ? '重新选择' : '选择文件'}
              </Button>
            }
          />
        ) : null}
        {mode === 'folder' ? (
          <Alert
            type={fileName ? 'success' : 'info'}
            showIcon
            message={fileName ? `已选择 ${fileName}` : '选择账号文件夹'}
            description="支持包含 provider 目录、账号目录、JSON 文件或嵌套 ZIP 的文件夹，上传后由统一导入器自动发现。"
            action={
              <Button size="small" onClick={onPickFolder}>
                {fileName ? '重新选择' : '选择文件夹'}
              </Button>
            }
          />
        ) : null}
        {mode === 'text' ? (
          <div className="accounts-import-paste">
            <Select
              value={pasteTemplate}
              onChange={(value) => onTemplateChange(value as PasteTemplate)}
              options={Object.entries(PASTE_TEMPLATES).map(([value, template]) => ({
                value,
                label: template.label
              }))}
            />
            <Alert
              type="info"
              showIcon
              message={activePasteTemplate.label}
              description={activePasteTemplate.description}
              action={
                <Button size="small" onClick={onFillTemplate}>
                  填入模板
                </Button>
              }
            />
            <div className="accounts-import-template">
              <div>格式模板</div>
              <pre>{activePasteTemplate.value}</pre>
            </div>
            <Input.TextArea
              rows={8}
              placeholder="粘贴真实 JSON / JSONL 数据，或先填入模板再替换占位凭据"
              value={importText}
              onChange={(e) => onTextChange(e.target.value)}
            />
          </div>
        ) : null}
        {mode === 'cliproxyapi' ? (
          <Alert
            type="info"
            showIcon
            message="从 CLIProxyAPI 配置导入"
            description="读取本机 CLIProxyAPI 配置和账号凭据，导入到 AI Home 账号池；无需上传文件。"
          />
        ) : null}
      </div>
    </Modal>
  );
}