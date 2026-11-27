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
    icon: "message",
    routes: [
      {
        name: "Chat",
        path: "/chat",
        component: "./Chat",
      },
      {
        // Work 用独立顶级路径：ProLayout 用 getMatchMenu(pathname, menuData, true) 生成
        // selectedKeys，它会用 pathToRegexp('/chat/(.*)') 匹配 '/chat/work'，导致 Chat 与 Work
        // 同时高亮。离开 /chat 前缀后，/work 只命中自己。
        name: "Work",
        path: "/work",
        component: "./Chat",
      },
    ],
  },
  {
    // 历史链接 /chat/work → /work：仍留在 /chat 前缀下，但组件自行带 query 跳转，
    // 且 hideInMenu 让它不参与菜单匹配（不会出现双选中）。
    path: "/chat/work",
    component: "./ChatWorkRedirect",
    hideInMenu: true,
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
    name: "项目管理",
    path: "/projects",
    icon: "project",
    routes: [
      {
        path: "/projects",
        redirect: "/projects/office",
      },
      {
        name: "项目办公室",
        path: "/projects/office",
        component: "./TerminalSessions",
        icon: "desktop",
      },
      {
        name: "需求管理",
        path: "/projects/requirements",
        component: "./Requirements",
        icon: "unorderedList",
      },
    ],
  },
  {
    // 历史深链：项目办公室从 /terminals 迁到项目管理子菜单。保留原组件以继承
    // view/scope/room/session 查询参数，不能简单 redirect 丢参数。
    path: "/terminals",
    component: "./TerminalSessions",
    hideInMenu: true,
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
    // peer 消息收件箱深度链接：直接打开同一「项目办公室」邮箱上下文，不在侧栏保留重复菜单项。
    path: "/peer-inbox",
    component: "./PeerInbox",
    hideInMenu: true,
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
    name: "剪贴板",
    path: "/clipboard",
    component: "./Clipboard",
    icon: "copy",
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
    // 账号额度统计：按窗口期（5h / 7天 / 30天）看额度消耗与用量。
    path: "/accounts/:provider/:accountRef/quota",
    component: "./AccountQuota",
    hideInMenu: true,
  },
  {
    path: "/browser",
    component: "./AccountBrowser",
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
