# 终端自动填入协议字符：2026-11-17 实际构件验收

## 本轮范围与授权

用户最后明确要求「允许，只要解决这个垃圾字符的问题就好了，请继续」。本轮只验证自动填入的垃圾字符，使用获准的本机隔离服务及现有 Microsoft Edge 的本任务专用后台页；不继续扩展失效页签 UI，不重启共享 9527，不清理原任务草稿。

## 原因与已有修复

截图中的 `?1;2c`、`>0;276;0c`、`?2026;2$y` 是终端能力查询的自动应答，不是用户文字。此前已确认：tmux 约五秒握手结束后才到达的回包会被当作按键；分段回包绕过单请求过滤；CLI 换号草稿观察器还可能保存这些回复并再次重放。

原协议 owner 的已提交修复为 `ec0da8192`，慢 CSI 草稿补漏为 `924851765`。本轮没有重写这些源码，也没有用暂存区的并行反向差异构建。真实源码与原生服务／网页产物比对分开记录，不用 commit 祖先关系代替实际行为。

## 可重复定位的实际证据

机器证据根目录：`$AIH_HOME_DIR/run/terminal-incident-20261117/garbage-final-164225/`。

### 1. 当前提交源码的真实输入链

从固定 `7d348253501034241a2026e0de3a294333bacf11` 的普通 `git archive` 构建隔离 Go 与 Web，不建 Git worktree/分支，也不带 HUD 或其他会话未提交修改。Go 构件 SHA-256：`1e6fa669af5114121d148821b4f64f91577a597a7267ee33b10f12104e83bca2`。

真实 HTTP → Go → PTY → tmux → raw-mode 文件记录器验证：

- 晚到首份回包（等待 6.2 秒）、重复、逐字节、间隔 2.35 秒的慢分片、旧客户端未带 protocol 字段的完整回包：每项都新增 **0 字节**。
- 普通中文、emoji、左右方向键、独立 Escape：实际到达字节精确一致。
- 用户明确粘贴的同形协议字节及括号粘贴包络：原样保留，不把用户内容当垃圾删除。

证据：`real-http-pty-tmux-stable-result.json`。

真实 OS PTY → 仓库生产 stdin framer → 仓库生产 switch-draft 观察器验证：三类回包各拆两段并间隔 2.35 秒后，正常草稿完整保留、自动回包排除、有意括号粘贴中的同形内容保留。模块 SHA-256：`4e4c942271225c4e30832ea0480d44620f74516604630fc2bf783c8eb075cc02`。证据：`real-cli-observer-stable-result.json`。

最初两项观测误差已保留而非掩盖：固定 250ms 读取早于 tmux 释放独立 Escape，后改为等待真实字节；草稿模块使用 Latin1 保存原始字节，不能误按 UTF-8 文本比较。更正仅在观察器，不改产品源码适配结果。旧复用空库缺 canonical 元数据导致启动退出后，最终使用生产启动自行创建的全新空 HOME/数据库，没有修改真实业务库。

### 2. 与正式服务相同的已安装 Go 构件

17:05 读取正式 runtime 与磁盘构件后复制执行，SHA-256 都是：

`b0ed9c9359f70e56264ffcc6ef0da72dc9400fa1efee2915e63dee35f32797d0`

以该确切二进制、副本数据库和独立 tmux socket root 再做上述五种自动回包与正常输入实测，全部符合相同字节结果。证据：`installed-real-pty-result.json`。这不是重新构建后推断已安装版本正确。

### 3. 现有 Edge 中的真实生产组件链

只操作本轮隔离 origin 的页面，通过 xterm 现有生产回调与真实浏览器 API → Node 转发 → Go → PTY 记录字节，不拦截网络返回、不伪造业务响应。普通粘贴实际请求带 `protocol:false`，自动回包实际请求带 `protocol:true`；原生焦点始终记录为 false，未使用 `bringToFront`、Apple Events 或浏览器切换。

- 第一轮隔离页面：普通粘贴只到达 PTY 43 字节；刷新后原 pane PID 不变，两次粘贴合计 80 字节；两个独立页面同时产生重复应答不增加输入；有意粘贴回包原样到达。
- 收尾比对发现并行会话已换正式 Web 为 `umi.4551a711.js`。没有把旧页面结果挪给新包：再次原样复制当前 dist，并用同哈希已安装 Go 构件复验，经真实 HTTP 链路，**PTY 记录器仅收到 100 字节用户正常及有意粘贴内容**；八组自动应答经过 HTTP 发送，但不增加 PTY 输入。
- 17:28:23 最后核对正式 9527 仍为 PID `64825`、上述 Go SHA；实际 HTTP `umi.4551a711.js` SHA-256 为 `30039e080f97f55a66314f6ef3136f288fde4c08368fb632d8e9e016d6120f00`，与本轮浏览器验收副本逐字节一致。

证据：`edge-real-input-bytes.json`、`edge-refresh-input-bytes.json`、`edge-multiview-input-bytes.json`、`edge-current-assets-input.txt`、`edge-current-assets-bytes.json`、`final-current-artifact-proof.json`。截图：`edge-garbage-protocol-acceptance.png`。

这证明协议应答与正常粘贴链路，不扩称真人键盘、IME、原生前台焦点或未知后续产物已验收。初次跨页 run-code 的 CLI 观察超时后，先登记实际 tab；后来仅通过支持的 tab-new 设定本任务适配器当前页完成操作，没有 tab-select/bringToFront。原客户端被占用时等待 owner 原记录 exit143 后才串行进入，没有中断他人的客户端／daemon。

### 4. 原任务保留与清理

17:23:00—17:24:00，只读对比同一组 12 个实际用户 pane 的 PID/身份，可见能力回包片段计数均未增长。短时观察只作补充，不作为未来绝不复发的保证；保留的旧污染不会自动清掉。

已关闭本轮三个专用验收页面、所有独立记录器和隔离 Go／Node 进程，私有会话清单为 0；只清理随机隔离 socket root 下的自有残留，并移除随机管理密钥文件。现有 Edge、共享 daemon、3001 的其他任务页面和共享 9527 均保持运行。证据：`edge-own-pages-closeout.txt`、`edge-current-pages-closeout.txt`、`runtime-closeout.json`、`installed-current-cleanup.json`、`final-resource-cleanup.json`。

## 结论与用户动作

截至 17:28:23，当前已安装 Go 与当时正式 Web 的自动应答污染修复已按上面实际构件完成验证；本轮无需再次替换或重启共享服务。用户若仍打开较早加载的页面，应正常刷新以加载当前网页代码。历史已经写进草稿／终端缓冲的字符不自动删除，避免误删混在其中的用户文字。

本报告不宣称恢复已不存在的原会话，不将旧 UI 生命周期任务或 AWS 正式发布纳入本轮结果，也不承诺未知未来版本不回归。未新增测试用例、未提交二进制、密钥、原始私人聊天或机器证据附件。
