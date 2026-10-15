import { useState } from 'react';
import { Button } from 'antd';
import { LoginOutlined } from '@ant-design/icons';
import { KiroNativeLoginModal } from '@/features/accounts/KiroNativeLoginModal';

interface KiroNativeLoginEntryProps {
  /** 只在 Kiro 这一档显示，避免在其它 provider 的页面里制造噪声入口。 */
  activeProvider: string;
  onAdded?: () => void | Promise<void>;
}

/**
 * 「Kiro 免 CLI 登录」入口：自带弹窗状态的自包含组件。
 *
 * 刻意不把状态挂到页面的弹窗栈（useAccountActions / AccountFlowModals）里：
 * 这条链路只服务 kiro 的加账号，把它做成自包含组件后页面只需渲染一行，
 * 既不增长页面文件，也不与其它弹窗的状态耦合。
 */
export function KiroNativeLoginEntry({ activeProvider, onAdded }: KiroNativeLoginEntryProps) {
  const [open, setOpen] = useState(false);
  if (activeProvider !== 'kiro') return null;
  return (
    <>
      <Button key="kiro-native-login" icon={<LoginOutlined />} onClick={() => setOpen(true)}>
        免 CLI 登录
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
