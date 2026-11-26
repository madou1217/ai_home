# Control-plane Server 列表去重与 Windows 在线修复（2026-11-26）

## 症状

- Windows AIH Server 在 WebUI「Server」页显示 offline；
- 已保存 Server 越来越多，包含测试端口和重复条目；
- 同一个 IP:port 可以重复添加。

## 根因

1. **Windows 自己的默认 profile 指向测试端口**
   - Windows 库里 active profile 是 `http://127.0.0.1:9528`（早期测试端口，已无监听）。
2. **loopback profile 被错误覆盖 Key**
   - `overlayLocalManagementKey` 把所有 loopback endpoint 都当成本机，
     用当前服务的 Key 覆盖了 `127.0.0.1:19537` 的 Windows 隧道 profile，
     导致远端 401。
3. **浏览器直连远端控制面**
   - `/v0/node-rpc/device-status` 与 `/v0/management/status` 直接请求远端，
     被 CORS 预检拦截，表现为 `Failed to fetch`。
   - 仓库已有同源远端代理（`x-aih-server-id`），但路由只覆盖 `/v0/webui`。
4. **同步把陈旧 local profile 重新写回共享库**
   - `syncSharedControlPlaneProfiles` 回写的是 merge 前的 local 列表，
     删除的条目会被下一个浏览器重新复活。
5. **缺少 host:port 唯一约束**
   - 后端只按完整 endpoint/id 去重，`localhost:9527` 与 `127.0.0.1:9527`
     可以并存。

## 修复

- `endpointKey`：按 host:port 生成唯一键；`localhost` / `::1` 归一为
  `127.0.0.1`；保存和 normalize 都按该键去重，重复添加更新已有记录。
- `overlayLocalManagementKey` 只覆盖与当前请求 **同一 host:port** 的 profile，
  不再把其它 loopback 隧道当成本机。
- 远端控制面请求统一走当前 Server 的同源代理：
  - 代理路径增加 `/v0/node-rpc` 与 `/v0/management`；
  - 前端对远程 profile 使用当前 origin + `x-aih-server-id`，并携带本地
    Management Key；远端 Key 仍由服务端代理注入。
- `syncSharedControlPlaneProfiles` 只回写合并/去重后的列表，并按 host:port
  合并；Server 页加载时主动拉取共享 profiles，更新旧的 Key。
- 前端 `readProfiles` / `mergeControlPlaneProfiles` 按 host:port 合并，
  并在共享库非空时删除本地已不存在的陈旧条目。

## 清理结果

macOS WebUI：5 → 3

- 保留：`当前 Server http://127.0.0.1:9527`、`Windows (tunnel) http://127.0.0.1:19537`、`aws http://127.0.0.1:19527`；
- 删除：`AIH Server http://localhost:9527`（重复）、
  `Direct peer (LAN) http://127.0.0.1:19529`（无监听）。

Windows WebUI：6 → 2

- 保留：`当前 Server http://127.0.0.1:9527`、
  `Mac (tunnel) http://127.0.0.1:29538`；
- 删除：`当前 Server 9528`、`当前 Server 9530`、`AIH Server 19527`、
  重复的 `AIH Server 9527`、无响应的 `AWS Tokyo`。

## 验证

- macOS Server 页同步 Windows profile 后显示 **账号 14/14（14 可调度）**，
  不再出现 `Failed to fetch`；
- 同一 host:port 重复添加测试：
  `http://localhost:19999` 与 `http://127.0.0.1:19999/` 连续 POST，
  最终只有 1 条 `http://127.0.0.1:19999`，测试后已删除；
- Windows 服务 `/ui/servers` 返回 200，active profile 为本机 9527，
  列表仅 2 条；
- Windows 服务与 WebUI 已热替换为同一版修复。

## 提交

`c4ce77c4 fix(control-plane): dedupe servers and proxy remote status`
