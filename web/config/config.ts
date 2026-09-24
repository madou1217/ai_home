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
  // Cyber HUD（见 web/DESIGN.md）：这里只放与主题无关的结构型 token（圆角、字体、控件高度）；
  // 会随深浅翻转的颜色在 src/theme/antd-theme.ts，由 AntdThemeProvider 运行时注入。
  // HUD 以切角代替圆角：基础圆角 2px，面板轮廓由全局 CSS 的 clip-path 表达。
  antd: {
    theme: {
      token: {
        borderRadius: 2,
        borderRadiusLG: 4,
        borderRadiusSM: 2,
        borderRadiusXS: 2,
        controlHeight: 32,
        controlHeightLG: 40,
        controlHeightSM: 24,
        fontSize: 13,
        fontFamily: "'JetBrains Mono', 'HarmonyOS Sans SC', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', ui-monospace, monospace",
        fontFamilyCode: "'JetBrains Mono', 'SF Mono', ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace",
        motionDurationFast: "0.12s",
        motionDurationMid: "0.16s",
        motionDurationSlow: "0.24s",
        wireframe: false,
      },
      components: {
        Table: {
          headerSplitColor: "transparent",
          borderRadius: 4,
          cellPaddingBlock: 10,
          cellPaddingInline: 12,
        },
        Card: {
          borderRadiusLG: 4,
        },
        Button: {
          borderRadius: 2,
          borderRadiusLG: 2,
          borderRadiusSM: 2,
          fontWeight: 600,
          primaryShadow: "none",
          defaultShadow: "none",
          dangerShadow: "none",
        },
        Select: {
          borderRadius: 2,
          borderRadiusLG: 2,
          borderRadiusSM: 2,
        },
        Input: {
          borderRadius: 2,
          borderRadiusLG: 2,
          borderRadiusSM: 2,
        },
        Modal: {
          borderRadiusLG: 4,
          headerBg: "transparent",
        },
        Segmented: {
          borderRadius: 2,
          borderRadiusSM: 2,
        },
        Tag: {
          borderRadiusSM: 2,
        },
        Menu: {
          itemHeight: 36,
          itemBorderRadius: 2,
          itemMarginInline: 8,
          iconSize: 14,
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
  // 首帧前写入主题，避免深色 HUD 默认主题出现浅色闪屏。键名与 src/services/theme-persistence.ts 一致。
  headScripts: [
    {
      content: "(function(){var t='dark';try{var s=localStorage.getItem('aih.theme');if(s==='light'||s==='dark')t=s;}catch(e){}document.documentElement.setAttribute('data-theme',t);})();",
    },
  ],
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
