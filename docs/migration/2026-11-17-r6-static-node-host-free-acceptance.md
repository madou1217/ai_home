# R6 / 原 W5–W6：Go 静态托管入口无 AIH Node 宿主的真实验收

> Owner：监督会话 `01a1df63-a386-76d0-9acf-025e5a07582d`。实际执行：**2026-11-17 11:28:45–11:28:46，Asia/Shanghai**。本次不是新功能或平行迁移计划，只落实已存在 Go 静态入口的一条可执行 Node-host-off 门禁。业务源码零修改。

## 本轮关闭的窄门禁

实际已编译的完整 Go server，在私有 HOME/AIH_HOME/loopback 端口、**没有 `--supervise-node`、`--front-door` 或 Node base URL** 的情况下，能够托管实际 WebUI 构件、处理 SPA 深链、交付完整 JS/CSS，并保留静态错误与管理鉴权状态。

**这不证明标准服务已默认使用 Go 托管，也不等于 Node 后端已退役。** 本次不访问共享 9527，不使用真实账号/凭据/数据库，不运行浏览器 DOM、登录、推理或 remote-profile 旅程，不停止或删除任何 Node 代码。

## 构件与数据来源

| 项 | 精确记录 |
| --- | --- |
| Go 固定源码 | `9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87`，复用原 W0 已验 committed archive 构件，不编译共享 dirty 工作区 |
| Go 二进制 SHA256 | `57e97796ccaeb36c5ec8729a1d0f5f1087c96d70ce8a0175743d2ddc415d4020`，复制前后与结束时均一致 |
| 前端来源 | 原协议 owner 实际规范构建的 `aws-release-source-slow-bdbbfe3f3e/web/dist`；本轮不重新构建、不覆盖共享 dist |
| 前端源码关联 | 该产物来源目录的 **988 个 tracked `web/` Git blob**逐项等于上述固定源码，缺失0、差异0；不把构建时间、完整依赖环境或可复现输出额外认作已证明 |
| 实际静态构件 | **208 个文件**复制到私有目录；结束时每个 SHA256 与起始 manifest 一致 |
| 文件清单 SHA256 | 相对路径→SHA256映射按 key 排序紧凑 JSON 的摘要 `a43b280ac02f6fceb43384a978681b64199527d060f5f4ba7177ec566647f4a7` |
| 私有服务 | PID `76487`、loopback端口 `52148`；正常终止并 wait，已退出；共享服务未操作 |
| 账号/配置 | 新建私有空库，未导入任何真实账号、凭据或配置；仅为真实启动合同生成当次随机管理/客户端密钥，不写 argv、文档或终端 |

实际启动形态：

```sh
# PRIVATE 是本轮新建的0700目录；不使用已安装的 Node aih wrapper。
# HOME/AIH_HOME_DIR/TMPDIR 均只指向 PRIVATE 子目录。
# 当次随机管理/客户端密钥只在子进程环境，不复用真实密钥。
PATH=/usr/bin:/bin:/usr/sbin:/sbin   "$PRIVATE/aih-server" --host 127.0.0.1 --port "$PRIVATE_PORT"   --web-dir "$PRIVATE/web-dist"
```

这不是修改正式 autostart 或给公开端口重新绑定；构件、静态目录和状态目录都在私有根。

## 真实 HTTP 结果

使用实际 `http.client` 连接这个完整 Go server，不是 mock、复制函数或合成业务返回。共12个实际请求：

| 方法/请求 | 结果 |
| --- | --- |
| GET `/healthz` | 200、`aih-server`进程健康 |
| GET `/readyz` | 200、**ready=false**；空账号库是预期，不能从健康推出推理就绪 |
| GET `/` | 302，Location=`/ui/` |
| GET `/ui/` | 200，实际构件 index |
| GET `/ui/chat` | 200，与 index 完整字节相同，SPA深链可用 |
| GET `/ui/umi.7d254ccf.js` | 200、6,918,925 bytes，完整字节等于私有冻结文件 |
| HEAD 同一 JS | 200、响应体0 bytes、Content-Length=6,918,925 |
| GET `/ui/umi.a26938dc.css` | 200、719,227 bytes，完整字节等于私有冻结文件 |
| HEAD 同一 CSS | 200、响应体0 bytes、Content-Length=719,227 |
| GET `/ui/__r6_missing_frozen_asset__.js` | 404，不用 index 假装缺资源成功 |
| POST `/ui/` | 405 |
| 无密钥 GET `/v1/management/accounts` | 401，不因静态页独立服务而绕过管理鉴权 |

JS SHA256=`4a23640f68e3e91ecba28859415435c18e7ad00188110b561c1fd241a8ef4f6f`；CSS SHA256=`809f7c175d5b0a40904347705cfd0f85de76161a868dd8af95862da9a075f682`。

## Node 与失败实验边界

- 最终实际进程没有启动 AIH Node supervisor/frontdoor，PATH 上无 Node。每约120ms对私有后代做安全 `pid/ppid/comm` 采样，观察到实际 Go 进程，没有观察到 Node 宿主/child；这只是有界进程观察，**不是全部 syscall 或任意短命 child 的完备禁止证明**。
- 第一轮未提供空 HOME 下必需的管理/客户端密钥，生产入口明确拒绝启动。这是验收操作前置条件遗漏；只给当次私有进程生成随机值，未改变产品合同或真实配置。
- 随后尝试以 OS sandbox 禁止所有外部执行；正式 server identity 会调用 setuid `/bin/ps`，启动因 `operation not permitted` 失败。允许原 `/bin/ps` 仍失败，字节相同但移除setuid的私有复制件也被OS终止。未伪造 `ps` 输出、修改Go身份实现或放宽产品校验来制造通过。
- **最终成功运行未使用该 sandbox**。先前 `node/sh/true` 拒绝的对照不能移给最终进程，因此不声称最终 OS 级 Node exec/fork/网络全部被禁止。这里关闭的是没有 AIH Node **server宿主/静态代理**的实际静态交付能力，不是整台机器或完整 server绝对没有 Node 依赖。
- 失败尝试的原始输出、策略及最终运行分别保留在私有证据中；不会删掉失败来仅报绿色。

## 精确后续交接，不把窄通过当全部R6完成

1. **标准启动合同仍未切换。** 部分既有启动参数缺 `--web-dir`，仍有 Node `web-ui-router.js` 静态兜底；本轮仅证明现成 Go Handler可独立运行。下一源码动作应由该原入口 owner先声明精确 autostart/config/package路径，统一明确静态根和缺资源失败行为，再实际验证不启动Node的标准入口；不是继续加Node静态业务。
2. **remote transport与业务未验。** `remote_webui_proxy.go`/Node `webui-server-proxy.js` 及server-id隔离、鉴权、HTTP/WS/SSE、错误目标不回落本机仍是独立门禁；本轮不触碰Chat9、协议、M或该业务owner写集。
3. **浏览器页面未验。** React/TS前端保留，但本轮没有DOM渲染、登录、用户操作、缓存升级或可视/无障碍验收；静态200不代这些证据。
4. **正式来源/批准未改变。** 共享本机7e dirty构件的历史完整闭包、匹配stamp与独立批准缺口仍按R0记录；本私有服务退出不等于任何正式切换授权。未重启共享服务，未发布或删旧Node实现。

## 交付与审查

本轮生产源码写集为空；仅本验收文档由本监督会话按显式pathspec提交，不能代交他人改动。没有新增或修改测试用例、mock provider、账号fixture、看板或周期任务。

已有 reviewer 子代理当前工具返回 `agent not found`，未新建 writer/会话。此纯验收文档按仓库能力链执行显式 **self_review + plan_check / doc-only bypass**：逐项核对固定来源摘要、988blob、208产物、12请求、私有进程退出和上述失败实验边界；不声称独立代码审查通过，不扩大为源码/发布批准。

本地低敏结果：`$AIH_HOME/run/commit-ownership-audit-20261116-123843/R6-static-nodeoff-actual-result.json`；私有根指针：同目录 `R6-static-nodeoff-root.txt`。原始文件manifest、失败启动输出与最终HTTP结果留私有0700目录；没有真实凭据导入，未把运行日志/二进制/随机密钥提交进Git。
