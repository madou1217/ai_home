import { Radio } from 'antd';

/**
 * kiro 「OAuth 登录」下的三种登录方式。
 *
 * 三种都是设备码授权，但**协议不同**（Builder ID 走 AWS SSO OIDC，Google / GitHub 走
 * Kiro social 设备流），因此必须由用户显式选择：没有默认项，选定之后点「确定」才去取
 * 授权链接。不要给它 initialValue —— 默认回落到 Builder ID 正是这次要修掉的旧行为。
 */
export type KiroLoginProvider = 'builder-id' | 'Google' | 'Github';

export const KIRO_LOGIN_METHODS: ReadonlyArray<{
  value: KiroLoginProvider;
  label: string;
  description: string;
}> = [
  { value: 'builder-id', label: 'Builder ID 登录', description: 'AWS Builder ID / IAM Identity Center' },
  { value: 'Google', label: '用 Google 登录', description: 'Kiro social 设备流' },
  { value: 'Github', label: '用 GitHub 登录', description: 'Kiro social 设备流' }
];

export function KiroLoginMethodChoice({
  value,
  disabled,
  onChange
}: {
  value?: KiroLoginProvider | '';
  disabled?: boolean;
  /** Form.Item 注入：只负责把选择写回表单；是否开始登录由「确定」按钮决定。 */
  onChange?: (value: KiroLoginProvider) => void;
}) {
  return (
    <Radio.Group
      className="aih-choice-tiles kiro-login-methods"
      value={value || ''}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value as KiroLoginProvider)}
    >
      <div className="kiro-login-methods-row">
        {KIRO_LOGIN_METHODS.map((method) => (
          <Radio key={method.value} value={method.value}>
            <span className="aih-choice-tile-title">{method.label}</span>
            <span className="aih-choice-tile-desc">{method.description}</span>
          </Radio>
        ))}
      </div>
    </Radio.Group>
  );
}
