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
    name: "Fabric 集群",
    path: "/fabric",
    icon: "cluster",
    routes: [
      {
        path: "/fabric",
        redirect: "/fabric/nodes",
      },
      {
        name: "控制面",
        path: "/fabric/control-planes",
        component: "./FabricControlPlanes",
        icon: "cloudServer",
      },
      {
        name: "远程节点",
        path: "/fabric/remote-nodes",
        component: "./FabricRemoteNodes",
        icon: "apartment",
      },
      {
        name: "SSH 开发机",
        path: "/fabric/ssh-hosts",
        component: "./FabricSshHosts",
        icon: "desktop",
      },
      {
        name: "节点健康",
        path: "/fabric/nodes",
        component: "./FabricNodes",
      },
      {
        name: "WebRTC 实验室",
        path: "/fabric/webrtc-lab",
        component: "./FabricWebrtcLab",
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
    path: "*",
    redirect: "/dashboard",
  }
];
