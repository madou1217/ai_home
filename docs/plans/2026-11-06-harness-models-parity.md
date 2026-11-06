# Chat harness 模型目录对拍（harnessModelsViaGo，2026-11-06）

> 任务代号 harness-models-parity。只读对拍：未发起推理、未删账号、未改 Go 代码、未 `git add` / `git commit`。
> 目的：真机打开 `config:server.harnessModelsViaGo`，比较 Chat harness 网关目录与 Go `account-models` 的 effective 集，
> 验证 Go 不可用时回落本地快照，最后恢复开关。

## 1. 开关原值与开启

`config:server` 原本**没有** `harnessModelsViaGo` 键（缺省 false）：

```
$ sqlite3 ~/.ai_home/app-state.db "select json_type(value,'$.harnessModelsViaGo') from app_kv where key='config:server';"
NULL
$ sqlite3 ~/.ai_home/app-state.db "select value from app_kv where key='config:server';" | shasum -a 256
3ba3255c58a5d7a490e36999fd9c8b3a81ec85b1e5c0ee38e76f8b45172f55ae  -
```

用 node:sqlite 备份原值后置 true（其它键不动），写入值 sha256 `dd2a8251…cf75`。
按原参数重启（`HOME=/Users/model`、`AIH_HOME_DIR=/Users/model/.ai_home`，端口 9527）：

```
launchctl remove com.meadeo.aih-server
/bin/launchctl submit -l com.meadeo.aih-server -o ~/.ai_home/logs/server.log -e ~/.ai_home/logs/server.log -- \
  /bin/bash -lc 'export HOME=/Users/model AIH_HOME_DIR=/Users/model/.ai_home; cd /Users/model/projects/feature/ai_home; \
  exec /Users/model/.nvm/versions/node/v22.21.0/bin/node lib/cli/app.js server serve --host 0.0.0.0 --port 9527 \
  --no-proxy localhost,127.0.0.1,0.0.0.0,192.168.31.57 --models-probe-accounts 8 --window-activation'
```

重启后：`/healthz` 200（第 9 次探测），`/readyz` 为 `ready=true`、`go_core.state=ready`；
Node 进程 57746，Go 进程 58130；`config:server` 的 `harnessModelsViaGo=true`。

## 2. 对拍账号与结果

数据源：
- 账号：`GET /v0/webui/accounts`（32 个账号）；
- Go：`GET 127.0.0.1:19550/v1/management/account-models`（用 Go 子进程环境里的 Management Key，不打印密钥），只取 `effective=true`，按 `go-account-sync:state.links` 把 Go ref 翻回 Node ref；
- harness：`POST /v0/webui/chat/sessions`（`provider=codex`、`executionAccountRef=gateway`）后
  `GET /v0/webui/chat/sessions/<id>/composer/catalog`，走的是 `createChatHarnessModelReader` 的网关全局池分支。

| 账号 | provider | 显示名 | Go effective | harness 命中 | 差集 |
| --- | --- | --- | ---: | ---: | --- |
| `acct_c016fd7eee0f64163068` | codex | proxy.meadeo.com | 31 | 31 | 0 |
| `acct_04a193ed26f71e4619c5` | codebuddy | meadeodeo@gmail.com | 26 | 26 | 0 |
| `acct_9dc03880a872f711983e` | codebuddycn | 码逗 | 20 | 20 | 0 |
| `acct_5997549c49c82339fac3` | zcode | yfadmgkl | 2 | 2 | 0 |
| `acct_d88d90081d3166703839` | zcode | MeaDeo | 12 | 12 | 0 |

`agy` 在 `/readyz` 里账号数为 0，本机没有可对拍的 agy 账号。

全局去重口径同样完全一致：

```
harness=206  goEffectiveUnion=206  intersection=206
H_only(0)=
G_only(0)=
```

即冷启动后的第一次 gateway 目录读取，harness 返回的 206 个模型与 Go effective 并集逐项相同。
Node 快照当前并集是 212；按 `model-catalog-settings` 过滤掉 15 个显式停用模型后也是 206
（其中 qoder 的 `Auto/Cantus/Efficient/Fast/Sonus/Ultimate` 6 个只在快照里且已停用），所以本机两条来源过滤后集合相同。

## 3. Go 不可用时的回落

对 Go 子进程做 `SIGSTOP`（不退出、不触发 supervisor 重启），确认 Go 私有端点不可达：

```
$ kill -STOP 58130
$ curl -m 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:19550/healthz
000   # timeout
```

新建一个 gateway 会话后读 composer catalog（不是复用已有会话的 30s 缓存）：

```
POST /v0/webui/chat/sessions -> 201
GET  /v0/webui/chat/sessions/<id>/composer/catalog -> 200, 1.992s
models_down=206
snapshotOnlyPresent=Auto=false,Cantus=false,Efficient=false,Fast=false,Sonus=false,Ultimate=false
```

harness 没有报错，仍返回 206 个模型；该集合与「Node 快照按 model-catalog-settings 过滤后」的 206 个模型**完全相等**。
随后 `kill -CONT 58130`，`/readyz` 的 `go_core.state` 回到 `ready`，未发生重启（`restarts=0`）。

## 4. 关键发现：当前 Go 二进制不支持 `meta_only`

对运行中的 Go 进程直接请求条件刷新用的指纹端点：

```
GET /v1/management/account-models?meta_only=1
400 {"error":{"code":"invalid_models_query","message":"模型查询参数无效"}}
```

`meta_only=true`、`metaOnly=1`、裸 `meta_only` 也都是 400；全量 GET 的响应只有 `data`，没有
`generation` / `updated_at_ms`。原因不是 Go 源码没实现，而是**运行中的二进制是旧的**：

```
bin/native/darwin-arm64/aih-server                 2026-11-06 18:49
internal/transport/http/accountsapi/account_models_collection.go  2026-11-06 23:14
strings bin/native/darwin-arm64/aih-server | grep -c meta_only   -> 0
```

用 harness 自己的导出函数直接探两次，复现得非常清楚：

```
first=ok accounts=30 generation=null updatedAtMs=0
second=null
third=null
```

后果：`harnessModelsViaGo=true` 时，**只有冷启动后的第一次**目录读取走 Go 全量；
之后每次先读 `meta_only=1` 指纹，拿到 400 后 `chat-harness-go-models.js` 返回 null，
`chat-harness-model-reader.js` 静默回落到本地快照。本机两条路过滤后恰好都是 206，所以页面上看不出来；
一旦 Go 与快照有差异，模型菜单会在第一次读取后从 Go 集合翻成快照集合。

## 5. 复原

把备份的原始值写回 `config:server`：

```
$ sqlite3 ~/.ai_home/app-state.db "select json_type(value,'$.harnessModelsViaGo') from app_kv where key='config:server';"
NULL
```

- 写入时 `restoredExactly=true`，sha256 回到 `3ba3255c…f55ae`；
- 按原参数再次 `launchctl remove + submit`；`/healthz` 200（9s 内），`/readyz` `ready=true` / `go_core.state=ready`；
- 最终 `GET /v0/webui/accounts` 200、32 个账号；
- 与备份原值逐键深比较 `deepDiffs=0`、`harnessModelsViaGo` 键不存在。
  注：Node 服务启动/运行中会把 JSON 重新序列化（空格/缩进变化），所以最终原始文本 sha256 是
  `e3c78fa2…417`；**配置语义与备份完全一致**，开关保持缺省关闭。

## 6. 结论与建议

- 冷读对拍：206 vs 206，逐项一致；所选 5 个账号的 Go effective 模型全部出现在 harness 目录里，差集为 0。
- 回落：Go 被 `SIGSTOP` 时 composer catalog 仍 200、206 个模型、无错误，等于过滤后的快照集合。
- **不建议现在默认开启** `harnessModelsViaGo`：当前运行的 Go 二进制早于 `meta_only` 指纹端点，
  开启后实际只有第一次读 Go，之后每次都静默回落快照；Go/快照不一致时会造成目录来源漂移。
- 建议先重新构建并部署 Go 二进制（包含 `generation`/`updated_at_ms` 与 `meta_only=1`），
  再按本文步骤复跑一次：确认第二次及后续读取的 `generation` 非空、目录仍与 Go effective 一致，
  且 Go 停止时回落快照不报错，再考虑默认开启。
