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

2. **Gemini 0.70.0 已实测支持软链接 Skill 目录。**
   - 命令：`gemini skills link /tmp/aih-symlink-probe-skill --consent`
   - 结果：生成 `<HOME>/.gemini/skills/symlink-probe -> /tmp/aih-symlink-probe-skill`
     （`lrwxr-xr-x`），`gemini skills list --all` 能发现并列出该 Skill。
   - 清理：`gemini skills uninstall symlink-probe` 删除链接，源目录不受影响。
   - 这说明“软链接一定不兼容”的说法不成立；至少 Gemini 的原生 Skill 管理层支持链接。

3. **待补验证。**
   - Claude Code 2.1.331：直接 `claude --debug -p` 探针因当前环境未登录被阻断
     （`Not logged in · Please run /login`），需要在已登录的 AIH 工作区会话里复测。
   - Codex / CodeBuddy / WorkBuddy：未找到等价的 `skills list` 命令，需要构造
     真实会话探针，或从 provider 代码/文档确认链接跟随行为。
   - 在完成逐 Provider 验证前，不把软链接作为默认投影；当前仍保留复制投影。

## 后续设计输入

- 若主流 Provider 都跟随符号链接，可把通用 Skill 投影改成 link store：
  共享一份实体，Provider 目录只放链接或 junction；停用即移除链接。
- Windows 需要单独验证 junction/symlink 权限；不能直接用 Unix symlink 结论外推。
- 接管逻辑可复用为“导入已有 Skill 目录”的入口，避免用户手工搬目录。
