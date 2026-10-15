import { useState } from 'react';
import { Button } from 'antd';
import { LoginOutlined } from '@ant-design/icons';
import { KiroNativeLoginModal } from '@/features/accounts/KiroNativeLoginModal';

interface KiroNativeLoginEntryProps {
  onAdded?: () => void | Promise<void>;
}

/**
 * 「Kiro 免 CLI 登录」入口：自带弹窗状态的自包含组件。
 *
 * **必须与「添加账号」同级无条件显示**：曾经按 `activeProvider === 'kiro'` 只在 Kiro 档渲染，
 * 结果停在默认「全部」档的用户完全看不到入口（实测反馈）。工具栏里的其它按钮也都是无条件的，
 * 所以这里跟随同一约定；按钮文案自带 Kiro 前缀，避免在别的档位上产生歧义。
 *
 * 刻意不把状态挂到页面的弹窗栈（useAccountActions / AccountFlowModals）里：这条链路只服务
 * kiro 的加账号，做成自包含组件后页面只需渲染一行，既不增长页面文件，也不与其它弹窗状态耦合。
 */
export function KiroNativeLoginEntry({ onAdded }: KiroNativeLoginEntryProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button key="kiro-native-login" icon={<LoginOutlined />} onClick={() => setOpen(true)}>
        Kiro 免 CLI 登录
      </Button>
      <KiroNativeLoginModal
        open={open}
        onClose={() => setOpen(false)}
        onAdded={onAdded}
      />
    </>
  );
}

export default KiroNativeLoginEntry;
