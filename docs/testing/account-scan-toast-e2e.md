# E2E 用例：账号扫描 skipped 摘要 toast

- 脚本：`scripts/verify-account-scan-toast.mjs`
- 首次落地：2026-11-25（`ab718f7d`）
- 范围：WebUI「扫描本机账号」完成后，`skipped` 里的可处理原因是否以摘要形式进入 toast
- 形式：真实浏览器 E2E。仓库约定「不写单测，要测就真实测试」，本用例不新增单测或测试框架依赖

## 1. 覆盖什么

| 场景 | 断言 |
|---|---|
| 有新增账号 + 多条跳过 | toast 先显示「新增/更新 1 个账号」，再追加「另有 3 个来源未入库」 |
| 同类原因 | `credential_source_mismatch` 合并为「凭据站点不匹配 ×2」 |
| 带 detail 的读取失败 | 显示「桌面凭据库读取失败（file is not a database (26)）」 |
| 常态跳过 | `existing_account_unchanged` 不进入摘要，也不显示「账号无变化」 |
| 只有常态跳过 | 第二次扫描的 toast 不再出现「另有…」 |

## 2. 不覆盖什么

- 不触发真实账号扫描，不写账号库；只 mock `/v0/webui/accounts/detect` 的响应。
- 不验证后端 `desktop_credential_read_failed` / `detail` 的生成。那部分属于 hostdetect 的桌面凭据读取路径；修改后端后需另做真机或真实损坏库验证。
- 不覆盖管理页之外的第二入口（登录进度弹窗）。两处共用 `formatDetectSkipSummary`，但弹窗入口目前没有独立 E2E。

## 3. 前置条件

1. 本机 `aih-server` 已启动，且 WebUI 已构建并可从 `AIH_WEBUI_URL` 访问（默认 `http://127.0.0.1:9527/ui/`）。
2. 已安装全局 `playwright-cli`：
   ```bash
   npm install -g @playwright/cli
   ```
3. 能取得当前 Server 的 Management Key。只通过环境变量传给脚本，不要写进命令参数或文件：
   ```bash
   AIH_MANAGEMENT_KEY=... node scripts/verify-account-scan-toast.mjs
   ```

可选变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AIH_WEBUI_URL` | `http://127.0.0.1:9527/ui/` | 末尾斜杠会自动补齐 |
| `AIH_TOAST_SCREENSHOT` | 空 | 设置后保存第一段 toast 的截图 |

## 4. 工作原理

1. 用独立 `playwright-cli` 会话打开 WebUI。
2. 若落在 server-setup 授权页，填入 `AIH_MANAGEMENT_KEY` 并点击「保存并授权」；已授权时跳过。
3. 进入账号页，安装 `page.route` 只拦截 `/v0/webui/accounts/detect`。
4. 第一次返回「1 条新增 + 3 条可处理跳过 + 1 条常态跳过」，点击「扫描本机账号」，读取最新 toast。
5. 等待第一条 toast 自动消失，切换到「只有常态跳过」的响应，再点一次，读取最新 toast。
6. 断言 6 项；任意失败退出码为 1。
7. `finally` 中关闭浏览器并删除临时 flow 文件（含 Key，权限 0600）。

## 5. 预期输出

```text
ok  新增账号数
ok  未入库摘要
ok  同类原因合并
ok  detail 展示
ok  常态跳过不出现
ok  常态跳过不追加摘要
--- actionable toast ---
扫描完成：新增/更新 1 个账号（本机已入库：claude 1）；另有 3 个来源未入库：凭据站点不匹配 ×2、桌面凭据库读取失败（file is not a database (26)）
--- benign-only toast ---
扫描完成：新增/更新 1 个账号（本机已入库：claude 1）
```

## 6. 排错

| 现象 | 处理 |
|---|---|
| 启动即报 `AIH_MANAGEMENT_KEY is required` | 补环境变量；不要用 `--key` 之类的参数传 |
| 授权后仍 401 | Key 取错或已轮换；用当前运行实例的配置重新取 |
| 找不到「扫描本机账号」 | 账号页没加载完或构建产物过旧；先确认 `AIH_WEBUI_URL` 打开的是新 bundle |
| 找不到「保存并授权」 | 授权弹窗状态变化；重新打开页面，或先手动授权一次再跑（脚本会复用已授权 profile） |
| `playwright-cli not found` | 按第 3 节安装；脚本不引入仓库依赖 |
| toast 断言 detail 失败 | 先看输出的实际 toast；确认前端构建包含最新的 `formatDetectSkipSummary` |

## 7. 维护

- 新增/修改 skipped 原因文案时，同步更新脚本里的 `SKIP_REASON_TEXT` 预期断言。
- 修改 detect 响应契约（字段名、`skipped` 形状）时，同步更新 mock payload。
- 该脚本只验证渲染；后端 reason/detail 变化仍需单独做真实数据验证。

## 8. 首次实测

2026-11-25 在本机运行，6 项断言全部通过，截图保存在运行者指定的 `AIH_TOAST_SCREENSHOT` 路径。对应前端实现：`web/src/features/accounts/detect-skip-summary.ts`。
