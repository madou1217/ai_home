# CLI TAB 补全矩阵（2026-10-31）

> 原则：**先 aih 自己的数据（声明表 / 注册表 / 缓存），再合同，最后才是原生库或 shell 默认。**
> 一次 TAB 的预算：目标 < 100ms（冷启动后热路径 ~35ms；首查读原生会话库约 300ms，靠缓存摊掉）。
>
> 全部候选来自 `lib/cli/complete/`：
> - `command-tree.js` 命令面唯一声明表（命令 / 子命令 / 旗标 / provider 动作）
> - `resolve.js` 位置规则（纯函数，数据源由调用方注入）
> - `candidates.js` 需要 IO 的候选（会话、账号级数据、config 取值、缓存）
> - `index.js` 轻量入口 `aih __complete`（约 30ms 启动，不装配完整 CLI）

## 已实现的位点

| 敲到这里按 TAB | 候选 | 数据来源 | 说明 |
|---|---|---|---|
| `aih <TAB>` | 顶层命令、所有 provider、历史整条命令 | 声明表 + 历史文件 | 历史候选按使用次数排序 |
| `aih h<TAB>` | `harness` … | 声明表 | 前缀过滤大小写不敏感 |
| `aih server <TAB>` | start/stop/status/config/… | 声明表 | |
| `aih server config <TAB>` | show/get/set/list | 声明表 | |
| `aih server config set --<TAB>` | 全部可设置项 | `SERVER_CONFIG_FIELDS` 描述符表 | 与 `server config list` 同源 |
| `aih server config set --relay-udp <TAB>` | default / on / off | 描述符表 `values` | 枚举字段才有 |
| `aih <cli> <TAB>` | 动作 + 账号 id + `--` + 历史 | 声明表 + 账号库 | |
| `aih <cli> <账号> <TAB>` | 动作（resume/fork/sessions/delete/…） | 声明表 | 常见输入顺序，账号之后仍给动作 |
| `aih <cli> resume <TAB>` | 会话 id（标题 · 时间） | 会话库（带缓存） | |
| `aih <cli> <账号> resume <TAB>` | 会话 id，**aih 活跃会话排最前** | 持久会话注册表 + 会话库 | 活跃项标 `● 活跃` |
| `aih <cli> resume <标题片段>` | 标题命中的会话 id | 会话库 | id 是 UUID，记不住就按标题片段找 |
| `aih <cli> fork <TAB>` | 同上 | 同上 | |
| `aih resume <TAB>` | 最近会话 id（标题 · provider · 时间） | 会话库（45s 缓存） | 选中回车即续聊 |
| `aih harness <TAB>` | pi / dsh / dsh-tui | `harness/catalog` 注册表 | 与实际能跑的集合同源 |
| `aih harness pi --provider <TAB>` | 所有 provider | 合同（manifest） | |
| `aih harness pi --provider X --account <TAB>` | X 的账号 id | 账号库 | 也支持 `--account codex:2` 简写 |
| `aih claim <provider> --account <TAB>` | 该 provider 账号 id | 账号库 | 没有 `--provider` 时就近认 provider |
| `aih usage <TAB>` | stats/models/sessions/… | 声明表 | |
| `aih edge apply|plan <TAB>` | frp / nginx / caddy | 声明表 | |
| `aih node|fabric|native|mcp|skill|shell … <TAB>` | 下一层子命令 | `NESTED_SUBCOMMAND_TABLES` | 表里没有的层级让路给 shell |
| `aih export|import <TAB>` | 无（交回 shell） | — | 文件路径由 shell 自己补 |
| `aih <cli> -- <TAB>` | 无 | — | 逃生门之后是原生 CLI 的世界 |

## aih resume（选择器）

`aih resume [关键词]` 列出最近的会话：当前目录 ◆、provider、标题、相对时间、id，
第二行是**最后一句用户输入**（尾部 256KB 分块回溯，最多 4MB；JSONL 类 provider 有效，
DB 类回退到项目路径）。输入编号 / id 前缀 / 标题片段都能选，回车取第一条，q 退出。
`--json` 输出同样的结构（含 preview），给脚本用。

## 帮助文本

`aih --help` / `aih <cli> --help` 按用途分组（常用 / 会话 / 账号 / 网关与远程 / 终端与福利 / 进阶 /
看细节），列宽按每组最长命令自适应，中文按两列计算宽度（`displayWidth`），避免说明列跳动。

## 刻意不给候选的地方

- `aih <cli> resume <id> <TAB>`：后面是原生参数，aih 不猜。
- `--` 之后的任何位置：原样透传。
- 路径类参数（`--rc-file`、`aih export <file>`）：交回 shell 的文件补全。

## 性能

| 场景 | 耗时 |
|---|---|
| `aih <TAB>`（纯声明表） | ~35ms（含 node 启动） |
| `aih codex resume <TAB>` 冷（读原生库） | 250~450ms |
| 同上，45s 内重复 | ~35ms（`run/cache/complete/sessions-*.json`） |
| `aih harness <TAB>` | ~35ms |

缓存只服务补全：真实列表、续聊、计费永远读原库。

## 下一步（按收益排序）

1. **`--model <TAB>`**：按 provider 的模型目录给候选（现在只有 harness/CLI 的别名表，需要接入 model-catalog）。
2. **`aih ss <TAB>`**：持久会话名（tmux/psmux pane 名）——需要把注册表读取做成静默 API（现在列表函数会打印表格）。
3. **`aih edge apply|plan <TAB>`**：frp / nginx / caddy 引擎名。
4. **`aih harness <id> --model <TAB>`**：harness 别名（sonnet/haiku…）。
5. **文件/路径位点**：`aih export <TAB>`、`aih import <TAB>`、`--rc-file <TAB>` 用 `compgen -f` 而非 aih 自己列。
6. **内联预览**：zsh 的 `compadd -d` 已支持说明列；可以再加第二行（会话最后一条用户消息）做"预览"，但要注意 TAB 延迟预算。
7. **aih server 在线优先**：server 运行时从 `/v1/sessions`（若开）取会话索引，比读原生库更快、也更"aih 内部优先"。
