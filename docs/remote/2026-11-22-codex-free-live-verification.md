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
