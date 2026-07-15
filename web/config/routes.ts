export default [
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
    name: "Server",
    path: "/fabric",
    icon: "cluster",
    routes: [
      {
        path: "/fabric",
        redirect: "/fabric/servers",
      },
      {
        name: "Server 管理",
        path: "/fabric/servers",
        component: "./FabricControlPlanes",
        icon: "cloudServer",
      },
      {
        path: "/fabric/control-planes",
        redirect: "/fabric/servers",
      },
      {
        path: "/fabric/remote-nodes",
        redirect: "/fabric/servers",
      },
      {
        name: "SSH 开发机",
        path: "/fabric/ssh-hosts",
        component: "./FabricSshHosts",
        icon: "desktop",
      },
      {
        path: "/fabric/nodes",
        redirect: "/fabric/servers",
      },
      {
        path: "/fabric/webrtc-diagnostics",
        redirect: "/fabric/servers",
      }
    ]
  },
  {
    name: "设置",
    path: "/settings",
    component: "./Settings",
    icon: "setting",
  },
  {
    path: "/server-setup",
    component: "./FabricServerSetup",
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
