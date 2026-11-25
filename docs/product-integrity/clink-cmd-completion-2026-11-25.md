# Clink（cmd.exe）补全支持

日期：2026-11-25
范围：cmd.exe 的 aih TAB 补全；Clink 1.9.37；Windows 11 真机
结论：通过。`aih shell apply --shell cmd` 安装 Lua 生成器；普通 cmd 由 Clink AutoRun 自动加载，Tab 实测通过。
相关提交：`d3478a19`

## 1. 背景与边界

- cmd.exe 原生没有可编程参数补全 API；Tab 只补文件/命令名，不能注册参数候选。
- Clink 是 cmd 的 readline 层，提供 Lua match generator；没有安装 Clink 时无法支持参数级补全。
- 本实现不修改 Clink；只检测 Clink、写 `aih.lua`，并提供 `status / plan / apply / remove / snippet / doctor`。
- Clink 是第三方组件，安装与 AutoRun 属于宿主环境变更；卸载路径见第 6 节。

## 2. 入口与安装位置

```bat
aih shell apply  --shell cmd
aih shell status --shell cmd
aih shell plan   --shell cmd
aih shell snippet --shell cmd
aih shell doctor --shell cmd
aih shell remove --shell cmd
```

- `--shell clink` 是 `cmd` 的别名；`aih shell --shell <TAB>` 已包含 `cmd`。
- 检测顺序：`CLINK_EXE` → `PATH` 中的 `clink_x64.exe` / `clink.exe` → `%LOCALAPPDATA%\clink` →
  `%LOCALAPPDATA%\Programs\clink` → `Program Files`。
- 通过 `clink info` 读取真实的 `state` 与 `scripts` 目录；脚本写入 **state 目录**（Clink 保证加载）：
  `%LOCALAPPDATA%\clink\aih.lua`。
- 用户级 AutoRun：`clink_x64.exe autorun install` 写入当前用户 cmd 的 AutoRun，值为
  `"…\clink.bat" inject --autorun`；新开的 cmd 自动加载 Clink。

### 2.1 安装 Clink（本次真机示例）

1. 从 [Clink 官方发布页](https://github.com/chrisant996/clink/releases) 下载 zip，解压到
   `%LOCALAPPDATA%\Programs\clink`（用户级，不需要管理员）；官方安装包也可，检测逻辑兼容。
2. 执行 `clink_x64.exe autorun install` 注册当前用户 AutoRun；
   `clink_x64.exe autorun show` 可核对，`autorun uninstall` 可撤销。
3. 执行 `aih shell apply --shell cmd`，然后新开一个 cmd 窗口。

## 3. Lua 生成器实现

- 生成器：`clink.generator(10)`，`generate(line_state, match_builder)`。
- 当前词：行尾时 `line_state:getendword()` 为空，改用
  `getwordinfo(getwordcount()).offset` + `getcursor()`，`current = line:sub(offset, cursor)`。
- 前置词：`getword(1..count-1)`，去掉第一个 `aih` 后传给 `__complete`。
- 调用：`aih __complete --plain --shell clink --current=<current> -- <prior...>`。
  默认 `--plain` 只取纯值，避免 936 代码页下中文说明乱码；设置
  `AIH_CLINK_DESCRIPTIONS=1` 时改用带说明的协议（需要 UTF-8 控制台）。
- `io.popen` 的命令第一个 token 不无条件加引号；仅对含空格/引号的词加引号。
  无条件给可执行文件加引号时，Clink 下没有候选输出。
- 有候选返回 `true`；没有候选返回 `false`，让 Clink 回落到文件补全。

## 4. 真机验证

环境：Windows 11（build 26300）、Clink 1.9.37.7ac257、Windows PowerShell 5.1 / PowerShell 7.7.0
（PS 7 仅用于确认 PowerShell 补全不受影响）。

| 输入 | 结果 |
|---|---|
| `aih codebuddycn --se<TAB>` | 补成 `--session` |
| `aih update --ch<TAB>` | 补成 `--check` |
| `aih codebuddycn <TAB>` | 列出 `relay / models / login / sessions / …` |
| `aih codebuddycn --<TAB>` | 列出 `--session / --model / --help` 等 |
| `aih claude -- --permission-mode <TAB>` | 列出 `acceptEdits / auto / bypassPermissions / manual / dontAsk / plan` |
| `aih <TAB>` | 列出根命令（`account / limits / shell / …`） |

CLI 侧同时验证：`apply`（首次写入与再次运行提示已是最新）、`status`、`plan`、`snippet`、
`remove`、`doctor`、`--dry-run`、`--json` 全部通过。

非交互 `cmd /c` 正常；在 SSH 外层引号下看到的 `ok"` 与 Clink 无关（`cmd /d /c` 同样出现）。
PowerShell 5.1 / 7.7 的既有补全入口仍通过 `shell doctor`。

## 5. 编码与显示

- cmd 默认控制台常见代码页 936；Clink 拿到的 UTF-8 中文说明会显示为乱码。
- 因此默认 `--plain`，只显示候选值（命令、子命令、flag、账号、模型等）。
- 需要说明列时：`AIH_CLINK_DESCRIPTIONS=1` + UTF-8 控制台（65001）。

## 6. 卸载

```bat
"%LOCALAPPDATA%\Programs\clink\clink_x64.exe" autorun uninstall
aih shell remove --shell cmd
rmdir /s /q "%LOCALAPPDATA%\Programs\clink"
```

`aih shell remove --shell cmd` 只删除 `aih.lua`；AutoRun 与 Clink 目录由前两条命令清理。

## 7. 证据边界

- 已在真实 Windows cmd + 真实 Clink 上按键验证；不是 mock，也没有新增测试文件。
- `cmd` 无 Clink 时仍不支持参数补全；`aih shell status --shell cmd` 会明确报告未找到 Clink。
- AutoRun 只影响新启动的 cmd；已打开的窗口需要重开。
- Clink 升级/移动安装目录后 AutoRun 路径可能失效，需要重新执行 `clink autorun install`。
