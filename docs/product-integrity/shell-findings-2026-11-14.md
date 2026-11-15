# M1 Shell 已复现问题与修复证据

日期：2026-11-14；当前 checkout，不是发布版本。所有配置写入在临时 HOME，未修改宿主 rc。未新增测试用例。

| ID | 等级 | 根因与修复 | 实际证据 / 状态 |
|---|---|---|---|
| SH-001 | P1 | zsh 返回 1、bash 空 COMPREPLY、fish -f 都不会自动交回文件补全；显式委托各 shell 原生路径补全 | 真 zsh/bash 3.2/bash 5.3/fish：`aih import RE<TAB>` 由无补全恢复 README.md；`aih codex -- RE<TAB>` 同样恢复 |
| SH-002 | P1 | shell rc 原子 rename 覆盖软链接、默认 644 放宽原 600；独立 rc-file 解析真实目标，保留权限/编码，原子写目标 | 真 CLI apply/apply/status/remove/remove：链接始终存在、mode=600、CRLF 内容卸载后逐字节一致 |
| SH-003 | P0 | 受管标记缺结束行时截断至文件尾，真实 remove 丢失后续用户配置；独立 rc-block 严格校验区域，只替换原位 | 旧版隔离 rc 丢失 `export IMPORTANT_USER_SETTING`；修后 apply/remove exit=1、内容未变；`remove --all --json` 正确 ok=false/exit=1 |
| SH-004 | P1 | 所有同 shell rc 共用一个 snippet，卸载自定义 rc 会破坏默认 rc；按 rc 路径分开 artifact | 真 CLI 安装默认 + custom，再卸载 custom；默认标记/片段保留、custom 片段移除 |
| SH-005 | P2 | remove JSON 后继续输出日志/错误、无片段仍报 undefined 失败；统一分支与退出码 | 真 CLI 重复 remove 输出单个合法 JSON、stderr 空；失败不再全局 ok=true |
| SH-006 | P2 | `--shell=z` 未识别值位，Bash 版本对 '=' 分词不同；统一 resolver 与 Bash 插入边界分别适配 | 真 zsh、Bash 3.2/5.3：`aih shell apply --shell=z<TAB>` 插入 zsh；直接 `__complete` 模型值返回候选，原生 `--` 后仍空 |
| SH-007 | P1 | `--rc-file --json` 把 --json 当文件名写入；缺值/未知选项明确拒绝，--all+单 rc 禁止多语言覆盖 | 旧版隔离 cwd 实际创建名为 --json 的文件；修后 exit=2/invalid_shell_arguments，不写入 |

## 原始实测摘要

- zsh 真实 PTY：修前 `aih import RE` 响铃无候选；修后 `aih import README.md`。
- Bash 5.3：修前 import/-- 路径不补；`cat RE<TAB>` 正常；修后 AIH 同样正常。根因在 AIH 接入，不是 readline 或文件不存在。
- Bash 3.2：未引用空格路径插入 `input\ data.json`；引用输入插入 `"input data.json"`，不得错误插入 `"input\ data.json"`。
- Fish 真实 PTY：同样从无路径候选恢复 README.md。PTY 不支持终端 device-attribute 查询，fish 启动发出一次能力降级提示；与补全验证分开记录。
- `shell-lifecycle-evidence-2026-11-14.json`：3 shell × plan/apply/apply/status/remove/remove；包含空格和单引号路径、600/软链/CRLF。
- UTF-16 LE/BOM profile：真实 CLI+文件系统 apply/apply/remove 保留 BOM，卸载完全恢复；没有 PowerShell 解释器，**不声称 PS 运行时通过**。
- JSON/语法与 `git diff --check` 通过仅作为辅助，不替代上述运行证据。

## 性能基线

`completion-baseline-2026-11-14.json` 保存每组 30 次原始测量（新 CLI 进程、温热文件系统；不是冷启动，也不包括 terminal renderer）。

| 补全上下文 | p50 ms | p95 ms | max ms |
|---|---:|---:|---:|
| server 子命令 | 42.70 | 56.82 | 64.51 |
| shell apply --shell | 40.53 | 45.77 | 46.77 |
| codex --model gpt-6 | 51.99 | 104.67 | 186.87 |

不把这些数字说成“真实按键到屏幕端到端”。尚需全链路、冷缓存、大数据和升级后复测。

## 仍需继续

- Windows PS5/PS7 真实终端与 Linux 真实环境；本机没有 pwsh，不用历史自启报告冒充本次验收。
- shell 中光标位于词中、引用/转义/多命令/管道/重定向、可选参数完整矩阵。
- history 全量读入、session 冷缓存全库扫描、过期和损坏 cache 的边界/性能。
- 纠错确认/学习、Provider 动作声明与实际可执行性、安装 feature 参数保存、doctor 的真实性。
- rc 并发修改仍有最终 compare→rename 的 OS 窗口；当前只能检测可观察的快照变化，不声称跨进程 CAS。
- ACL/扩展属性与 Windows 替换语义尚未真机验证；无尾换行往返和安装后新增 suffix 已于 11-15 补真实 CLI 验证。
- 全功能 M0–M5 远未完成；上述条目不能替代其余功能域验收。

## 2026-11-15 追加修复与复核

- **SH-008 / P1：组件 opt-out 丢失**。实测 `apply --no-typo --no-wrapper` 后普通 status 报 true/过时；修后生成片段包含只读 JSON 注释设置，status/普通 apply 保留选择；显式 `--typo/--wrapper/--completion` 恢复。不执行片段读取设置；旧版 `$dollar home` 转义路径已实际迁移，保留 false。
- **SH-009 / P2：doctor 宣称检查语法但实际没调用解析器**。修后检查安装文件的真实 shell parser、可执行路径与 exit code，子进程继承指定隔离 env；无 shell 则报告未验证而非通过。
- **SH-010 / P2：history 全量读/切行**。34.8 MB 隔离真实历史文件使进程 RSS 达 270,221,312 bytes；最近行数/4 MiB 字节预算的反向读取后候选一致，单次 54,657,024 bytes；30 次 warm p95 42.09ms，见 `history-tail-evidence-2026-11-14.json`。FIFO 以 nonblocking open 后 fstat 拒绝；stdin 无限流/上游 shell 历史顺序仍待查。
- **SH-011 / P2：命令声明 typo forget 未实现**。旧 handler 忽略 positional forget 而列出纠错表；修后隔离真实 CLI `typo forget codx` 返回 forgotten，缺参数/未知子命令 exit=2，不再静默执行别的动作。
- 无尾换行原文件：apply/remove 后严格恢复；若用户在安装后追加 export 行，卸载保留前后行边界，不会把 export 拼进注释。
- 引号与特殊名：Bash 3.2 真实输入 `aih import "rep<TAB>` 对字面文件 `report$(printf MARK).json`，最终插入 `"report\$(printf MARK).json"`；单引号名插入 `'single'\''quote.json'`。未运行 import，更没有执行文件名里的命令。
- inline 前置账号：`--provider=codex --account=1 --model=`、分离参数与 Bash 分词形式真实 CLI 候选数/摘要一致。仅说明同一目录投影，不能据此证明后续模型执行。
- config 值位：独立 schema 适配器区分 switch / 无枚举值 / 枚举；`--port=` 与 `--port ''` 不再返回 `--host`；`--open-network ''` 仍补选项；枚举 `--model-cache-sync` 返回 scheduler/go-batch，不把 go-batch 当作顶层 flag。
- zsh 词中补全遵守用户 COMPLETE_IN_WORD 选项；开启时真实 `--shell=z|h<TAB>` 得到 zsh，默认关闭不强行改变用户 shell 选项。
- 新最终生命周期记录 `shell-lifecycle-final-2026-11-15.json`：真实 zsh/bash/fish × 9 操作，全部 exit=0，链接/mode/内容保留；不是完整平台和操作矩阵。

### 独立审查记录

只读 reviewer Rawls 首轮指出 EOF suffix 拼接、Bash3 引号风险、inline 前置账号与非枚举 config 值位；均真实复现或真实 CLI 校验并修复。第二轮指出 Bash 拆分 `=` 绕过 inline 修复；现同一 schema value 适配器覆盖两条路径。最终定点复核已确认上述已报告阻塞项在源码层关闭；reviewer 未重跑命令，真实证据由主会话提供。此结论不覆盖 M1 全矩阵或全计划。

- 实际 FIFO history 验证：`mkfifo` 后用真实 `__complete --history-file <fifo>`，61ms 返回 15 个 server 候选，exit=0，未阻塞；无写端、无替身。
- 浏览器边界：运行中的 Edge PID 已确认；当前工具未暴露 browser-use/Node REPL，未发现 Edge DevToolsActivePort，也没有本地 Playwright 模块。没有重启/换浏览器、没有 AppleScript；页面验收仍缺证据。

- **SH-012 / P1：fish 纠错丢参数**。真实 fish 交互调用纠错入口，显示 `aih shell status --shell fish --json`，确认 1 后旧版只运行 aih 并打印全局帮助；协议解析只取 parts[4]。修后保留第4字段到末尾完整 argv，再确认相同候选返回 fish status JSON；隔离 corrections.json 真实保存 6 个 argv token。不依赖 mock，也未执行账号/推理操作。PowerShell 存在相同索引形态，尚缺运行时复现，不标已修复。
- 官方 browser 插件诊断（Edge family）：Edge running=ok；读取 Local State 报 EPERM；Native Messaging `com.openai.codexextension.json` 报 missing。没有修 native host、没有更改浏览器权限；实际页面验收需先恢复支持的浏览器连接。

### 后续不可遗漏项

- Bash3.2 历史展开 `!` 等特殊字节与文件名换行尚未完整覆盖；当前双引号 $/反引号、单引号、空格验证不能泛化为全部 filename。
- 普通空候选仍可能退回文件建议到非枚举数值/secret 位置，需建立明确 completion disposition 而不是猜空列表含义。
- 远端 SSH/Linux/Windows 无本轮完整授权/连接证据；不能用构建或早期自启报告替代本轮 shell 验收。

- **SH-013 / P1：重复 source 自包装递归**。真实 zsh `source snippet; source snippet; FUNCNEST=15; <不存在命令>` 旧版报 maximum nested function level reached。原因：没有原 hook 时第二次将自身保存成 fallback。修后使用本 shell 安装标记，不再保存自己；zsh/bash3/fish 未知命令均 127 无递归；有原 hook 的 zsh/bash5/fish 实际回调一次。Bash3 本身不使用 command-not-found handler，不据此伪造 fallback 支持。
- `--no-typo` 与 wrapper 独立开关：wrapper 所需辅助函数仍生成，但全局 typo 开关保持 false，避免引用不存在函数。
- PowerShell header 加入时保留 UTF-8 BOM 在 byte0；实际生成字节为 EFBBBF。没有 PS 解释器，仍仅算文件编码证据，不标实际运行通过。

- **SH-014 / P1：纠错协议吞用户参数**。真实 `__suggest --inside -- aih shel ... --history-file ... --debug` 旧版把 payload 当协议 flags 删除；空 argv 同样丢失。修后只解析分隔符左侧，实际输出 argv 包含原 flags 和空参数。
- **SH-015 / P1：学习记录重放旧操作**。隔离真实 CLI 先 learn `shel → shell status --shell zsh`，再建议 `shel plan --shell fish`，旧版第一条变成旧 status/zsh。修后学习只提升正确动词排序，当前动作/账号/路径 argv 不被覆盖；无自动执行，仍需用户确认。

- **SH-016 / P1：行协议控制字符拆包**。真实建议 argv 含换行时旧版把一条候选拆成多行；US 同样能错位。现旧版协议不尝试有损转义，拒绝自动建议含控制字节的 argv，普通带空格参数仍完整；候选说明控制字节压平。真实 __suggest 对 newline/US 返回 none；后续若支持这些特殊输入，须版本化协议并一起升级四 shell。

### 补全性能复测（2026-11-15）

同一 Node/宿主、每组30次、新CLI进程、温热文件系统；端到端到进程输出，不含shell绘制。`completion-after-2026-11-15.json`：server p95 39.82ms（基线56.82），shell枚举44.54ms（45.77），codex模型51.92ms（104.67）；候选数分别15/4/5不变。共享机器存在并发负载，不能把全部差异归因于本补丁或推导稳定倍数。

### 末轮审查修复（2026-11-15）

- reviewer 追加指出 PS 生成 BOM 与 rc 原编码写入叠加。已真实文件复现二次 changed apply 写出 EFBBBF EFBBBF，现 generated snippet 单独指定输出编码/BOM，rc 保留原编码不变；多次 changed apply/status/plain apply 维持单 BOM/all opt-out false/幂等。只算文件/CLI，不算 PS5 运行时。
- reviewer 追加指出旧版无安装标记 live reload 仍自捕获。已用 HEAD 真实旧生成器输出 old script → 当前 new script 在 zsh 重现递归；现捕获前识别 AIH 转发 helper，zsh/bash5/fish old→new 均 127 无递归，真实用户 hook 不被当作 AIH 新 owner。

- **SH-017 / P2：zsh 活历史读取为空**。真 zsh -f，HISTSIZE=1000 与 print -s 插入两条实际历史，原 `_aih_shell_history` 仅输出空行；`fc -ln` 能看到新记录。原实现把可选关联参数 $history 当负索引数组。改用原生 `fc -ln -N`，真实 source 后按时间顺序返回记录，不读取/修改宿主 HISTFILE。

- Fish 历史顺序真实验证：隔离 history append 两条记录，默认 newest→oldest 与引擎“后者更新”相反；改用 builtin history search --reverse 后 old→new，避免把旧操作排成最新。
