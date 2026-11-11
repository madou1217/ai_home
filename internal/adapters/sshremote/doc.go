// Package sshremote 提供 Go 进程内的 SSH 远端传输能力。
//
// 覆盖 WebUI 远端工作区需要的底层动作：拨号、口令/私钥认证、known_hosts 校验、
// 超时与取消、命令执行与流式输出、目录列表、连通性探测。它替代 Node 侧 spawn
// 系统 ssh 的做法（lib/server/ssh-remote-shell.js、ssh-host-probe.js），认证材料
// 只存在于内存，密码不再写 askpass 脚本、私钥不再落临时文件。
//
// 纯逻辑复用 internal/adapters/sshhost：argv 的 POSIX 引用、身份文件校验、
// 列目录命令与解析、探测脚本与事实归类都来自那个包；本包只负责真正的拨号与
// 会话生命周期。
//
// 主机密钥跟随系统 ssh 的 known_hosts（accept-new：未知主机记录后放行，指纹变化
// 一律拒绝），与 Node 运行时的 StrictHostKeyChecking=accept-new 一致。sshhost 里
// 基于 app_kv ssh_known_hosts 的 TOFU 记录是另一套视图，等 WebUI 切流时再统一。
package sshremote
