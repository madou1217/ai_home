import { defineConfig } from "@umijs/max";
import routes from "./routes";

export default defineConfig({
  // antd 主题集中在框架 ConfigProvider（少写自定义 CSS）：颜色/表格视觉走 token，
  // 替代 unified.css 里对 .ant-table 的 !important 覆盖。
  antd: {
    theme: {
      token: {
        colorPrimary: "#171717",
        colorInfo: "#2563eb",
        borderRadius: 8,
        borderRadiusLG: 12,
        colorBorderSecondary: "#e2e8f0",
      },
      components: {
        Table: {
          headerBg: "#f1f5f9",
          headerColor: "#171717",
          headerSplitColor: "transparent",
          rowHoverBg: "rgba(37, 99, 235, 0.05)",
        },
        Card: {
          // ProCard 圆角/边框走 token，扁平阴影靠 unified.css 单条非 !important 规则补
          borderRadiusLG: 12,
        },
        // 分页器用 antd 默认（活动项=黑描边，由全局 colorPrimary #171717 驱动）。
        // 不再用 itemActiveBg 深填充 + colorPrimary 白字——后者会被 antd 派生为
        // hover/跳页器文字白色，导致白底白字。框架默认更稳。
      },
    },
  },
  access: {},
  model: {},
  initialState: {},
  request: {},
  proxy: {
    "/v0": {
      target: "http://127.0.0.1:9527",
      changeOrigin: true,
      ws: true
    }
  },
  esbuildMinifyIIFE: true,
  layout: {
    title: "AIH Local Orchestrator",
    locale: true,
  },
  routes,
  npmClient: "npm",
  history: {
    type: "browser",
  },
  publicPath: "/ui/",
  base: "/ui",
  outputPath: "dist",
  hash: true,
  targets: {
    chrome: 80,
    firefox: 80,
    safari: 13,
    edge: 80,
  }
});
