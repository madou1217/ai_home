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
