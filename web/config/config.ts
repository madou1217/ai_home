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
