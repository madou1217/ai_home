import { Checkbox, Form } from 'antd';
import { ModalForm } from '@ant-design/pro-components';
import type { Account } from '@/types';
import { UpstreamErrorRulesEditor } from './UpstreamErrorRulesEditor';

interface AccountRoutingRulesModalProps {
  account: Account | null;
  form: ReturnType<typeof Form.useForm>[0];
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => Promise<boolean>;
}

/** 只编辑调度元数据，凭据和 OAuth 生命周期由账号编辑/重新登录流程负责。 */
export function AccountRoutingRulesModal({
  account,
  form,
  submitting,
  onClose,
  onSubmit
}: AccountRoutingRulesModalProps) {
  return (
    <ModalForm
      title="编辑调度规则"
      open={Boolean(account)}
      form={form}
      layout="vertical"
      width={960}
      onOpenChange={(visible) => {
        if (!visible) {
          onClose();
          form.resetFields();
        }
      }}
      onFinish={onSubmit}
      submitter={{
        searchConfig: {
          submitText: '保存',
          resetText: '取消'
        },
        // ModalForm 没有 confirmLoading（那是 antd Modal 的属性，传进来被静默忽略，保存时按钮从不转圈）。
        submitButtonProps: { loading: submitting }
      }}
    >
      <UpstreamErrorRulesEditor provider={account?.provider} />
      <Form.Item name="clearErrorBlock" valuePropName="checked" style={{ marginTop: 16 }}>
        <Checkbox>余额或权限已恢复，手动清除账号异常阻塞</Checkbox>
      </Form.Item>
    </ModalForm>
  );
}
