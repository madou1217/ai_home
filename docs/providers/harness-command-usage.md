# 外部 harness 的统一命令面（aih 托管）

> 外部 harness **不是** AIH Gateway provider：它们没有上游协议、没有账号池，由 aih 直接
> 启动原生二进制，只是把模型流量指到本地网关（`--provider aih` + 网关模型目录）。
> 因此 provider 的合同（`contracts/providers/manifest.json`）与 resume 策略表
> （`lib/runtime/provider-resume.js`）**不覆盖**它们——harness 的原生形态声明在
> `lib/harness/catalog.js` 的描述符里，翻译在 `lib/harness/session-verbs.js`。

## 统一动词覆盖情况

| harness | 统一 resume | 统一 fork | 原生形态（已核对） | 状态 |
| --- | --- | --- | --- | --- |
| pi | `aih pi resume [<id>]` | `aih pi fork <id>` | `--session <id>`（完整/部分 UUID）、`--continue`；`--fork <id>`（必须带身份） | 已统一（pi 1.4.0 `pi --help` 实测） |
| dsh | 明确拒绝（没有入口） | 明确拒绝（没有入口） | `dsh web` 无任何会话旗标（`--session-id` → unknown option）；`dsh headless --session-id <id>` 才有，但 aih 启动的是 web profile | 已核实**不可用**（dsh 0.2.1-rc.5 实测） |
| dsh-tui | — | — | 未声明（走 `dsh --profile dsh-tui`，同上） | 待统一 |

未声明 sessions 的 harness 收到 `resume`/`fork` 时**明确拒绝**并给出可行做法，
不会把 "resume" 当成首条消息发出去（这正是修复前的行为）。

两种「没有」要分开表达（`sessions.resume` 字段）：

- **未声明**（`resume` 字段缺失，如 dsh-tui）：本机没核对过它的 `--help`，不猜。
- **已核实不可用**（`resume: null` + `note`，如 dsh）：真的没有原生入口，`note` 原样告诉用户
  会话在哪里切换（dsh 是 Web UI 内），避免被当成 bug 反复重试。

## pi 的用法

```
aih pi                                  # 新对话（网关账号池 + 模型目录默认模型）
aih pi acct_xxxxxxxx --model <id>       # 钉选账号与模型
aih pi resume                           # 续接最近一段（→ pi --continue）
aih pi resume <session-id>              # 精确续接（→ pi --session <session-id>）
aih pi acct_xxxxxxxx resume <id>        # 指定账号续接
aih pi fork <session-id>                # 从该会话分叉（→ pi --fork <session-id>）
aih pi -- <原生参数…>                    # 逃生门：逐字交给 pi（含 --resume picker 等）
aih pi resume --help                    # 统一动词与各 harness 原生形态对照
```

要点：

- **会话库**：pi 的会话存在 `PI_CODING_AGENT_DIR/sessions`。aih 把宿主
  `~/.pi/agent/sessions` 链进每个账号投影（`linkHostSessions`），所以
  `aih pi resume <id>` 既能接 aih 起的会话，也能接宿主 `pi` 自己起的会话
  （pi 的 `--session` 先按当前项目、再全局按 id 前缀匹配）。
- **不带 id 用 `--continue`**：pi 的「最近一段」是**同项目**语义，跨目录时可能接不到；
  要跨项目精确续接请给 id。
- **fork 必须给 id**：pi 的 `--fork <path|id>` 没有 picker（`--resume` 才是 picker），
  所以 `aih pi fork` 无 id 会明确报错，而不是猜一个会话。
- **网关身份不被绕过**：`--provider` / `--api-key` / `--base-url` / `--profile` 仍由 aih
  掌控，透传时会被拒绝（`external_harness_controlled_flag`）。

## 新增一个 harness 的统一动词

在 `lib/harness/catalog.js` 的描述符里加 `sessions`（事实必须来自该 CLI 自己的
`--help`，不猜）：

```js
sessions: Object.freeze({
  nativeStore: 'sessions',
  resume: Object.freeze({ idArgs: Object.freeze(['--session']), latestArgs: Object.freeze(['--continue']) }),
  fork: Object.freeze({ idArgs: Object.freeze(['--fork']), latestArgs: Object.freeze([]) })
})
```

- `idArgs`：带精确身份时的参数前缀（后面接身份）。
- `latestArgs`：没有身份时的「最近一段」退路；空数组 = 该动词必须给身份。
- `resume: null` / `fork: null` + `note`：**已核实没有**该入口（如 dsh 的 web profile）。
  声明成 null 而不是省略字段，是为了让 `aih <harness> resume` 说出「会话在哪里切换」，
  而不是让人以为是 aih 漏做了。
- 声明之后 `aih <harness> resume|fork` 与 `aih <harness> --help` 自动生效，
  `test/harness-session-verbs.test.js` 守着「声明与翻译一致」。
