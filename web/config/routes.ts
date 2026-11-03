const nodeRoutes = [
  {
    path: "/",
    redirect: "/dashboard",
  },
  {
    name: "仪表盘",
    path: "/dashboard",
    component: "./Dashboard",
    icon: "dashboard",
  },
  {
    name: "账号管理",
    path: "/accounts",
    component: "./Accounts",
    icon: "team",
  },
  {
    name: "AI 会话",
    path: "/chat",
    component: "./Chat",
    icon: "message",
  },
  {
    // 快捷唤起（桌面原生小窗 / 一键打开）：同一个 Chat 页，参数见 pages/chat-quick-launch.ts。
    path: "/chat/quick",
    component: "./QuickChat",
    hideInMenu: true,
    // 独立外壳：不套 ProLayout（顶栏/侧栏）与移动端 HUD 外壳，见 pages/QuickChat.tsx。
    layout: false,
  },
  {
    name: "模型用量",
    path: "/usage",
    component: "./ModelUsage",
    icon: "barChart",
  },
  {
    name: "模型目录",
    path: "/models",
    component: "./Models",
    icon: "database",
  },
  {
    name: "计划任务",
    path: "/scheduled-tasks",
    component: "./ScheduledTasks",
    icon: "schedule",
  },
  {
    // peer 消息收件箱：`aih peer send` 发出的消息在 WebUI 里可见（只读）。
    name: "消息收件箱",
    path: "/peer-inbox",
    component: "./PeerInbox",
    icon: "mail",
  },
  {
    path: "/toolkit/install-guide",
    component: "./ToolkitInstallGuide",
    hideInMenu: true,
  },
  {
    name: "开发工具",
    path: "/toolkit",
    component: "./Toolkit",
    icon: "tool",
  },
  {
    name: "灵感工坊",
    path: "/studio",
    icon: "experiment",
    routes: [
      {
        path: "/studio",
        redirect: "/studio/image",
      },
      {
        name: "AI 生图",
        path: "/studio/image",
        component: "./StudioImage",
        icon: "picture",
      },
      {
        name: "AI 翻译",
        path: "/studio/translation",
        component: "./Translation",
        icon: "translation",
      },
    ]
  },
  {
    name: "Server",
    path: "/servers",
    component: "./Servers",
    icon: "cluster",
  },
  {
    name: "SSH 开发机",
    path: "/ssh-hosts",
    component: "./SshHosts",
    icon: "desktop",
  },
  {
    name: "设置",
    path: "/settings",
    component: "./Settings",
    icon: "setting",
  },
  {
    path: "/server-setup",
    component: "./ServerSetup",
    hideInMenu: true,
  },
  {
    path: "/translation",
    redirect: "/studio/translation",
    hideInMenu: true,
  },
  {
    path: "/accounts/:provider/:accountRef/models",
    component: "./Models",
    hideInMenu: true,
  },
  {
    path: "*",
    redirect: "/dashboard",
  }
];

// Go 账号页只在独立 preview Web 进程中暴露，正式 Web 路由始终使用 Node 页面。
const goAccountsPreviewRoutes = [
  {
    path: "/",
    redirect: "/accounts",
    layout: false,
  },
  {
    name: "Go 账号预览",
    path: "/accounts",
    component: "./AccountsGoPreview",
    icon: "team",
    layout: false,
  },
  {
    path: "*",
    redirect: "/accounts",
    layout: false,
  },
];

const routes = process.env.AIH_GO_ACCOUNTS_PREVIEW === "1"
  ? goAccountsPreviewRoutes
  : nodeRoutes;

export default routes;
