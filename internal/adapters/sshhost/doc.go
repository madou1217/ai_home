// Package sshhost 承载 SSH 宿主侧能力：远端目录浏览、主机指纹与 known_hosts、
// 身份文件校验、连通性探测、远程 shell 命令构造与断线守护状态机。
//
// 它对应 Node 的 lib/server/ssh-host-browse.js、ssh-host-probe.js、
// ssh-identity-file.js、ssh-remote-shell.js、ssh-remote-supervisor.js，以及
// lib/cli/services/ssh-clipboard 里与 SSH 参数和按键识别相关的纯逻辑。
//
// 本包只做「纯逻辑 + 可注入的宿主接口」：不直接连 SSH、不读 app-state 数据库、
// 不注册 HTTP 路由。真正的拨号（ssh2 / x/crypto/ssh）与 WebUI 接线留给调用方，
// 因此所有分支都能用 fake 实现做表驱动测试。
package sshhost
