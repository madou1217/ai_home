'use strict';

// Provider 权限参数目录（**语义与展示**的唯一事实源）。
//
// 分工：
//   * Go 合同 `nativeBoundary.permissions` 回答「这个 provider 有哪些权限旗标/模式」，
//     `lib/providers/permission-profiles.js` 从合同推导默认最大权限；
//   * 本文件回答合同回答不了的三件事：**取值枚举、互斥关系、中文说明与用法示例**。
//
// 为什么不写进 Go 合同：合同是能力边界（哪些旗标存在），而取值枚举/互斥/文案会随
// CLI 小版本变化且只服务于展示与参数校验。放这里可以逐条标注「已实测 / 未实测」，
// 不需要为了改一句文案去重新生成合同投影。
//
// 纪律：
//   * 只记录**实测**结论。没实测的互斥不写（宁可漏拦，不可误拦）。
//   * 每个 provider 的 `flags` 只列真实存在于 `--help` 的旗标；实测版本见 `verifiedCliVersion`。
//   * `conflicts` 用**规范旗标名**（不含别名），别名在 `flags[].aliases` 里声明，
//     判定时先归一化，所以 `-a` 与 `--ask-for-approval` 视为同一个旗标。
//   * `overrides` 与 `conflicts` 语义不同：conflicts = 上游直接报错拒绝；overrides = 上游接受
//     但后者覆盖前者（不拦截，但要在 UI 上说清楚）。

/** @typedef {{flag: string, aliases?: string[], group: string, value?: 'none'|'value'|'list', options?: string[], zh: string, en: string, example?: string, configEquivalent?: string, note?: string}} PermissionFlag */

const GROUPS = Object.freeze({
  sandbox: '沙箱',
  approval: '审批',
  bypass: '全放行',
  allow: '工具白名单',
  deny: '工具黑名单',
  policy: '策略文件'
});

/**
 * 每个 provider 的权限参数目录。
 *
 * `verifiedCliVersion` 是这份目录被对照核实的 CLI 版本；升级 CLI 后按
 * `docs/providers/agent-cli-usage.md` 的流程刷新，再回来核对这里的旗标与取值。
 */
const PERMISSION_FLAG_CATALOG = Object.freeze({
  codex: Object.freeze({
    verifiedCliVersion: '0.163.0',
    subcommandsWithoutApprovalFlag: Object.freeze(['exec']),
    // codex-cli 0.163.0：resume/fork 一旦走远程 app-server（aih 的本地 app-server 与
    // 网关续接两条链都会注入 --remote），上游就拒绝任何权限覆盖：
    //   "Permission overrides are not supported when resuming a remote task."
    // 见 docs/providers/cli-version-restrictions.md。恢复的会话沿用自己保存的权限，
    // 因此这两个子命令跳过注入 —— 不猜参数、不发注定被拒的组合。
    subcommandsBlockingPermissionOverrides: Object.freeze(['resume', 'fork']),
    // 找子命令位置时必须整对跳过的「带值旗标」，否则 `-c model=resume` 的值会被误认成子命令。
    subcommandFlagsWithValue: Object.freeze([
      '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
      '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile',
      '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'
    ]),
    flags: Object.freeze([
      {
        flag: '--sandbox',
        aliases: Object.freeze(['-s']),
        group: 'sandbox',
        value: 'value',
        options: Object.freeze(['read-only', 'workspace-write', 'danger-full-access']),
        zh: '沙箱策略：只读 / 可写工作区 / 完全放开（不沙箱）',
        en: 'Select the sandbox policy to use when executing model-generated shell commands',
        example: 'codex -s danger-full-access',
        configEquivalent: 'sandbox_mode = "danger-full-access"'
      },
      {
        flag: '--ask-for-approval',
        aliases: Object.freeze(['-a']),
        group: 'approval',
        value: 'value',
        options: Object.freeze(['on-request', 'never']),
        zh: '什么时候需要人工确认：由模型决定 / 从不询问',
        en: 'Configure when the model requires human approval before executing a command',
        example: 'codex -a never',
        configEquivalent: 'approval_policy = "never"',
        // 实测 codex-cli 0.163.0：`codex exec` 不接受 -a（`error: unexpected argument '-a' found`），
        // 只有 `codex` / `codex resume` 这层根命令认它。
        blockedInSubcommands: Object.freeze(['exec'])
      },
      {
        flag: '--approve-for-me',
        group: 'approval',
        value: 'none',
        zh: '把审批请求交给自动复核（自动使用 workspace-write 沙箱）',
        en: 'Route approval requests through automatic review using the workspace-write sandbox',
        example: 'codex --approve-for-me',
        note: '与 --sandbox / --ask-for-approval 互斥（实测上游直接报错）'
      },
      {
        flag: '--dangerously-bypass-approvals-and-sandbox',
        group: 'bypass',
        value: 'none',
        zh: '同时跳过全部确认与沙箱（危险：只应在外部已隔离的环境使用）',
        en: 'Skip all confirmation prompts and execute commands without sandboxing. EXTREMELY DANGEROUS',
        example: 'codex --dangerously-bypass-approvals-and-sandbox',
        note: '与 --ask-for-approval 互斥；与 --sandbox 并存时覆盖它（不报错）'
      },
      {
        flag: '--dangerously-bypass-hook-trust',
        group: 'bypass',
        value: 'none',
        zh: '不校验 hook 来源就直接运行（危险）',
        en: 'Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS',
        example: 'codex --dangerously-bypass-hook-trust',
        // 与「工具是否需要人工确认」无关：它只放开 hook 来源信任，因此不作为
        // 「用户已显式选择权限」的证据（否则会让默认最大权限被无谓地跳过）。
        permissionIntent: false
      }
    ]),
    // conflicts = 上游报错；overrides = 上游接受但后者覆盖前者。
    conflicts: Object.freeze([
      Object.freeze({
        a: '--approve-for-me',
        b: '--ask-for-approval',
        message: 'codex 的 --approve-for-me 与 -a/--ask-for-approval 不能同时使用'
      }),
      Object.freeze({
        a: '--approve-for-me',
        b: '--sandbox',
        message: 'codex 的 --approve-for-me 与 -s/--sandbox 不能同时使用'
      }),
      Object.freeze({
        a: '--dangerously-bypass-approvals-and-sandbox',
        b: '--ask-for-approval',
        message: 'codex 的 --dangerously-bypass-approvals-and-sandbox 与 -a/--ask-for-approval 不能同时使用'
      })
    ]),
    overrides: Object.freeze([
      Object.freeze({
        by: '--dangerously-bypass-approvals-and-sandbox',
        over: '--sandbox',
        message: '已选择全放行，--sandbox 会被它覆盖'
      })
    ])
  }),

  claude: Object.freeze({
    verifiedCliVersion: '2.1.306',
    flags: Object.freeze([
      {
        flag: '--permission-mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']),
        zh: '权限模式：默认 / 自动接受编辑 / 自动 / 全放行 / 手动 / 不询问 / 计划模式',
        en: 'Permission mode to use for the session',
        example: 'claude --permission-mode bypassPermissions',
        configEquivalent: 'permissions.defaultMode = "bypassPermissions"'
      },
      {
        flag: '--dangerously-skip-permissions',
        group: 'bypass',
        value: 'none',
        zh: '跳过全部权限检查（危险：只建议在无外网沙箱里用）',
        en: 'Bypass all permission checks. Recommended only for sandboxes with no internet access',
        example: 'claude --dangerously-skip-permissions'
      },
      {
        flag: '--allow-dangerously-skip-permissions',
        group: 'bypass',
        value: 'none',
        zh: '把「跳过权限检查」变成可选项，但默认不启用',
        en: 'Enable bypassing all permission checks as an option, without it being enabled by default',
        example: 'claude --allow-dangerously-skip-permissions'
      },
      {
        flag: '--allowedTools',
        aliases: Object.freeze(['--allowed-tools']),
        group: 'allow',
        value: 'list',
        zh: '免确认的工具名单（可写 Bash(git *) 这类规则）',
        en: 'Comma or space-separated list of tool names to allow',
        example: 'claude --allowedTools Read "Bash(git *)"'
      },
      {
        flag: '--disallowedTools',
        aliases: Object.freeze(['--disallowed-tools']),
        group: 'deny',
        value: 'list',
        zh: '禁用的工具名单',
        en: 'Comma or space-separated list of tool names to deny',
        example: 'claude --disallowedTools "Bash(rm *)"'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  gemini: Object.freeze({
    verifiedCliVersion: '0.65.0',
    flags: Object.freeze([
      {
        flag: '--approval-mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['default', 'auto_edit', 'yolo', 'plan']),
        zh: '审批模式：默认 / 自动接受编辑 / 全自动 / 计划（只读）',
        en: 'Set the approval mode: default, auto_edit, yolo, plan',
        example: 'gemini --approval-mode yolo'
      },
      {
        flag: '--yolo',
        aliases: Object.freeze(['-y']),
        group: 'bypass',
        value: 'none',
        zh: '自动接受所有操作（等价于 --approval-mode yolo）',
        en: 'Automatically accept all actions (aka YOLO mode)',
        example: 'gemini -y'
      },
      {
        flag: '--sandbox',
        aliases: Object.freeze(['-s']),
        group: 'sandbox',
        value: 'none',
        zh: '在沙箱里运行（与权限模式相互独立）',
        en: 'Run in sandbox?',
        example: 'gemini -s'
      },
      {
        flag: '--allowed-tools',
        group: 'allow',
        value: 'list',
        zh: '免确认的工具名单（官方已标记为弃用，改用策略引擎）',
        en: 'Tools that are allowed to run without confirmation [DEPRECATED: Use Policy Engine instead]',
        example: 'gemini --allowed-tools shell'
      },
      {
        flag: '--policy',
        group: 'policy',
        value: 'list',
        zh: '加载额外的策略文件或目录（逗号分隔或多次传入）',
        en: 'Additional policy files or directories to load',
        example: 'gemini --policy ./policy'
      },
      {
        flag: '--admin-policy',
        group: 'policy',
        value: 'list',
        zh: '加载管理员策略文件或目录',
        en: 'Additional admin policy files or directories to load',
        example: 'gemini --admin-policy ./admin-policy'
      }
    ]),
    conflicts: Object.freeze([
      Object.freeze({
        a: '--yolo',
        b: '--approval-mode',
        message: 'gemini 的 -y/--yolo 与 --approval-mode 不能同时使用，请改用 --approval-mode yolo'
      })
    ]),
    overrides: Object.freeze([])
  }),

  agy: Object.freeze({
    verifiedCliVersion: '1.4.0',
    flags: Object.freeze([
      {
        flag: '--dangerously-skip-permissions',
        group: 'bypass',
        value: 'none',
        zh: '不再询问，自动批准全部工具权限请求',
        en: 'Auto-approve all tool permission requests without prompting',
        example: 'agy --dangerously-skip-permissions',
        configEquivalent: 'toolPermission = "always-proceed"'
      },
      {
        flag: '--mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['accept-edits', 'auto', 'plan']),
        zh: '执行模式：自动接受编辑 / 全自动 / 计划',
        en: 'Set the agent execution mode for this session',
        example: 'agy --mode auto'
      },
      {
        flag: '--sandbox',
        group: 'sandbox',
        value: 'none',
        zh: '在带终端限制的沙箱里运行',
        en: 'Run in a sandbox with terminal restrictions enabled',
        example: 'agy --sandbox'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  opencode: Object.freeze({
    verifiedCliVersion: '2.1.1',
    flags: Object.freeze([
      {
        flag: '--auto',
        group: 'bypass',
        value: 'none',
        zh: '自动批准未被显式拒绝的权限',
        en: 'Auto-approve permissions that are not explicitly denied',
        example: 'opencode run --auto "解释这个仓库"',
        configEquivalent: 'permission = "allow"'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  grok: Object.freeze({
    verifiedCliVersion: '1.0.46',
    flags: Object.freeze([
      {
        flag: '--permission-mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan']),
        zh: '权限模式',
        en: 'Permission mode',
        example: 'grok --permission-mode auto'
      },
      {
        flag: '--always-approve',
        group: 'bypass',
        value: 'none',
        zh: '自动批准全部工具执行',
        en: 'Auto-approve all tool executions',
        example: 'grok --always-approve'
      },
      {
        flag: '--allow',
        aliases: Object.freeze(['--allowedTools']),
        group: 'allow',
        value: 'value',
        zh: '权限放行规则（可重复传入）',
        en: 'Permission allow rule (compat alias: --allowedTools)',
        example: 'grok --allow "Bash(git *)"'
      },
      {
        flag: '--deny',
        aliases: Object.freeze(['--disallowedTools']),
        group: 'deny',
        value: 'value',
        zh: '权限拒绝规则（可重复传入）',
        en: 'Permission deny rule (compat alias: --disallowedTools)',
        example: 'grok --deny "Bash(rm *)"'
      },
      {
        flag: '--sandbox',
        group: 'sandbox',
        value: 'value',
        zh: '文件系统与网络的沙箱档位',
        en: 'Sandbox profile for filesystem and network access',
        example: 'grok --sandbox workspace-write'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  kimi: Object.freeze({
    verifiedCliVersion: '2.2.0',
    flags: Object.freeze([
      {
        flag: '--yolo',
        aliases: Object.freeze(['-y']),
        group: 'approval',
        value: 'none',
        zh: '「需要时再问」：常规编辑与命令自动执行，高风险操作仍会询问',
        en: 'Start in Ask When Needed mode: routine edits and commands run automatically',
        example: 'kimi -y'
      },
      {
        flag: '--auto',
        group: 'bypass',
        value: 'none',
        zh: '「从不询问」：所有操作自动执行并自动决定',
        en: 'Start in Never Ask mode: never interrupts you',
        example: 'kimi --auto'
      }
    ]),
    conflicts: Object.freeze([
      Object.freeze({
        a: '--yolo',
        b: '--auto',
        message: 'kimi 的 -y/--yolo 与 --auto 不能同时使用'
      })
    ]),
    overrides: Object.freeze([])
  }),

  qoder: Object.freeze({
    verifiedCliVersion: '1.1.74',
    flags: Object.freeze([
      {
        flag: '--permission-mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto']),
        zh: '权限模式（注意取值用下划线，与 claude 不同）',
        en: 'Set the permission mode',
        example: 'qodercli --permission-mode bypass_permissions'
      },
      {
        flag: '--dangerously-skip-permissions',
        group: 'bypass',
        value: 'none',
        zh: '跳过全部权限检查',
        en: 'Bypass all permission checks',
        example: 'qodercli --dangerously-skip-permissions'
      },
      {
        flag: '--allowed-tools',
        group: 'allow',
        value: 'list',
        zh: '允许的工具名单',
        en: 'Tools to allow',
        example: 'qodercli --allowed-tools Read'
      },
      {
        flag: '--disallowed-tools',
        group: 'deny',
        value: 'list',
        zh: '禁用的工具名单',
        en: 'Tools to deny',
        example: 'qodercli --disallowed-tools "Bash(rm *)"'
      },
      {
        flag: '--tools',
        group: 'allow',
        value: 'list',
        zh: '限定可用内置工具（"" 全关，"default" 全开）',
        en: 'Restrict available built-in tools',
        example: 'qodercli --tools Read,Edit'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  codebuddy: Object.freeze({
    verifiedCliVersion: 'unknown',
    flags: Object.freeze([
      {
        flag: '--permission-mode',
        group: 'approval',
        value: 'value',
        options: Object.freeze(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan']),
        zh: '权限模式（不写入设置文件）',
        en: 'Default permission mode for this process',
        example: 'codebuddy --permission-mode bypassPermissions'
      },
      {
        flag: '--dangerously-skip-permissions',
        aliases: Object.freeze(['-y']),
        group: 'bypass',
        value: 'none',
        zh: '跳过权限提示（HIGH/CRITICAL 仍会询问）',
        en: 'Bypass permission prompts (HIGH/CRITICAL still ask)',
        example: 'codebuddy -y'
      },
      {
        flag: '--allowedTools',
        aliases: Object.freeze(['--allowed-tools']),
        group: 'allow',
        value: 'list',
        zh: '允许的工具名单',
        en: 'Comma or space-separated list of tool names to allow',
        example: 'codebuddy --allowedTools Read'
      },
      {
        flag: '--disallowedTools',
        aliases: Object.freeze(['--disallowed-tools']),
        group: 'deny',
        value: 'list',
        zh: '禁用的工具名单',
        en: 'Comma or space-separated list of tool names to deny',
        example: 'codebuddy --disallowedTools "Bash(rm *)"'
      },
      {
        flag: '--tools',
        group: 'allow',
        value: 'list',
        zh: '限定内置工具（"" 全关，"default" 全开）',
        en: 'Restrict which built-in tools CodeBuddy can use',
        example: 'codebuddy --tools Read,Edit'
      },
      {
        flag: '--sandbox',
        group: 'sandbox',
        value: 'value',
        zh: '在容器 / 远程沙箱里运行（与权限模式独立）',
        en: 'Run CodeBuddy in sandbox',
        example: 'codebuddy --sandbox container'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  }),

  kiro: Object.freeze({
    verifiedCliVersion: '2.32.0',
    flags: Object.freeze([
      {
        flag: '--trust-all-tools',
        aliases: Object.freeze(['-a']),
        group: 'bypass',
        value: 'none',
        zh: '允许模型使用任何工具执行命令而不请求确认',
        en: 'Allows the model to use any tool to run commands without asking for confirmation',
        example: 'kiro-cli chat --trust-all-tools',
        note: '属于 chat 子命令；写在根命令或其它子命令下会被拒（kiro-cli -a 退出码 2）'
      },
      {
        flag: '--trust-tools',
        group: 'allow',
        value: 'list',
        zh: '只信任名单里的工具（`--trust-tools=` 表示一个都不信任）',
        en: 'Trust only this set of tools',
        example: "kiro-cli chat --trust-tools=fs_read,fs_write",
        note: '部分信任版本：与 --trust-all-tools 二选一'
      }
    ]),
    conflicts: Object.freeze([]),
    overrides: Object.freeze([])
  })
});

// 家族成员共用同一份参数目录：声明归属，避免每个家族成员各抄一份。
const CATALOG_ALIASES = Object.freeze({
  qodercn: 'qoder',
  codebuddycn: 'codebuddy',
  workbuddy: 'codebuddy',
  workbuddycn: 'codebuddy'
});

const EMPTY_CATALOG = Object.freeze({ verifiedCliVersion: 'none', flags: Object.freeze([]), conflicts: Object.freeze([]), overrides: Object.freeze([]) });

function resolveCatalogProvider(providerRaw) {
  const provider = String(providerRaw || '').trim().toLowerCase();
  return CATALOG_ALIASES[provider] || provider;
}

/** 某个 provider 的权限参数目录；没有登记的返回空目录（不是异常）。 */
function getPermissionFlagCatalog(providerRaw) {
  return PERMISSION_FLAG_CATALOG[resolveCatalogProvider(providerRaw)] || EMPTY_CATALOG;
}

/** 规范旗标名 → 该旗标的全部写法（含短旗标与兼容别名）。 */
function buildAliasIndex(catalog) {
  const index = new Map();
  for (const entry of catalog.flags || []) {
    const forms = [entry.flag, ...(entry.aliases || [])];
    for (const form of forms) index.set(form, entry.flag);
  }
  return index;
}

/**
 * 「用户是否显式表达过权限意图」用到的旗标集合。
 *
 * `permissionIntent: false` 的条目（例如 codex 的 --dangerously-bypass-hook-trust）
 * 与工具确认无关，出现在这里会让默认注入被无谓跳过，因此排除。
 */
function listPermissionIntentFlagForms(providerRaw) {
  const catalog = getPermissionFlagCatalog(providerRaw);
  const forms = [];
  for (const entry of catalog.flags || []) {
    if (entry.permissionIntent === false) continue;
    forms.push(entry.flag, ...(entry.aliases || []));
  }
  return forms;
}

/**
 * 规范化 argv 里的权限旗标：返回 [{canonical, raw, value}]。
 * 值型旗标的取值有两种写法（`--k v` 与 `--k=v`），两种都要认。
 */
function collectPresentFlags(providerRaw, argv) {
  const catalog = getPermissionFlagCatalog(providerRaw);
  const aliases = buildAliasIndex(catalog);
  const byCanonical = new Map((catalog.flags || []).map((entry) => [entry.flag, entry]));
  const present = [];
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] === undefined || list[index] === null ? '' : list[index]);
    if (!token.startsWith('-')) continue;
    const eqIndex = token.indexOf('=');
    const name = eqIndex > 0 ? token.slice(0, eqIndex) : token;
    const canonical = aliases.get(name);
    if (!canonical) continue;
    const entry = byCanonical.get(canonical) || { value: 'none' };
    let value = eqIndex > 0 ? token.slice(eqIndex + 1) : '';
    if (!value && entry.value && entry.value !== 'none') {
      const next = list[index + 1];
      if (next !== undefined && next !== null && !String(next).startsWith('-')) {
        value = String(next);
        index += 1;
      }
    }
    present.push({ canonical, raw: name, value });
  }
  return { catalog, present };
}

/**
 * 找出 argv 里互相冲突的权限旗标（同一次启动里不允许同时出现）。
 *
 * 唯一判定入口：装配侧（启动前拦截）与 WebUI（互斥项禁用）都调这里，
 * 因此不存在「界面禁用了、命令行还能发出去」的错位。
 */
function findPermissionConflicts(providerRaw, argv) {
  const { catalog, present } = collectPresentFlags(providerRaw, argv);
  const seen = new Set(present.map((item) => item.canonical));
  const conflicts = [];
  for (const rule of catalog.conflicts || []) {
    if (!seen.has(rule.a) || !seen.has(rule.b)) continue;
    conflicts.push({
      provider: String(providerRaw || '').trim().toLowerCase(),
      a: rule.a,
      b: rule.b,
      message: rule.message
    });
  }
  return conflicts;
}

/**
 * 从 argv 里摘掉某类旗标（连同它的取值），返回新 argv 与被摘掉的旗标名。
 *
 * 用途：`codex resume/fork` 一旦走远程 app-server（aih 在自己的续接链里注入
 * `--remote`），上游就拒绝一切权限覆盖并直接报错。调用方在注入 `--remote`
 * **之前**用这里摘掉权限旗标，组合就永远不会被发出去；被摘掉的旗标要如实告知用户。
 */
function stripFlags(providerRaw, argv, predicate) {
  const catalog = getPermissionFlagCatalog(providerRaw);
  const aliases = buildAliasIndex(catalog);
  const byCanonical = new Map((catalog.flags || []).map((entry) => [entry.flag, entry]));
  const list = Array.isArray(argv) ? argv : [];
  const kept = [];
  const removed = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] === undefined || list[index] === null ? '' : list[index]);
    const eqIndex = token.indexOf('=');
    const name = eqIndex > 0 ? token.slice(0, eqIndex) : token;
    const canonical = aliases.get(name);
    if (!canonical || !predicate(canonical)) {
      kept.push(list[index]);
      continue;
    }
    removed.push(name);
    const entry = byCanonical.get(canonical) || { value: 'none' };
    // `--k=v` 自体就是一对；`--k v` 还要连带吃掉后面那个值。
    if (eqIndex <= 0 && entry.value && entry.value !== 'none' && index + 1 < list.length) {
      index += 1;
    }
  }
  return { args: kept, removed };
}

/** 摘掉全部「表达权限意图」的旗标（保留 permissionIntent:false 的条目）。 */
function stripPermissionIntentFlags(providerRaw, argv) {
  return stripFlags(providerRaw, argv, (canonical) => {
    const catalog = getPermissionFlagCatalog(providerRaw);
    const entry = (catalog.flags || []).find((item) => item.flag === canonical);
    return Boolean(entry) && entry.permissionIntent !== false;
  });
}

/** 被覆盖（不报错）的组合：只用于提示，不拦截。 */
function findPermissionOverrides(providerRaw, argv) {
  const { catalog, present } = collectPresentFlags(providerRaw, argv);
  const seen = new Set(present.map((item) => item.canonical));
  return (catalog.overrides || [])
    .filter((rule) => seen.has(rule.by) && seen.has(rule.over))
    .map((rule) => ({ provider: String(providerRaw || '').trim().toLowerCase(), ...rule }));
}

/** 可供 WebUI 渲染的完整目录（按 group 分组，附带互斥关系）。 */
function describePermissionCatalog(providerRaw) {
  const catalog = getPermissionFlagCatalog(providerRaw);
  return {
    verifiedCliVersion: catalog.verifiedCliVersion || 'none',
    groups: GROUPS,
    flags: (catalog.flags || []).map((entry) => ({
      flag: entry.flag,
      aliases: [...(entry.aliases || [])],
      group: entry.group,
      groupLabel: GROUPS[entry.group] || entry.group,
      value: entry.value || 'none',
      options: [...(entry.options || [])],
      description: entry.zh,
      descriptionEn: entry.en,
      example: entry.example || '',
      configEquivalent: entry.configEquivalent || '',
      note: entry.note || ''
    })),
    conflicts: (catalog.conflicts || []).map((rule) => ({
      a: rule.a,
      b: rule.b,
      message: rule.message
    })),
    overrides: (catalog.overrides || []).map((rule) => ({
      by: rule.by,
      over: rule.over,
      message: rule.message
    })),
    subcommandsWithoutApprovalFlag: [...(catalog.subcommandsWithoutApprovalFlag || [])],
    subcommandsBlockingPermissionOverrides: [...(catalog.subcommandsBlockingPermissionOverrides || [])]
  };
}

/**
 * 校验一组「目录里的参数」（WebUI 提交的选择）：旗标必须登记、值型旗标的取值必须在枚举内、
 * 组合不得互斥。写入与启动两个入口都过这里，避免界面能存进去、启动时才炸。
 */
function validatePermissionArgs(providerRaw, args) {
  const catalog = getPermissionFlagCatalog(providerRaw);
  const aliases = buildAliasIndex(catalog);
  const byCanonical = new Map((catalog.flags || []).map((entry) => [entry.flag, entry]));
  const list = Array.isArray(args) ? args.map((item) => String(item === undefined || item === null ? '' : item)) : [];
  const unknown = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (!token.startsWith('-')) continue;
    const eqIndex = token.indexOf('=');
    const name = eqIndex > 0 ? token.slice(0, eqIndex) : token;
    const canonical = aliases.get(name);
    if (!canonical) {
      unknown.push(name);
      continue;
    }
    const entry = byCanonical.get(canonical);
    if (!entry || (entry.value || 'none') === 'none') continue;
    const value = eqIndex > 0 ? token.slice(eqIndex + 1) : String(list[index + 1] || '');
    if ((entry.value || 'none') === 'value' && eqIndex <= 0) index += 1;
    if (!Array.isArray(entry.options) || entry.options.length === 0) continue;
    if (!entry.options.includes(value)) {
      unknown.push(`${name}=${value}`);
    }
  }
  const conflicts = findPermissionConflicts(providerRaw, list);
  return { ok: unknown.length === 0 && conflicts.length === 0, unknown, conflicts };
}

module.exports = {
  PERMISSION_FLAG_CATALOG,
  PERMISSION_FLAG_GROUPS: GROUPS,
  getPermissionFlagCatalog,
  describePermissionCatalog,
  collectPresentFlags,
  findPermissionConflicts,
  findPermissionOverrides,
  listPermissionIntentFlagForms,
  stripFlags,
  stripPermissionIntentFlags,
  validatePermissionArgs
};
