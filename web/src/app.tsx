import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import { history } from "@umijs/max";
import { Alert } from "antd";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import MobileTabBar from "@/components/mobile/MobileTabBar";
import {
  FABRIC_SERVER_SETUP_HREF,
  FABRIC_SERVER_SETUP_TARGET,
  resolveFabricProfileGateState,
  shouldRedirectToFabricServerSetup,
} from "@/services/fabric-profile-gate";
import {
  initializeNativeControlPlaneProfiles,
  listControlPlaneProfiles,
} from "@/services/control-plane-profiles";
import {
  getActiveControlPlaneProfileId,
  setActiveControlPlaneProfileId,
} from "@/services/control-plane-selection";
import { isNativeDesktopRuntime } from "@/services/native-server-profile-repository";
import logo from "../../assets/brand/ai-home-app-icon.png";

function enforceNativeServerProfileGate() {
  if (!isNativeDesktopRuntime()) return;
  const gate = resolveFabricProfileGateState(
    listControlPlaneProfiles(),
    getActiveControlPlaneProfileId(),
  );
  if (shouldRedirectToFabricServerSetup(gate, history.location.pathname, history.location.search)) {
    history.replace(FABRIC_SERVER_SETUP_TARGET);
  }
}

export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
  desktopInitializationError?: string;
}> {
  let desktopInitializationError = "";
  if (isNativeDesktopRuntime()) {
    try {
      const native = await initializeNativeControlPlaneProfiles();
      setActiveControlPlaneProfileId(native.activeProfileId);
    } catch (error) {
      const source = error as { code?: unknown; message?: unknown };
      desktopInitializationError = String(
        source?.code || source?.message || "native_profile_initialization_failed"
      );
    }
  }
  return {
    settings: {
      layout: "side",
      navTheme: "light",
      colorPrimary: "#171717",
      contentWidth: "Fluid",
      fixedHeader: true,
      fixSiderbar: true,
    },
    desktopInitializationError,
  };
}

export const layout = ({ initialState }: any) => {
  return {
    logo,
    title: "AI Home",
    onPageChange: enforceNativeServerProfileGate,
    menuFooterRender: () => (
      <div style={{ padding: "8px 12px" }}>
        <ControlPlaneProfileSelect
          size="compact"
          manageHref={FABRIC_SERVER_SETUP_HREF}
          emptyLabel="添加 Server"
          manageLabel="配置服务器"
          onChange={() => {
            // 切换 server 后强制整页重载：所有数据页从新 server 重新取数，避免残留上一台的数据。
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      </div>
    ),
    // 移动端底部 TabBar：桌面隐藏、手机上承接跨页导航（见 mobile-shell.css）。
    // 挂在 children 之后，随各页内容一起铺，固定定位不参与布局流。
    childrenRender: (children: any) => (
      <>
        {initialState?.desktopInitializationError && (
          <Alert
            type="error"
            showIcon
            message="系统凭据存储不可用"
            description={`原生客户端无法访问系统 Keyring：${initialState.desktopInitializationError}`}
            style={{ margin: "12px 16px 0" }}
          />
        )}
        {children}
        <MobileTabBar />
      </>
    ),
    ...initialState?.settings,
  };
};
