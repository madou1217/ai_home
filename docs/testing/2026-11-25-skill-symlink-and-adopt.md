# Skill 接管与软链接兼容性验证（2026-11-25）

## 结论

1. **接管未托管目录已实现并实测。**
   - API：`POST /v1/management/webui/toolkit/native-resources`
     `{kind:"skill", action:"adopt", provider:"claude", id:"remote-realmachine"}`
   - CLI：`aih skill adopt remote-realmachine --provider claude`
   - 实测对象：`~/.claude/skills/remote-realmachine`（此前无 DB 记录）。
   - 结果：生成 claude 托管记录并启用；`SKILL.md` 的 mtime 与 sha256 前后一致，
     说明接管只认领、不重写文件。UI 的 Skill 卡片出现 `claude · 已启用`，
     `aih skill doctor --provider claude` 返回 healthy。
   - `install` 指向与目标目录内容一致的源时也会自动接管（同一 digest 校验）；
     内容不一致仍返回 `skill_target_conflict`，不覆盖。

2. **软链接 Skill 已按真实 TUI `/skills` 验证（macOS）。**

   | Provider | 版本 | 放置位置 | 结果 |
   | --- | --- | --- | --- |
   | Claude Code | 2.1.331 | 项目 `.claude/skills/probe-link -> /tmp/...` | `/skills` 列出 `probe-link` |
   | Codex | 0.172.0 | 用户 `~/.codex/skills/symlink-probe -> /tmp/...` | `/skills -> List skills` 列出 `symlink-probe` |
   | CodeBuddy | 2.186.0 | 项目 `.codebuddy/skills/probe-link -> /tmp/...` | `/skills` 列出 `symlink-probe` |
   | CodeBuddy CN | 2.186.0 | 项目 `.codebuddy/skills/probe-link -> /tmp/...` | `/skills` 列出 `symlink-probe` |
   | Gemini | 0.70.0 | `gemini skills link ... --consent` | `skills list --all` 列出 `symlink-probe` |

   测试均通过 `aih claude relay` / `aih codex relay` / `aih codebuddy relay` /
   `aih codebuddycn relay` 启动真实 TUI；测试后已退出会话并删除探针。

3. **Windows 上 Gemini 的 link 实际创建 Junction，并能被识别。**
   - 主机：Windows 10.0.26300。
   - `gemini skills link C:\Users\madou\aih-symlink-probe-skill --consent`
     生成 `C:\Users\madou\.gemini\skills\symlink-probe`，LinkType 为 `Junction`。
   - `gemini skills list --all` 列出 `symlink-probe`；卸载后 Junction 删除，目标目录不受影响。

4. **Windows 其余 Provider 未完成验证。**
   - Claude：CLI 未登录，Windows 上的 AIH Server 未运行，无法启动真实会话。
   - Codex：`codex.exe` 提示与当前 Windows 版本不兼容，无法运行。
   - CodeBuddy / CodeBuddy CN：未安装。
   - 因此 Windows 结论只覆盖 Gemini 的 Junction；不能外推到所有 Provider。

5. **当前 AIH 仍使用复制投影。**
   - `skillDirProjection` 仍把软链接判为 conflict；接管只解决“已有真实目录”的认领。
   - 要把通用 Skill 改成 link store，需要按 Provider/OS 设计：
     共享实体 + 每 Provider 链接/junction；停用即移除链接；
     Windows 需显式创建 Junction（`os.Symlink` 不是 junction）；
     现有复制投影需要迁移策略。

## 测试方法

- macOS：在项目或用户 skills 目录放一个真实目录和一个符号链接，启动对应 AIH relay TUI，
  执行 `/skills` 查看是否出现 `probe-link` / `symlink-probe`。
- Windows：用 `gemini skills link` 让 Provider 自己创建链接，`gemini skills list --all`
  验证发现，PowerShell `Get-Item ... LinkType` 验证是 Junction。
- 所有探针会话使用独立 tmux socket，结束后只关闭自己的会话；探针目录和链接均删除。

## 后续设计输入

- 若要把复制改成链接，先做 Provider × OS 支持矩阵；当前证据支持
  macOS 的 Claude/Codex/CodeBuddy/CodeBuddyCN/Gemini，以及 Windows 的 Gemini Junction。
- Windows 需要单独验证 Claude/Codex/CodeBuddy 对 Junction 的跟随行为，再决定默认策略。
- 接管逻辑可复用为“导入已有 Skill 目录”的入口，避免用户手工搬目录。
