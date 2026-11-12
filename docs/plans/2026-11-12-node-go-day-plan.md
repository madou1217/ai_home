# Node→Go 单日推进队列（2026-11-12）

目标：不再逐项等待安排；按“可独立验收、失败可回退”的顺序连续迁移 WebUI 读路径。

## 队列

1. **/sessions/:provider/:sessionId/messages**
   - Node 当前 lib/server/webui-session-routes.js
   - 先核对 Go 是否有读取端口；没有则先抽 Reader 接口，不直接搬文件解析。

2. **/sessions/:provider/:sessionId/events**
   - 与 messages 共用会话读取边界；先做形状对拍，再切代理。

3. **/projects/sessions**
   - 项目级完整会话集合；Go webuisessionslistapi 已有账号维度，先补 projectPath 维度。

4. **/projects/watch + snapshot**
   - SSE 运行态投影；先明确 Go 事件源，不能把 Node 轮询搬到 Go 冒充事件。

5. **/app-entries**
   - Go 已有 webuiappentriesapi；按文档处理 installed→available、executablePath→path 形状合并。

6. **/accounts/provider-auth-sources**
   - Go 只判存在性；Node 的 installable/alreadyImported 需显式标注差异后再切。

7. **/control-plane/bootstrap**
   - 保留 Node 本地密钥引导；Go 只做 profile 读侧，不把 management key 下发。

8. **/accounts/:provider/:accountRef/reauth**
   - 复用 Go accountauth 作业；先对齐已有作业幂等返回。

9. **Go 已实现未挂载的四个端口**
   - openapp / refresh / refresh-usage / sshhostbrowse：注入真实 Runner/Refresher 后注册，缺端口保持 501。

10. **退出条件**
    - 每项必须有：Node 语法检查、Go 包测试、至少一条真实 HTTP 响应或对拍、Go 不可用回退路径。
    - 不以“已写代理”代替验收；形状不一致的项只能标 blocked。

## 当前已完成（本轮）
- /projects 切 Go（f1e294d0）
- /slash-commands 切 Go（8242e204）
- /toolkit/environments 补 resources/runtimes/environments 并切 Go（298f2fe2/959716c9/1beccb29）
- /sessions/previews 切 Go（c48f6b2d）
- /git/summary 切 Go（8c7bbea5）
- /git/diff 切 Go（14043382）

## 执行规则
- 每完成一项就提交，不攒大提交。
- Node 只保留契约适配与回退；数据面/持久化优先 Go。
- 失败关闭；无法证明的项不标完成。
