# Codex 免费账号真实工具循环验收

日期：2026-11-22（Asia/Shanghai）
状态：通过。真实 Codex 进程在 AWS AIH Server 上运行，使用 free 账号模型，通过 Workspace Connector 修改了本地文件。

## 环境

- AWS AIH Server：Ubuntu aarch64，systemd 用户单元 com.meadeo.ai_home，127.0.0.1:9527
- 部署二进制：本地完整构建的 linux-arm64 aih-server（含 Provider Adapter 工具通道）
- Codex CLI：0.171.0，安装到 AWS，/usr/local/bin/codex
- AIH CLI：linux-arm64，/usr/local/bin/aih
- free Codex 账号：CLI 账号 10（free），模型 gpt-5.6-luna
- 本地工作区：/private/tmp/aih-real-project，workspaceId wc-dda754979cd4fcb59f

## 闭环

1. 本地 aih workspace connect 通过 SSH 隧道连接 AWS，workspace 状态 online；
2. 调用 AWS agent-terminal，body 为 {agent:"codex", account:"10", model:"gpt-5.6-luna"}；
3. AWS 启动 aih codex 10 ... -m gpt-5.6-luna，MCP server 指向 aih-server __mcp-remote-tools，
   launch context 带 workspace tool token 与 toolsUrl；
4. 通过 Web Terminal input 发送 prompt：读取 README.md，创建 RESULT.txt 写入 codex-ok；
5. 本地 /private/tmp/aih-real-project/RESULT.txt 实际出现，内容为 codex-ok。

## 证据

```text
RESULT_CONTENT=codex-ok
-rw-r--r-- 1 model wheel 8 Nov 22 21:33 RESULT.txt
AWS: codex-cli 0.171.0; systemd active; aih-server sha256=3d91b252...
进程: /usr/local/bin/aih codex 10 ... -m gpt-5.6-luna
```

## 边界与后续

- 本次走 aih codex 的 Native Direct free 账号路径，不是 Server gateway 模式；这样可以使用指定 free 账号并保留 CLI 的账号投影生命周期。
- 本次验证的是 Codex CLI 的真实 MCP 工具循环；AGY 仍无结构化工具通道。
- run_command、持久 job、审批协议仍未开放。
- AWS 主机新增 Node/npm、Codex CLI 和 /usr/local/bin 链接；aih-server 已备份为 aih-server.prev-*，systemd 单元已重启。

## run_command 真机闭环（2026-11-23）

环境：同一 AWS Server（新 aih-server，sha256 `72f6047f229791a4c9ccb172f1ced5c18880db2bd88d902115e65aa604d2c61d`）；
本地 Connector 以默认命令模式连接新 workspace `wc-575c11e4cf521bfd34`，root
`/private/tmp/aih-real-project`。

流程：`agent-terminal`（`agent=codex`、`account=10`、`model=gpt-5.6-luna`）→ Codex 调用
`aih_remote.run_command` → Server tool endpoint → Connector 在本机执行
`printf 'aws-codex-ok' > RUN_CMD.txt && cat RUN_CMD.txt`。

证据：

- Codex 终端：`Calling aih_remote.run_command`、`duration: 17ms`、`stdout: aws-codex-ok`、
  `done · Worked for 6s`；
- 本机 `RUN_CMD.txt` 实际写入，内容 `aws-codex-ok`（12 字节，2026-11-23 00:12）。

边界与排障：

- 首次启动报 `account projection conflict: session entry session_index.jsonl has no host
  target`：账号投影里有 Codex 写入的 `session_index.jsonl`，宿主 `~/.codex` 没有对应文件。
  把投影文件复制到宿主同名路径后投影按既有规则归一；这是数据面状态修复，不是代码改动。
- Web Terminal 提交用户输入时 `protocol` 必须是 `false`（或不传）；`protocol=true` 是 xterm
  协议回复通道，回车不会提交。
- 本次新 workspace 与临时 profile 仅用于验收，验收后已撤销并清理。

### 复核（2026-11-23）

AWS Server 随后被其他会话更新过，复核时运行中的二进制 sha256 为
`82c5d3e1da77d575fe9f2379f39957bd759332bdb5bc0d07a93583acb90bf406`。重新登记一个
workspace（`wc-e439391e87c8332f68`）后重跑同一闭环：

- Codex 终端：`Calling aih_remote.run_command`、`duration: 147ms`、
  `stdout: codex-verify-1795399851741`；
- 本机 `VERIFY.txt` 实际写入同一随机串。

复核用的 workspace、enrollment 与临时 profile 已在验证后撤销并清除；当前 Server 的
Connector 登记为空。

## 账号与模型选择器（2026-11-22）

WebUI 本地工作区行的 AI 终端改为 Popover 选择器：先选 Agent（Codex/Claude），再选账号
（显示 CLI 账号别名与可用模型数），最后选模型（显示 catalog 名与 CLI 名）。账号/模型列表
来自现有 remote-targets inventory；AccountFact 新增 cliAccountId 非敏感字段，供 aih codex
的账号启动使用。默认优先选择 gpt-5.6-luna（free 模型），选择后再调用 agent-terminal。

