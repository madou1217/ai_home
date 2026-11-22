// Package completion 实现 aih 终端集成的内部入口：TAB 补全、拼写建议与已学习纠正。
//
// 该包只承载「命令面 + 候选解析」，不做意图派发：协议输出走 wire.go，命令/旗标
// 事实在 commandtree.go，Provider 事实来自 core/providers 合同，动态候选（账号、
// 模型、会话、peer、代理、远程执行目录）一律 fail-soft；远程执行目录只做有界
// 只读 HTTP 查询，失败时不使用本地 Provider/账号/模型候选。所有对外入口都保证：
//   - 退出码永远为 0；
//   - stdout 只写协议行，诊断只在 --debug 时写 stderr；
//   - 不启动 Node，不触碰网络（代理候选除外，且有 650ms 上限与本地缓存）。
package completion
