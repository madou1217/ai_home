# 桌面端升级统一（zcode / workbuddy family / codebuddy family）

> 状态：P0 已实现（`aih desktop status`）、P1–P3 为方案 · 2026-11-01 · 起因：每换一个账号都要重新升级一次桌面端

## 1. 现象与目标

同一台机器上装了多份账号投影，桌面端升级按账号各来一次：账号 A 升完，切到账号 B 仍提示有新版本；
更新包在每个账号的伪 HOME 里各存一份。目标：

- 升级动作全局只发生一次，所有账号下次启动即用新版本；
- 更新包全机只落一份；
- 旧版本（应用副本、更新包）可回收，且有回滚位；
- 账号身份与用户数据仍然互相隔离，不因为统一升级而串号。

## 2. 现状（2026-11-01 本机实测）

### 2.1 应用本体是全局一份

| 应用 | 位置 | 版本 |
|---|---|---|
| ZCode | `~/Applications/ZCode.app` | 3.17.1 |
| CodeBuddy | `/Applications/CodeBuddy.app` | 4.12.2 |
| WorkBuddy | `/Applications/WorkBuddy.app` | 5.9.2 |
| WorkBuddy AI | `/Applications/WorkBuddy AI.app` | 5.8.4 |

### 2.2 账号投影是伪 HOME

`run/auth-projections/<provider>/<acct>/{Library,electron-user-data*,...}` —— 每个账号一套 `Library/Caches`。
升级相关的三样东西因此天然每账号一份：**下载缓存**、**pending 安装包**、**user-data 里的更新状态**。

### 2.3 已经做对的部分

- `lib/runtime/provider-storage-policy.js` 的 `sharedHostCaches`：zcode 的 `Library/Caches/@zcodedesktop-updater` 已链到宿主，
  所以 574M 的更新包全机只有一份（宿主机实测 `~/Library/Caches/@zcodedesktop-updater` = 574M）；
- `lib/runtime/shared-host-caches.js` 的 `linkSharedHostCaches` 会接管存量投影里的真实副本（`adopted`/`replaced`），**不需要手写迁移脚本**；
- `lib/runtime/zcode-electron-shadow-app.js` 的影子 App 按指纹全机共享，且有 7 天未用回收；
- `sharedHostDedupe`（daimon bundle 按版本戳硬链接）已经证明「版本级共享 + 逐文件去重」可行。

### 2.4 缺口（用户感知到的问题就出在这里）

1. **升级目标是「正在运行的实例」，不是 canonical app**。zcode 实际运行的是 `run/zcode-shadow/<指纹>/ZCode.app`，
   electron-updater 把包装上后只对当前那套运行环境生效；canonical `~/Applications/ZCode.app` 没变，
   下一个账号启动时仍按旧 canonical 走，于是又提示升级 —— 这就是「每个账号都要单独升级」。
2. **缓存清单不全**：`sharedHostCaches` 只覆盖 zcode 的 `@zcodedesktop-updater` 和 workbuddy/codebuddy 的 `BundleMigration`，
   `Library/Caches/<bundle>.ShipIt`、`@<vendor>-updater` 这类没有通用规则，靠逐个手写，新 family 必漏。
3. **同一份更新包存两遍**：宿主 `@zcodedesktop-updater` 里 `update.zip` 287M + `pending/ZCode-3.17.1-*.zip` 287M。
4. **影子按版本整包囤**：`run/zcode-shadow` 现有 3.16.3（806M）+ 3.17.1（911M）= 1.7G，只有 7 天时间阈值，没有「只留当前 + 上一版」。
5. **没有可见性**：没有任何命令能回答「我 5 个账号现在各自会跑哪个版本」。

## 3. 方案

### P0 ‹已实现› `aih desktop status`

输出三段：canonical 应用版本；每个账号的「实际生效版本」（按投影里的 shadow 指纹/可直接启动的 bundle 解析）；
以及漂移结论（`no-drift` / `accounts-behind`）。先让问题可观测，再谈自动化。

依赖：给每个 desktop family 建一份**家族描述符**（canonical 路径、bundleId、updater 类型、shadow 策略），
放在 `lib/server/desktop-launch/<family>-descriptor.js`，由现有 `index.js` 注册表统一分发，禁止在 CLI 层写 provider 分支。

### P1 ‹部分实现› 缓存归一（整目录共享已落地）+ `aih desktop gc`

- **已落地（2026-11-01）**：桌面 family 的 `Library/Caches` 改为整目录共享——链接时展开成逐项链到宿主，唯一例外是应用自己的 Chromium 缓存目录（`dev.zcode.app` / `com.tencent.codebuddy` / `com.workbuddy.workbuddy-ai` / `com.tencent.workbuddy.mac`），它们可能缓存带凭据的响应体，留在账号里。21 个存量账号已迁移（3060 条链接，10 个重复副本丢弃，1 个收养）。
- 待做：影子回收命令化（当前只有 7 天时间阈值 + 手动清理），以及 updater 里 `update.zip` 与 `pending/*.zip` 的去重。
- 预期收益（本机）：`run/zcode-shadow` 1.7G → ~0.9G；`@zcodedesktop-updater` 574M → ~290M。

### P2 ‹核心› `aih desktop update <family>` —— 升级只做一次

1. **下载一次**：写到 `<aiHomeDir>/run/desktop-updates/<family>/<version>/`（带 `.partial` 后缀，完成后原子改名）；
   下载前先查这个目录，命中直接复用，不重复拉 287M。
2. **校验**：签名（`codesign -v`）+ 包内 `Info.plist` 版本 == 目标版本 + sha256 记录到 `manifest.json`。
3. **原子替换 canonical**：`<app>.app` 移到 `<aiHomeDir>/run/desktop-backups/<family>/<version>/`，新包解压到临时目录后再 rename 进位（同一卷内 rename 是原子的）；保留上一版用于回滚。
4. **重建影子**：清掉旧指纹（或标记 stale 立刻可回收），首次启动按新 canonical 生成新指纹。
5. **收尾**：刷新 P0 的漂移结论，提示「哪些账号下次启动生效 / 哪些实例还在跑旧版本」。

并发保护：同一 family 的 update 用 `<aiHomeDir>/run/desktop-updates/<family>/.lock` 串行化；
若检测到该应用正在运行，默认**只下载不替换**（`--force` 才允许），避免替换运行中的 bundle。

### P3 抑制实例自更新（可选，取决于上游开关）

统一通道接管后，实例自己的 electron-updater/Squirrel 应关闭，否则两者会打架：
- 先探测各 family 的开关（`--disable-auto-update` 参数、`**disableAutoUpdate`` 配置、`*_DISABLE_AUTO_UPDATE` env），写成描述符里的 `autoUpdateSuppress` 字段；
- 探测不到就退而求其次：把 updater 的 pending 目录统一指向共享目录（P1 已覆盖），让「谁先下谁下，其他账号复用」，至少不再重复下载。

## 4. 迁移与回滚

- 存量投影：`linkSharedHostCaches` 已能接管，无需迁移脚本；上线 P1 后首次启动自动归位。
- 回滚：canonical 替换前保留 `run/desktop-backups/<family>/<version>/`，`aih desktop rollback <family>` 把备份换回来并清影子。
- 不动的东西：`electron-user-data*`（账号身份）、`Library/Application Support/<app>` 里的账号态、`.zcode/v2/credentials.json`。

## 5. 测试计划

| 层 | 用例 |
|---|---|
| 单测 | 描述符注册表（未知 family 失败关闭）；`linkSharedHostCaches` 的 adopted/replaced/unchanged 三分支；gc 的「保留当前+上一版」边界；update 的 `.partial` 中断不留半成品 |
| 集成 | 两个账号投影共用一份 updater 缓存（第二次启动不再下载）；canonical 替换后影子重建、旧影子被回收 |
| 真机 | ① 账号 A 提示升级 → `aih desktop update zcode` → 账号 B 启动直接是新版本，不再提示；② 升级中应用在跑 → 只下载不替换；③ 磁盘：shadow 与 updater 缓存各只有一份 |

## 6. 明确不做

- 不共享 `electron-user-data` / `Application Support`（那是账号身份，会串号）；
- 不做「静默强制升级」：默认只下载，替换需要显式命令或空闲窗口。

## 7. P0 落地（2026-11-01）

- `lib/server/desktop-launch/desktop-app-catalog.js`：provider ↔ .app 映射（zcode / codebuddy / workbuddy / workbuddy-cn / claude / codex / kiro），读 Info.plist（二进制 plist 走 plutil）；
- `lib/server/desktop-launch/desktop-status.js`：canonical / 影子副本 / 运行中（最外层 .app 归属）/ 漂移；
- `lib/server/desktop-launch/desktop-host-home.js`：CLI 跑在账号投影里时，用 `os.userInfo()` 拿真实宿主家目录；
- `lib/cli/commands/desktop-router.js`：`aih desktop status [--json]`，已接 root 分发、TAB 补全、`aih --help`；
- `test/desktop-status.test.js`：4 pass。
