import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import type { ReactNode } from "react";
import { history } from "@umijs/max";
import { Alert } from "antd";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import AppErrorBoundary from "@/components/ui/AppErrorBoundary";
import AntdThemeProvider from "@/components/theme/AntdThemeProvider";
import MobileTabBar from "@/components/mobile/MobileTabBar";
import AppInstallTaskQueue from "@/components/task-queue/AppInstallTaskQueue";
import HudEffects from "@/components/hud/HudEffects";
import { HudBrand, HudTelemetryBar, HudToggles } from "@/components/hud/HudHeader";
import { resolveHudNavCode } from "@/components/hud/hud-nav";
// Cyber HUD 字体随包分发（不依赖外网 CDN）：JetBrains Mono 数据字体 + Orbitron 展示字体。
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "@fontsource/orbitron/500.css";
import "@fontsource/orbitron/700.css";
import "@fontsource/orbitron/900.css";
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

// ProLayout 的外壳 token 直接写 CSS 变量：它们只进入 CSS 值、不参与 antd 的派生计算，
// 因此能随 data-theme 运行时翻转，与 design-tokens.css 保持同一来源（见 web/DESIGN.md §7）。
const LAYOUT_TOKEN = {
  bgLayout: "transparent",
  colorTextAppListIcon: "var(--color-muted)",
  sider: {
    colorMenuBackground: "var(--color-surface)",
    colorMenuItemDivider: "var(--color-border)",
    colorTextMenu: "var(--color-muted-strong)",
    colorTextMenuSecondary: "var(--color-muted)",
    colorTextMenuSelected: "var(--color-heading)",
    colorTextMenuActive: "var(--color-heading)",
    colorTextMenuItemHover: "var(--color-heading)",
    colorTextMenuTitle: "var(--color-heading)",
    colorBgMenuItemHover: "var(--color-overlay)",
    colorBgMenuItemSelected: "var(--color-surface-muted)",
    colorBgMenuItemCollapsedElevated: "var(--color-surface-raised)",
    colorTextCollapsedButton: "var(--color-muted)",
    colorTextCollapsedButtonHover: "var(--color-heading)",
    colorBgCollapsedButton: "var(--color-surface)",
  },
  header: {
    heightLayoutHeader: 60,
    colorBgHeader: "var(--hud-panel-bg)",
    colorHeaderTitle: "var(--color-heading)",
    colorBgMenuItemHover: "var(--color-overlay)",
    colorTextRightActionsItem: "var(--color-muted)",
  },
  pageContainer: {
    colorBgPageContainer: "transparent",
  },
};

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
      // mix：通栏 HUD 顶栏（品牌 / 实时遥测 / CRT·音效开关）+ 左侧编号导航。
      layout: "mix",
      splitMenus: false,
      navTheme: "light",
      // 不在这里定义强调色：ProLayout 会用它再包一层 ConfigProvider，
      // 盖掉 AntdThemeProvider 的主题化取值（深色下激活 Tab 会变成近黑压深底）。
      // 强调色的唯一来源是 src/theme/antd-theme.ts。
      contentWidth: "Fluid",
      fixedHeader: true,
      fixSiderbar: true,
      siderWidth: 248,
    },
    desktopInitializationError,
  };
}

// antd 的 token 体系必须整体跟随 data-theme，否则深色模式下按钮描边、次级文字、
// 下拉项等仍取构建期的浅色值。包在最外层，让所有路由与 Layout 共用同一主题上下文。
export function rootContainer(container: ReactNode) {
  return (
    <AntdThemeProvider>
      {container}
      {/* CRT 扫描线 + Web Audio 微反馈：全局一次挂载，含 Server 配置页 */}
      <HudEffects />
    </AntdThemeProvider>
  );
}

// 侧栏菜单项：保留 ProLayout 默认渲染（链接 / 图标 / 中文名），在前后补 HUD 编号与英文代号。
function renderHudMenuLabel(item: { path?: string }, dom: ReactNode) {
  const code = resolveHudNavCode(item.path);
  if (!code) return dom;
  return (
    <span className="hud-nav-item">
      {code.no ? <span className="hud-nav-no">{code.no}</span> : null}
      <span className="hud-nav-dom">{dom}</span>
      <span className="hud-nav-code">{code.code}</span>
    </span>
  );
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
    token: LAYOUT_TOKEN,
    headerTitleRender: () => <HudBrand logo={logo} />,
    headerContentRender: () => (
      <HudTelemetryBar enabled={!isGoAccountsPreview && resolveCurrentServerProfileGate().ready} />
    ),
    actionsRender: () => [<HudToggles key="hud-toggles" />],
    menuItemRender: (item: { path?: string }, dom: ReactNode) => renderHudMenuLabel(item, dom),
    subMenuItemRender: (item: { path?: string }, dom: ReactNode) => renderHudMenuLabel(item, dom),
    onPageChange: enforceServerProfileGate,
    menuDataRender: (menuData: any[]) => (
      // 与 workspace gate 同一判定：菜单只依赖 setup 完整性（configured），
      // 不随运行期健康快照（ready）抖动而隐藏。
      isGoAccountsPreview || resolveCurrentServerProfileGate().configured ? menuData : []
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
