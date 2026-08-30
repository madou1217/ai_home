import { defineConfig } from "@umijs/max";
import MonacoEditorWebpackPlugin from "monaco-editor-webpack-plugin";
import routes from "./routes";

const isDesktopBuild = process.env.AIH_DESKTOP_BUILD === "1";
const isDesktopProductionBuild = isDesktopBuild && process.env.NODE_ENV === "production";
const isGoAccountsPreview = process.env.AIH_GO_ACCOUNTS_PREVIEW === "1";
const goAccountsPreviewManagementKey = process.env.AIH_GO_ACCOUNTS_PREVIEW_MANAGEMENT_KEY;
const publicPath = isDesktopProductionBuild ? "./" : (isDesktopBuild ? "/" : "/ui/");

if (isGoAccountsPreview && !goAccountsPreviewManagementKey) {
  throw new Error("Go 账号 preview 缺少独立 Management Key");
}

export default defineConfig({
  // 将 Preview 标志显式注入应用代码；正式构建注入空值，不改变 Node WebUI。
  define: {
    "process.env.AIH_GO_ACCOUNTS_PREVIEW": JSON.stringify(process.env.AIH_GO_ACCOUNTS_PREVIEW || ""),
  },
  // 全面融入 HarmonyOS 6 (ArkUI) 设计系统规范：深空/通透亚克力、超级曲率与流光强调色
  antd: {
    theme: {
      token: {
        colorPrimary: "#0a59f7",
        colorInfo: "#0a59f7",
        colorSuccess: "#10b981",
        colorWarning: "#f59e0b",
        colorError: "#ef4444",
        borderRadius: 12,
        borderRadiusLG: 20,
        borderRadiusSM: 8,
        borderRadiusXS: 6,
        colorBorderSecondary: "rgba(0, 0, 0, 0.06)",
        fontFamily: "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif",
      },
      components: {
        Table: {
          headerBg: "rgba(241, 245, 249, 0.65)",
          headerColor: "#1e293b",
          headerSplitColor: "transparent",
          rowHoverBg: "rgba(10, 89, 247, 0.04)",
          borderRadius: 16,
        },
        Card: {
          borderRadiusLG: 20,
          colorBgContainer: "rgba(255, 255, 255, 0.85)",
          colorBorderSecondary: "rgba(255, 255, 255, 0.9)",
        },
        Button: {
          borderRadius: 9999,
          borderRadiusLG: 9999,
          borderRadiusSM: 9999,
          controlHeight: 36,
          controlHeightLG: 42,
          controlHeightSM: 28,
        },
        Select: {
          borderRadius: 14,
          borderRadiusLG: 18,
          borderRadiusSM: 10,
        },
        Input: {
          borderRadius: 14,
          borderRadiusLG: 18,
          borderRadiusSM: 10,
        },
        Modal: {
          borderRadiusLG: 24,
          contentBg: "rgba(255, 255, 255, 0.92)",
          headerBg: "transparent",
        },
        Drawer: {
          colorBgElevated: "rgba(255, 255, 255, 0.92)",
        },
        Segmented: {
          borderRadius: 9999,
          borderRadiusSM: 9999,
          trackBg: "rgba(0, 0, 0, 0.04)",
          itemSelectedBg: "#ffffff",
        },
      },
    },
  },
  access: {},
  model: {},
  initialState: {},
  request: {},
  proxy: isGoAccountsPreview
    ? {
        "/v1/management": {
          target: "http://127.0.0.1:19527",
          changeOrigin: true,
          headers: {
            authorization: `Bearer ${goAccountsPreviewManagementKey}`,
          },
        },
      }
    : {
        "/v0": {
          target: "http://127.0.0.1:9527",
          changeOrigin: true,
          ws: true
        }
      },
  // Desktop dev 会导入 web/ 外部的共享 CommonJS provider catalog；React Refresh
  // 会把它改写成 ESM，随后又按 CommonJS 解析，因此桌面开发态只关闭 Fast Refresh。
  fastRefresh: !isDesktopBuild,
  esbuildMinifyIIFE: true,
  // xterm 6 的 ESM 产物（lib/xterm.mjs）在 webpack scope-hoisting 下会把内部
  // 循环 class 继承的基类重排为 null，运行时抛 "Super constructor null"。
  // 强制解析到自包含的 CJS UMD 产物（对 concatenation 不透明），规避该 bug。
  chainWebpack(memo: any) {
    memo.resolve.alias.set(
      '@xterm/xterm$',
      require.resolve('@xterm/xterm/lib/xterm.js')
    );
    memo.plugin('monaco-editor').use(MonacoEditorWebpackPlugin, [{
      languages: ['json'],
      features: [
        'bracketMatching',
        'clipboard',
        'codeEditor',
        'codicon',
        'comment',
        'contextmenu',
        'find',
        'folding',
        'gotoError',
        'gotoLine',
        'hover',
        'indentation',
        'lineSelection',
        'linesOperations',
        'multicursor',
        'placeholderText',
        'tokenization',
        'wordOperations'
      ],
      filename: 'static/[name].[contenthash:8].worker.js'
    }]);
  },
  layout: {
    title: "AI Home",
    locale: true,
  },
  favicons: [`${publicPath}ai-home-logo.png`],
  routes,
  npmClient: "npm",
  history: {
    // Packaged Tauri apps cannot rely on an HTTP server to resolve deep links.
    type: isDesktopBuild ? "hash" : "browser",
  },
  publicPath,
  base: isDesktopBuild ? "/" : "/ui",
  outputPath: "dist",
  hash: true,
  targets: {
    chrome: 80,
    firefox: 80,
    safari: 13,
    edge: 80,
  }
});
