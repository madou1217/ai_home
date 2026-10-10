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
      confirmLoading={submitting}
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
        }
      }}
    >
      <UpstreamErrorRulesEditor provider={account?.provider} />
      <Form.Item name="clearErrorBlock" valuePropName="checked" style={{ marginTop: 16 }}>
        <Checkbox>余额或权限已恢复，手动清除账号异常阻塞</Checkbox>
      </Form.Item>
    </ModalForm>
  );
}
