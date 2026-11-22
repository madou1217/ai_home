// Package proxycompile 把标准化代理节点编译为各客户端/内核的配置片段。
//
// 依赖只有 proxykit 与标准库：mihomo、sing-box、Surge 系、Quantumult X、
// Egern 以及本机中转配置编译都在这里。订阅聚合层通过构建标签保留内置
// 参考实现；生产渲染与出口引擎插件直接依赖本包，避免链接整个聚合服务。
package proxycompile
