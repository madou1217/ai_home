# Web Chat 验收清单

更新时间：2026-04-12

说明：
- `[x]` 已能从当前代码与现有自动测试确认
- `[ ]` 仍需真实环境手工验收，或我暂时不能仅凭仓库内容确认

## 账号与额度

- [x] 仪表盘与账号管理页都接入统一的 usage remaining 数据来源
- [x] API Key 模式账号统一按无额度显示处理，不再伪造 remaining 数值
- [x] Codex 用量快照支持 `5h` 与 `7days` 两个窗口数据结构
- [x] Gemini 用量快照支持按模型维度展开显示
- [x] 账号类型字段已落到 `planType`，支持 `team / plus / free / api-key` 等类型
- [x] remaining 展示已恢复为水平 progress bar，而不是纯数字 label
- [ ] 用真实 `plus / free / team` 账号逐个核对 Web 展示是否和实际额度完全一致
- [ ] 用真实 Gemini 多模型账号核对展开后的模型用量是否全部正确

## 会话运行态与项目列表

- [x] Web 已改为单路 `/webui/projects/watch` 聚合运行态，不再为每个会话单独开监听
- [x] 项目列表支持按会话维度同时跟踪多个运行中的会话
- [x] 会话级 provider icon 支持稳定旋转运行态
- [x] 项目折叠时，项目名右侧的 provider icon 会按 provider 维度显示旋转运行态
- [x] 项目展开时，只保留会话级别的运行态 icon，不再重复做项目级旋转
- [x] 已归档会话入口固定在项目列表底部
- [x] 会话选中状态已持久到 URL，刷新后可按 `projectPath / provider / sessionId / projectDirName` 恢复焦点
- [ ] 手工验证“切换会话时不会误终止另一个正在运行的会话”
- [ ] 手工验证“其他客户端触发的运行态，Web 侧也能稳定感知并旋转显示”

## Thinking / Queue / TodoWrite / Plan

- [x] Web 轻量 `thinking` 尾部状态已落地，在没有 assistant 锚点时也会给出反馈
- [x] Web 已避免把纯 `thinking` 渲染成一个新的独立 assistant 会话消息
- [x] assistant 流式事件已按“thinking -> delta -> done”合并到同一条消息链路
- [x] `Queue` 已按会话维度独立存储，不再混到单会话单流模型里
- [x] Codex OAuth 会话支持 `after_tool_call` 队列模式，其他 provider 默认为 `after_turn`
- [x] `TodoWrite` 已支持解析并挂到输入框上方工作区
- [x] `Plan` 已支持解析并挂到输入框上方工作区
- [x] 输入框上方 `Queue / TodoWrite / Plan` 已统一为同一组工作区
- [ ] 用真实 Codex 会话验证 `thinking -> tool call -> answer` 全链路视觉衔接
- [ ] 用真实 Claude 会话验证“thinking 不与最终 AI 消息并存卡住”
- [ ] 用真实 Gemini 会话验证 `thinking / Queue / TodoWrite / Plan` 效果都能收到并正确渲染

## 消息持久化与图片

- [x] Web 发消息支持携带图片
- [x] Web 发送图片后会持久化到聊天附件目录，并可通过附件接口回放
- [x] 消息图片已限制为较小缩略图尺寸，可通过预览放大查看
- [x] 会话消息读取已保留 Codex 用户图片输入
- [x] Codex 原生新会话已从 `session_meta.payload.id` 绑定真实持久会话 ID，避免只依赖旧版 `thread.started.thread_id`
- [x] Web 打开项目和 Codex 原生会话发送前，都会把 `projectPath` 注册到宿主 `~/.codex/config.toml` 的 `[projects."..."]`
- [x] 真实 Web 文本消息已验证会落到 `~/.codex/sessions/.../rollout-*.jsonl`，并且在 server 重启后仍能重新出现在项目列表
- [x] 真实 Web 图片消息已验证会落到 transcript 读取链路，`readSessionMessages` 能读到带 `images` 的 user message
- [ ] 手工验证“Web 发出的消息在 Codex App 重启后不会丢失或闪退消失”
- [ ] 手工验证“Web 发图后在 Codex App / 多端同步界面里都稳定可见”

## 通知、Hook 与完成提示

- [x] 浏览器通知权限请求与完成通知逻辑已落地
- [x] Codex host 全局配置已写入 `codex_hooks = true`
- [x] Codex Stop hook 脚本已自动安装到宿主 `hooks`
- [x] Stop hook 已接入 `beep` 提示逻辑
- [x] 当前机器已完成 `~/.codex/config.toml` / `~/.codex/hooks.json` / `~/.codex/hooks/aih-stop-notify.js` 安装
- [x] 当前机器已验证 hook 脚本和 `osascript -e 'beep 1'` 都能成功执行
- [x] 当前机器已用真实宿主 `codex exec` 验证 `hook: Stop` / `hook: Stop Completed` 会在完成态触发
- [x] 浏览器完成通知的触发条件与文案已补自动测试覆盖
- [ ] 手工验证浏览器通知在真实会话完成时会触发
- [x] 宿主 Codex CLI 完成态已真实触发 Stop hook

## 启动与重启体验

- [x] `aih server start` 已支持非阻塞后台启动路径
- [x] `aih server restart` 已支持先快速 stop 再快速后台 relaunch 的路径
- [x] 守护进程层已有“跳过前台 ready wait”的快速重启测试覆盖
- [ ] 手工验证本机真实重启耗时是否恢复到可接受范围

## 聊天区 UI 对齐

- [x] assistant 头像已外置到独立 gutter
- [x] assistant 消息内容、轻量 `thinking` 行、输入框上方工作区、输入框本体已统一到同一内容轨道
- [x] 用户消息仍保持右对齐，不破坏现有阅读节奏
- [ ] 手工验收桌面端最终视觉对齐
- [ ] 手工验收移动端最终视觉与滚动体验

## 待你优先验收的高风险项

- [ ] Web 发消息后在 Codex App 重启场景下是否仍然稳定落到 transcript
- [ ] 真实 Codex / Claude / Gemini 三种 provider 的 `thinking` 视觉衔接是否都自然
- [ ] 浏览器通知与 Codex Stop hook 是否在真实完成时可靠触发
- [ ] 手机版聊天页是否仍有浏览器下拉回弹与滚动异常
