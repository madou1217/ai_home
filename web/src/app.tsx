import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import { FABRIC_SERVER_SETUP_HREF } from "@/services/fabric-profile-gate";
import logo from "@/assets/brand/ai-home-logo.png";

export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
}> {
  return {
    settings: {
      layout: "side",
      navTheme: "light",
      colorPrimary: "#171717",
      contentWidth: "Fluid",
      fixedHeader: true,
      fixSiderbar: true,
    },
  };
}

export const layout = ({ initialState }: any) => {
  return {
    logo,
    title: "AIH",
    menuFooterRender: () => (
      <div style={{ padding: "8px 12px" }}>
        <ControlPlaneProfileSelect
          size="compact"
          manageHref={FABRIC_SERVER_SETUP_HREF}
          emptyLabel="配对服务器"
          manageLabel="配置服务器"
          onChange={() => {
            // 切换 server 后强制整页重载：所有数据页从新 server 重新取数，避免残留上一台的数据。
            if (typeof window !== "undefined") window.location.reload();
          }}
        />
      </div>
    ),
    ...initialState?.settings,
  };
};
