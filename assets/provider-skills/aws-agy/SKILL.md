---
name: aws-agy
description: Drive the AGY harness on the AIH "AWS" SSH host with gemini-4-neon-xhigh (xhigh effort) for code review or project work. Use when the user says to use AWS / agy / gemini-4-neon-xhigh, asks for a remote Linux box with a signed-in AGY account, or wants a long-running agent session instead of opening more AGY clients.
---

# AWS AGY（gemini-4-neon-xhigh）

用户经常重复的一条流程：**用 AWS 主机上已登录的 AGY，指定 `gemini-4-neon-xhigh`
（effort `xhigh`）做项目工作**。不要反问地址、账号或模型 —— 事实源都在本机
`aih.db` 和 AWS 主机上。

## 事实源

- SSH 连接：`<aiHome>/aih.db` → `app_kv` → `ssh_connections`，标签 **`AWS`**
  （本机 2026-11-25 实测：`conn_d05358604a4ee45b`，`ubuntu@ec2-16-178-55-97…:22`，
  `~/.ssh/aws.pem`）。`aih agy session --connection AWS` 支持标签。
- AGY 二进制：AWS 上 `/home/ubuntu/.local/bin/agy`（1.5.17，`agy acp` 可用）。
- 账号投影（AGY 已登录的 HOME）：`/home/ubuntu/.ai_home/run/auth-projections/agy/`，
  实测可用 `acct_0ea957d4866d74953fcd`。多个投影时挑一个非空的，别用宿主 HOME
  （宿主 `~/.gemini` 未登录，`agy models` 会要求 sign in）。
- 模型：`agy models` 里 `gemini-4-neon-xhigh` = “Gemini 4 Neon (XHigh)”；effort 值
  `low|medium|high|xhigh`。
- 工作区：项目目录在 **AWS 主机上**（例如 `/home/ubuntu/ai_home`、
  `/home/ubuntu/aih-clipboard`），本地改动通过 git push/pull 或 `scp` 同步。

## 模式一：常驻会话（多轮，推荐做评审/长任务）

```bash
aih agy session open "<需求>" \
  --title <短标题> \
  --model gemini-4-neon-xhigh --effort xhigh \
  --connection AWS \
  --root <AWS 上的项目目录> \
  --account-home /home/ubuntu/.ai_home/run/auth-projections/agy/acct_0ea957d4866d74953fcd
aih agy session tail <会话ID> --follow     # 或 say/ls/show
aih agy session say <会话ID> "<追问>"
aih agy session close <会话ID>             # 用完关掉，别留常驻客户端
```

- 默认连接本机 active Server（`AIH_SERVER_BASE_URL` 可覆盖）；
  `AIH_SERVER_MANAGEMENT_KEY` 从 `<aiHome>/aih.db` → `app_kv` → `config:server`
  的 `managementKey` 读，**不要打印或写进命令日志**。
- 进程常驻、上下文不重启；`close` 只是结束会话，记录可 `resume`。

## 模式二：ACP 一次性（不常驻 AGY 客户端）

```bash
# 在 AWS 主机上执行（不是本机！）
export HOME=/home/ubuntu/.ai_home/run/auth-projections/agy/acct_0ea957d4866d74953fcd
export PATH=/home/ubuntu/.local/bin:$PATH
cd <AWS 上的项目目录>
aih agy acp --cwd . \
  --model gemini-4-neon-xhigh --effort xhigh \
  --auto-approve "<任务>"
```

- 需要支持 `--model/--effort` 的 aih（2026-11-25 起：ACP 在 `session/new` 之后用
  `session/set_config_option` 设置 `model` 族与 `thought_level`；不支持的模型/effort
  会直接失败，不会静默换成默认模型）。
- 去掉 `--auto-approve` 就是交互审批（allow_once / reject_once）。
- 跑完进程退出，不留客户端；适合一次性评审、写文件、跑命令。

## 关键边界（2026-11-25 实测，不要猜）

- **AGY 的内置文件/终端工具在 AGY 自己的主机上执行**，不会回传给 ACP 客户端。
  在本机用 `aih agy acp --command <ssh 包到 AWS 的 agy>` 时，AWS agy 写
  `write_file` 仍落在 AWS，报 `mkdir /Users: permission denied`。所以
  “AWS agy 直接写本机目录”不成立；workspace 必须与 AGY 同机。
- 要作用于本地项目，两条可行路径：
  1. 项目放 AWS（git clone / scp），用上面任一模式，产物再同步回本地；
  2. 本机安装并登录 AGY，走 workspace connector 的 `--agent-acp`（agent 与
     workspace 同机）。
- 不要把 AWS 账号/凭据/management key 复制到本机或写进仓库。

## 验收基线（可复跑）

2026-11-25 用上述两种模式各写了一段中文短文，文件在本地
`~/Downloads/test/test_agy/paragraph.md`（session）与
`~/Downloads/test/test_agy_with_apc/paragraph.md`（ACP），两轮对话元数据里的
选中模型均为 `gemini-4-neon-xhigh`（默认是 `gemini-4-neon-high`，必须显式指定）。