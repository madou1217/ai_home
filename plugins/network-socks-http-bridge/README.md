# SOCKS5h → HTTP 代理桥

这是一个 `network.connector` process 插件：把上游 SOCKS5h 代理暴露成本机回环
HTTP CONNECT 代理。插件本身不进入 AIH 核心，按仓外插件包安装、启用和升级。

## 安装与启用

```bash
aih plugin install plugins/network-socks-http-bridge --accept-permissions
aih plugin enable network.socks-http-bridge --accept-permissions \
  --config-json '{"socksUrl":"socks5h://user:pass@127.0.0.1:1080","listenPort":3128}'
```

安装目录会自动打包成 `.aih-plugin`。启用后插件在 `127.0.0.1:3128` 提供 HTTP CONNECT
代理；`socksUrl` 只保存在插件 `state/` 下（0600），不会出现在 describe/status。

## 跟随常驻代理服务自动重连

`aih proxy serve` 由常驻服务（`aih proxy service install`，autostart 追加
`--exit-with-parent`）启动时，会把当前入口写入
`<aiHome>/run/proxy/entry.json`（0600，含租约凭据），字段为
`{"version":1,"pid":…,"httpUrl":…,"socks5Url":…,"name":…,"updatedAt":…}`。
临时手工启动的 `proxy serve` 不发布该文件，避免覆盖常驻入口。
把桥的上游指向该文件即可跟随服务重启：

```bash
aih plugin enable network.socks-http-bridge --accept-permissions \
  --config-json '{"socksUrlFile":"/Users/me/.ai_home/run/proxy/entry.json","listenPort":3128}'
```

- 桥按文件 mtime/大小缓存上游；文件变化时自动重读，不需要重启插件；
- 连接上游握手失败（连接被拒、认证失败等）时会强制重读入口文件并重试一次，
  覆盖「服务重启后端口与租约令牌都变化」的窗口；
- 文件短暂不存在时继续使用上一次有效上游；
- `probe` 总是按最新文件内容探测，状态中的 `upstream.source` 显示当前来源；
- `socksUrlFile` 优先于静态 `socksUrl`；两者至少配置一个。

## 使用

```bash
export HTTPS_PROXY=http://127.0.0.1:3128
export HTTP_PROXY=http://127.0.0.1:3128
export NO_PROXY=127.0.0.1,localhost
curl -x http://127.0.0.1:3128 https://api.anthropic.com/
```

Claude Code TUI 只接受 HTTP CONNECT 代理；把上面的 `HTTPS_PROXY` 指向本桥即可。

## 操作

- `configure`：更新 `socksUrl`、`listenHost`、`listenPort`、`autoStart`；
- `start` / `stop` / `restart`：控制监听；
- `probe`：对上游 SOCKS5 做一次真实握手。

## 边界

- 只支持 TCP（HTTP CONNECT）；SOCKS5 的 UDP ASSOCIATE / BIND 没有 HTTP 对应物。
- 只监听回环地址，不提供认证，不能作为开放代理暴露。
- `socks5h` 的远端 DNS 语义保留；桥不会在本地解析目标域名。
