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
  // Calm Operator Console（见 web/DESIGN.md）：这里只放与主题无关的结构型 token
  // （圆角、字体、控件高度）；会随深浅翻转的颜色在 src/theme/antd-theme.ts，
  // 由 AntdThemeProvider 运行时注入。取值与 src/styles/design-tokens.css 对齐。
  antd: {
    theme: {
      token: {
        borderRadius: 6,
        borderRadiusLG: 10,
        borderRadiusSM: 4,
        borderRadiusXS: 4,
        controlHeight: 32,
        controlHeightLG: 40,
        controlHeightSM: 24,
        fontSize: 14,
        fontFamily: "Inter, 'HarmonyOS Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
        fontFamilyCode: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
        motionDurationFast: "0.12s",
        motionDurationMid: "0.16s",
        motionDurationSlow: "0.24s",
        wireframe: false,
      },
      components: {
        Table: {
          headerSplitColor: "transparent",
          borderRadius: 10,
          cellPaddingBlock: 12,
          cellPaddingInline: 12,
        },
        Card: {
          borderRadiusLG: 10,
        },
        Button: {
          borderRadius: 6,
          borderRadiusLG: 8,
          borderRadiusSM: 4,
          fontWeight: 500,
          primaryShadow: "none",
          defaultShadow: "none",
          dangerShadow: "none",
        },
        Select: {
          borderRadius: 6,
          borderRadiusLG: 8,
          borderRadiusSM: 4,
        },
        Input: {
          borderRadius: 6,
          borderRadiusLG: 8,
          borderRadiusSM: 4,
        },
        Modal: {
          borderRadiusLG: 12,
          headerBg: "transparent",
        },
        Segmented: {
          borderRadius: 6,
          borderRadiusSM: 4,
        },
        Tag: {
          borderRadiusSM: 4,
        },
        Menu: {
          itemHeight: 36,
          itemBorderRadius: 6,
          itemMarginInline: 8,
          iconSize: 15,
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
  // 依赖产物(monaco worker、各 async chunk)带 ES2018 的对象 rest 解构,而 umi 给
  // esbuild 压缩阶段注入的目标基线含 es2015,esbuild 明确「无法把解构降级到该目标」,
  // 于 @umijs/max 4.7 + esbuild 0.28 下整批 chunk 压缩失败(实测 57 个)。
  // 只抬高**压缩**目标,不动下面的 targets —— 转译仍按浏览器矩阵走。
  // 注:这些第三方 chunk 的新语法本来就未被成功降级(esbuild 报的正是降不了),
  // 因此本改动不会让实际的旧 Safari 兼容性比现状更差;真要保证需转译 node_modules。
  jsMinifierOptions: { target: 'es2020' },
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
