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
    component: "./AccountsRoute",
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
    name: "Fabric 集群",
    path: "/fabric",
    icon: "cluster",
    routes: [
      {
        path: "/fabric",
        redirect: "/fabric/nodes",
      },
      {
        name: "Server 管理",
        path: "/fabric/control-planes",
        component: "./FabricControlPlanes",
        icon: "cloudServer",
      },
      {
        name: "连接方式",
        path: "/fabric/remote-nodes",
        component: "./FabricRemoteNodes",
        icon: "apartment",
      },
      {
        name: "SSH / Bootstrap",
        path: "/fabric/ssh-hosts",
        component: "./FabricSshHosts",
        icon: "desktop",
      },
      {
        name: "节点总览",
        path: "/fabric/nodes",
        component: "./FabricNodes",
      },
      {
        name: "传输候选",
        path: "/fabric/webrtc-diagnostics",
        component: "./FabricWebrtcDiagnostics",
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
    path: "/accounts/:provider/:accountId/models",
    component: "./Models",
    hideInMenu: true,
  },
  {
    path: "*",
    redirect: "/dashboard",
  }
];
