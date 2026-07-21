import { Input } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import Button from '@/components/ui/AppButton';

type OpenProjectDialogProps = {
  open: boolean;
  projectPath: string;
  projectName: string;
  onOpenChange: (open: boolean) => void;
  onPickDirectory: () => void;
  onProjectNameChange: (name: string) => void;
  onSubmit: () => Promise<void>;
};

export default function OpenProjectDialog({
  open,
  projectPath,
  projectName,
  onOpenChange,
  onPickDirectory,
  onProjectNameChange,
  onSubmit,
}: OpenProjectDialogProps) {
  return (
    <ModalForm
      title="打开项目"
      open={open}
      onOpenChange={onOpenChange}
      onFinish={async () => {
        await onSubmit();
        return true;
      }}
      submitter={{ searchConfig: { submitText: '打开', resetText: '取消' } }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
        <Button onClick={onPickDirectory}>选择文件夹</Button>
        <Input
          placeholder="不准手填，请点击选择文件夹按钮选择"
          value={projectPath}
          readOnly
          style={{ background: '#f5f5f5', color: '#595959' }}
        />
        <Input
          placeholder="项目名称（可选）"
          value={projectName}
          onChange={(event) => onProjectNameChange(event.target.value)}
        />
      </div>
    </ModalForm>
  );
}
