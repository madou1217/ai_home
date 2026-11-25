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
   - Claude：CLI 未登录；本轮没有启动已安装的 Windows 服务，另用临时 server 验证了资源层（见 6）。
   - Codex：`codex.exe` 提示与当前 Windows 版本不兼容，无法运行。
   - CodeBuddy / CodeBuddy CN：未安装。
   - 因此 Windows 的 Provider 结论只覆盖 Gemini 的 Junction；不能外推到所有 Provider。

5. **默认仍复制，新增可选 link 投影。**
   - `skillDirProjection` 保留为默认；`skillLinkProjection` 把 Provider 目录指向
     `managed-resources/skills/<digest>` 共享快照。
   - 入口：`aih skill install <dir> --provider <id> --link`，或 WebUI 安装时勾选「使用链接投影」。
   - 生命周期实测（macOS + Gemini）：link 安装 → symlink；disable 只删链接、快照保留；
     enable 重建链接；remove 删除链接；已有的托管复制目录在 digest 一致时可迁移为链接。
   - Windows 复用 `artifactstore.CreateDirLink`（FSCTL junction）；交叉编译的 Windows
     artifactstore 测试在真机通过：CreationAndPassthrough / RemoveAllKeepsTarget /
     RenameSemantics / Dangling。
   - Windows 端到端（CLI + Gemini，Windows 10.0.26300）：
     `aih-go.exe skill install ... --provider gemini --link` 生成 Junction，
     `gemini skills list --all` 列出 `remote-realmachine`；disable / enable / remove
     均正常，remove 后链接消失、快照保留。
   - 现有 codex/claude 的 `remote-realmachine` 已从复制迁移为 link；两者的真实 TUI
     `/skills` 均能看到 `remote-realmachine`。

6. **Windows Server / WebUI 端到端已验证（临时 server）。**
   - 新构建 Windows `aih-server.exe`，使用临时 AIH_HOME + 复制的 DB，监听 9530，
     `--web-dir` 指向当前 WebUI 构建产物。
   - Server API：`POST /v1/management/webui/toolkit/native-resources`
     `{kind:"skill",action:"install",source:"assets/provider-skills/remote-realmachine",
     provider:"gemini",link:true}` 返回 `mode:"link"`；目标为 Junction，
     `gemini skills list --all` 能列出。
   - WebUI：通过 SSH 隧道打开 9530 的 `/ui`，在「开发工具 → 插件与资源 → Skill →
     安装资源」选择源与 Gemini，勾选「使用链接投影」并安装；卡片显示 `gemini · 已启用`，
     目标仍是 Junction，Gemini 能发现。
   - 清理：API remove 后链接消失，Gemini 列表只剩原有 `codex`；临时 server 和临时根目录已删除。
   - 范围：这是临时 server + 当前 dist 的端到端验证，不是 Windows 已安装服务/开机自启实例。

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
