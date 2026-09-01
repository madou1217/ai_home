import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import { history } from "@umijs/max";
import { Alert } from "antd";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import AppErrorBoundary from "@/components/ui/AppErrorBoundary";
import MobileTabBar from "@/components/mobile/MobileTabBar";
import AppInstallTaskQueue from "@/components/task-queue/AppInstallTaskQueue";
import {
  FABRIC_SERVER_SETUP_HREF,
  FABRIC_SERVER_SETUP_TARGET,
  canRenderFabricWorkspace,
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
import {
  buildServerScopedSearch,
  getExplicitServerProfileId,
} from "@/services/server-selection-scope";
import { resolveAppRoutePathname } from "@/services/app-navigation";
import { isNativeDesktopRuntime } from "@/services/native-server-profile-repository";
import { startNativeRelayDiscovery } from "@/services/server-routes/native-relay-discovery";
import { startNativeLanRouteRefresh } from "@/services/server-routes/native-lan-route-refresh";
import { DynamicWallpaperEngine } from "@/services/dynamic-wallpaper-engine";
import logo from "../../assets/brand/ai-home-app-icon.png";

// Go 账号 Preview 使用独立的管理端口，不依赖正式 Node Server profile。
// 该开关只由 scripts/go-accounts-preview.js 注入，正式 Web 构建保持原有门禁。
const isGoAccountsPreview = process.env.AIH_GO_ACCOUNTS_PREVIEW === "1";

function resolveCurrentServerProfileGate() {
  return resolveFabricProfileGateState(
    listControlPlaneProfiles(),
    getActiveControlPlaneProfileId(),
  );
}

function enforceServerProfileGate() {
  if (isGoAccountsPreview) return;
  const explicitProfileId = getExplicitServerProfileId();
  if (explicitProfileId) {
    const scopedSearch = buildServerScopedSearch(history.location.search, explicitProfileId);
    if (scopedSearch !== history.location.search) {
      history.replace({
        // Umi history expects an app-relative pathname. Passing the browser
        // pathname (`/ui/...`) makes it prepend `base` again as `/ui/ui/...`.
        pathname: resolveAppRoutePathname(history.location.pathname),
        search: scopedSearch,
      });
      return;
    }
  }
  const gate = resolveCurrentServerProfileGate();
  if (shouldRedirectToFabricServerSetup(gate, history.location.pathname, history.location.search)) {
    history.replace({
      pathname: FABRIC_SERVER_SETUP_TARGET,
      search: explicitProfileId
        ? buildServerScopedSearch('', explicitProfileId)
        : '',
    });
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
      startNativeRelayDiscovery({ profiles: native.profiles });
      startNativeLanRouteRefresh();
    } catch (error) {
      const source = error as { code?: unknown; message?: unknown };
      desktopInitializationError = String(
        source?.code || source?.message || "native_profile_initialization_failed"
      );
    }
  }
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/ui/sw.js').catch(() => {});
    });
  }
  // 启动时恢复用户保存的动态壁纸（含色彩萃取的强调色光晕），无保存记录时静默跳过。
  const savedWallpaper = DynamicWallpaperEngine.getSavedWallpaper();
  if (savedWallpaper) DynamicWallpaperEngine.applyWallpaper(savedWallpaper);
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
  if (isGoAccountsPreview) {
    return {
      logo,
      title: "AI Home Go 账号 Preview",
      menuDataRender: (menuData: any[]) => menuData,
      childrenRender: (children: any) => children,
      ...initialState?.settings,
    };
  }
  return {
    logo,
    title: "AI Home",
    onPageChange: enforceServerProfileGate,
    menuDataRender: (menuData: any[]) => (
      isGoAccountsPreview || resolveCurrentServerProfileGate().ready ? menuData : []
    ),
    menuFooterRender: () => isGoAccountsPreview ? null : (
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
    childrenRender: (children: any) => {
      const profileGate = resolveCurrentServerProfileGate();
      const canRenderWorkspace = isGoAccountsPreview || canRenderFabricWorkspace(
        profileGate,
        history.location.pathname,
        history.location.search,
      );
      const canRenderDataPlane = isGoAccountsPreview || profileGate.ready;
      return (
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
          {/* 页面级渲染兜底：单页 render 抛错不再整树卸载成白屏 */}
          <AppErrorBoundary>
            {canRenderWorkspace ? children : null}
          </AppErrorBoundary>
          {canRenderDataPlane && <AppInstallTaskQueue />}
          {canRenderDataPlane && <MobileTabBar />}
        </>
      );
    },
    ...initialState?.settings,
  };
};
