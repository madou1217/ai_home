import React from "react";
import type { Settings as LayoutSettings } from "@ant-design/pro-components";
import ControlPlaneProfileSelect from "@/components/control-plane/ControlPlaneProfileSelect";
import { FABRIC_SERVER_SETUP_HREF } from "@/services/fabric-profile-gate";
import logo from "@/assets/brand/ai-home-mark.png";

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
          label="Server"
          size="compact"
          manageHref={FABRIC_SERVER_SETUP_HREF}
          emptyLabel="配置"
          manageLabel="配置"
          showSummary
        />
      </div>
    ),
    ...initialState?.settings,
  };
};
