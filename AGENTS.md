# Repository Guidelines

> This is the single source of truth for agent/contributor guidance in this repo. `CLAUDE.md` intentionally links here instead of duplicating content.
  
## Coding Style & Naming Conventions
- Main body (`lib/`): Node.js CommonJS (`require`, `module.exports`).
- Formatting style in repo: 2-space indentation, semicolons, single quotes.
- File names use kebab-case (for example `account-import-orchestrator.js`).
- Prefer small, composable functions; avoid feature growth in one large file.
- `web/`: TypeScript + React 18 + Ant Design + Umi Max (Webpack build), ESM.

## UI Visual Constraints
- 全局禁止使用大面积的告警/提示块作为页面主内容，包括黄色、蓝色或灰色的整块 `Alert` 卡片；保留无障碍语义，但统一使用紧凑的行内状态、标签或操作旁说明。
- 全局禁止在卡片、状态项、导航项和列表项上使用粗左侧彩色竖条、`border-left` 装饰条或等价的 `inset` 强调条；状态应通过背景、完整边框、图标、标签或留白表达。
- 新增或修改页面必须遵守上述规则，并通过真实页面检查确认不存在大块提示容器和左侧粗竖条。1px 的功能性分隔线仅可用于明确的控件分界，不得作为状态装饰。
- 账号列表及各管理卡片的操作按钮必须保持语义化功能图标（例如 Desktop 使用 `DesktopOutlined`、CLI 使用 `CodeOutlined` 等），严禁将其替换为 Provider 厂商 Logo（`ProviderIcon`），避免与主体厂商图标重复混淆导致失去操作语义。

## Architecture & Layering Principles
- Enforce separation of concerns: each module should have one clear responsibility (composition, domain logic, integration, or I/O).
- Keep orchestration and business logic separate. Flow control modules should delegate behavior to focused service modules.
- Depend inward on abstractions, not outward on concrete implementation details. Avoid circular dependencies across layers.
- Add new behavior by extending focused modules, not by growing “god files.”
- Refactor trigger: if a file mixes unrelated responsibilities or becomes difficult to test in isolation, split it before further feature work.
- Exceptions must be explicit in PR notes, including why boundary-preserving design was not feasible and what follow-up refactor is planned.

 
 
- Treat `advisor` as a workflow intent (`independent_review_intent`), not as a guaranteed concrete tool name.
- Never hard-fail solely because a copied Claude/Antigravity prompt references an unavailable `advisor` tool. Resolve the intent through the runtime capability chain first.
- Resolution order: `reviewer_subagent` -> `native_review` -> `self_review` -> `plan_check` -> `warning_noop`.
- `warning_noop` must be explicit and observable; do not silently skip review semantics.
- For high-risk operations (commit, push, destructive file/database changes, production API calls, permission/config mutation), missing reviewer/advisor capability must trigger explicit human confirmation or a documented bypass.
- Keep this compatibility in a focused adapter/resolver layer. Do not scatter `advisor`/`review` string replacements across provider launch code, protocol routers, or prompt templates.
- Preferred design: map runtime-specific tool names into stable workflow intents, then map those intents to the current provider's available capability. Tool aliases handle executable tools; workflow aliases handle stages such as plan, review, self-verify, and advisor.
- Preserve the canonical protocol direction: client protocol -> canonical request/intent -> account/model router -> upstream/provider adapter -> canonical result/events -> client renderer.

## Design Pattern Discipline 
  

## Git Worktree & Branch Safety
- **Only `main` may be kept long-term.** Do not keep feature branches around: once work lands on `main`, delete the temporary branch. Never leave commits that exist only on a side branch or a detached HEAD.
- **Worktrees are the preferred isolation mechanism**（用户 2026-11-20 明确，替代原先的禁用声明）：需要在不含其他会话未提交改动的树上构建/验收时，用 `git worktree add` —— 它共享对象库，不复制字节。把它建在系统临时目录，任务结束后按下面第 44–47 行核对后清理。不要退回"整棵树复制/解包"的老办法（见 Working Copy & Evidence Discipline）。
- If a worktree is used, it must not be released (removed/pruned) until all of its commits have been merged into the main project's `main`. Verify with `git cherry main <worktree-head>` (or `git log main..<head>`) that nothing remains before releasing it.
- Resolve integration inside the worktree first: rebase/merge `main` into the worktree branch and resolve conflicts there, run tests there, so landing on `main` in the primary workspace is a clean fast-forward (or trivial merge) with minimal conflict probability.
- Before merging or cherry-picking from an existing worktree or branch, inspect its status, commit divergence, and diff scope; report the proposed source and affected files first.
- Treat pruning or deleting worktrees as a destructive cleanup step; ask for explicit approval before running it.
- **Never discard local unpushed commits.** When a rebase hits conflicts, prefer `git rebase --abort` and re-plan; never `git reset --hard origin/main` (or any hard reset) while the branch carries unpushed work. Before any destructive history operation, tag the current HEAD as a backup (e.g. `backup/<date>-<topic>`) and confirm the operation with the user.
  - Background: on 2026-08-14 a session aborted a conflicting rebase and then ran `reset --hard origin/main`, silently dropping 13 local commits (~17k insertions, including the full kimi integration) plus leaving a 3k-line stash. Recovery cost far exceeded the merge it was trying to avoid.
- When multiple agent sessions share this repository, each session must assume another session may hold unpushed commits; check `git reflog` for recent `reset`/`rebase` operations before rewriting history, and never reset past commits you did not create.
- **提交时必须带 pathspec（本仓库实测教训，2026-10-16）**：并行会话经常把文件留在**暂存区**，`git commit` 会把它们一并带走（表现为提交里混入不相干的文件、提交信息对不上）。因此一律用 `git commit -m <msg> -- <显式路径...>`（或先 `git add -- <路径>` 后 `git commit -- <路径>`），**禁止裸 `git commit` / `git add -A`**。已经混入的提交不要用 rebase/reset 去"修正"（那是破坏性历史操作，见上），在当次汇报里如实说明即可。
- **提交前后必须核对暂存区内容（2026-10-23 两次事故）**：`git diff --cached --stat` 是提交前的**强制步骤**——文件数与行数要对得上这次改的范围，对不上就停下查，不要提交。两次事故都不是裸 commit：
  - 用 `GIT_INDEX_FILE` 临时索引准备提交后，又跑了一次**不带临时索引**的 `git commit --amend`（改提交信息）；amend 重新读取了主索引，于是把并行会话暂存的反向 diff 提交并推送了出去（37 个文件被回退，自己的改动反而没进去）。
  - 并行会话的 `git add -A` 把工作区里**过时的旧文件**一起暂存，提交时把另一条工作线整个 revert 掉（48 个文件、-2093 行）。
  - 结论：① 临时索引只用于**一次**提交，之后要改信息就重新走一遍完整流程，绝不在临时索引之外 amend；② `--amend` 前重新核对 `--cached --stat`，它和普通提交一样会重新读索引；③ 提交后 `git show --stat HEAD` 复核一次，确认没有多带文件；④ 发现带错文件时，用独立 worktree 在最新基点上**重建**自己的改动（`git checkout <好提交> -- <自己的文件>`），不要 reset/revert 别人的东西。
- **每个任务必须及时完成 scoped commit（用户 2026-11-18 明确）**：派发或续接任务时必须列明 owner、精确路径/共享文件 hunk、验证方式，以及本子阶段的 scoped commit 和推送交付要求。完成一个可审查的逻辑变更及其必需依赖后，由原 owner 及时显式路径提交，再推进下一工程子任务；`aih peer` 的派发、ACK、报告或“已完成”不能代替真实提交。未通过审查、尚在实现或用户已暂停的工作保留原状态，必须明确未提交路径、原因和下一处理条件，不为清空待提交跳过审查或擅自续工。
- **提交范围必须包含必需依赖并保留同伴改动**：提交前比较 HEAD、真实磁盘内容和 index，区分真正未提交改动与旧索引产生的反向 diff；不能把 `git status` 的路径数直接当成待提交成果。共享文件只提交本人已批准 hunk，不将 peer 内容、过时索引或未审新文件混入提交；禁止提交仍依赖未跟踪文件的代码。需要临时索引时从 fresh HEAD 准备，所有索引及提交命令使用同一 `GIT_INDEX_FILE`，提交后复核完整 tree/pathspec，并证明原主索引与同伴内容保持不变。
- **scoped commit；遇到推送网络问题，使用 AWS server 作为临时代理完成推送。** 本地提交不依赖网络，不因网络失败积压已验证的源码。优先复用项目代理池里高级设置已启用的 AWS 受管出口：通过 `GET /v1/management/proxy-candidates` 选择当前可用的 AWS `ssh:<connectionId>`，以 `POST /v1/management/proxy-leases` 取得本次任务租约；仅为本次 Git 进程配置代理，执行 `git push origin main`，核验远端 main 包含预期提交，并在结束/取消时 `DELETE /v1/management/proxy-leases/{id}`。远程管理连接使用现有 authenticated Upgrade/本机任务入口，不能把服务端 localhost 当作客户端地址。凭据不得进入命令参数、URL 日志或提交；不改全局 Git/SSH/系统代理及代理池全局选中节点，不另起常驻远端代理。
- **`git push` 在本仓库不属高风险操作**（用户 2026-10-15 明确）：本地提交可以直接 `git push origin main`，不必先征求确认（并发会话的本地提交会一并推上去，这是共享 main 的正常流程）。仍必须先确认的是**破坏性历史操作**（`git reset --hard`、丢弃提交的 rebase、删除 worktree/branch）——见上一条。

## Working Copy & Evidence Discipline

**整树副本是禁止的隔离手段**（worktree 现在是推荐手段，见上）。2026-11-20 排查本机 `~/.ai_home/run/`（当时 106G、59 个目录）发现：没有任何产品代码创建它们，全部是会话为了"在干净树上验证构建"手工 `git archive | tar -x` / `rsync` 出来的整棵源码树，再因为"证据要留在 run/"而长期不删。单会话最多在 `run/usage-perf-takeover-20261120/` 里堆了约 20 份 `source-exact-*` 副本。

- **禁止把整棵源码树复制/解包到任何持久位置**（`~/.ai_home`、仓库目录、`run/` 下都算）。包括 `git archive`、`rsync`、`cp -a`、`git clone`→拷贝。需要隔离工作区时用 `git worktree`（共享对象库、不复制字节，见上面的 Worktree 规则）。
- **需要"干净树"验证构建时**：在系统临时目录建一次性树（`mktemp -d`），于同一会话内构建完成后立即删除；不要把临时树搬进 `run/` 当证据。
- **证明"某提交能否独立构建"**：记录 `git rev-parse <commit>`、`git archive <commit> | sha256sum` 的归档摘要、构建命令、exit code 与产物 `sha256`。归档摘要已经唯一确定字节，**不需要**再留一份解压树来"证明"。
- **证据目录只放不可再生的东西**：清单、日志、截图、哈希、验收结论、外部抓取。禁止放源码树、`node_modules`、`web/dist`、发行包解压目录。构建产物只保留产物本身与 `BUILD_INFO`，不保留来源树。
- **产品自身的目录不在此禁令内**：`run/auth-projections`（账号投影）、`run/chat-workspaces`（网页会话工作目录，`chatruntime/runtime_target.go`）、`run/remote-workspaces`、`run/provider-session-state`、`run/releases` 等是运行时数据，不得当成"垃圾副本"删除；清理只能针对缓存与旧包。
- **清理既有残留**：删除 `run/` 下整树副本前，先确认没有进程持有（`lsof`/`/proc/*/cwd`）、且不属于活跃线程；活跃线程的证据目录保留并转交该 owner。

## Commit & Pull Request Guidelines
- Follow conventional-style messages seen in history: `feat(...)`, `fix(...)`, `refactor(...)`.
- Keep commits focused (one logical change per commit).
- PRs should include:
  - purpose and scope,
  - key files changed,
  - test evidence (commands + pass result),
  - screenshots/log snippets for CLI UX changes when relevant.

## Security & Configuration Tips
- Never commit real tokens or credential exports.
- Validate import paths and avoid absolute/parent traversal inputs.
- Prefer environment-based configuration for sensitive runtime settings.


#
永远不要退回别人的(并行的session)代码 
#
不要写任何测试用例 . 如果要测试就真实测试
