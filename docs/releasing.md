# 发版：只有 git tag 才打包

> 打包（单文件安装包、目录归档、Go Core）**只**由 `v*` tag 触发。
> 本地 `npm run pkg:build` 只用于验证，不会发布任何东西。

## 1. 一条命令发版

```bash
# patch: 1.0.0 -> 1.0.1
npm run release:tag -- --bump patch

# minor / major
npm run release:tag -- --bump minor
npm run release:tag -- --bump major

# 指定版本
npm run release:tag -- --version 1.2.3
```

脚本会依次做：

1. 检查工作区干净、当前分支是 `main`、与 `origin/main` 完全一致；
2. 更新根 `package.json` 与 `web/package.json` 的 version；
3. 提交 `chore(release): v<version>`；
4. 打 annotated tag `v<version>`；
5. 推送 commit 与 tag。

CI 的打包命令带 `--require-tag`：HEAD 必须干净且正好是 `v<version>` tag，否则构建直接失败。

推送 tag 后 GitHub Actions 自动运行：

| workflow | 产物 |
| --- | --- |
| `release-artifacts.yml` | 6 个平台的 `.run` / `.exe`、`.tar.gz` / `.zip`、`.sha256`、manifest，附加到 GitHub Release |
| `go-core-release.yml` | 各平台 `aih-server-<platform>-<arch>` 与 `.sha256` |

## 2. 只在本机提交/打 tag

```bash
npm run release:tag -- --bump patch --no-push
# 检查无误后手动推送
git push origin main
git push origin v1.0.1
```

`--dry-run` 只打印将要执行的步骤（仍会做工作区/分支检查）：

```bash
npm run release:tag -- --bump patch --dry-run
```

## 3. 手动发 tag（不推荐）

```bash
# 先把 package.json / web/package.json 的 version 改成 1.0.1 并提交
git tag -a v1.0.1 -m "AI Home v1.0.1"
git push origin v1.0.1
```

tag 必须与 `package.json` 的 version 完全一致；CI 的
`Check tag matches package version` 步骤会直接失败。

## 4. 校验产物

CI 在构建后自动跑：

```bash
node scripts/release-check.js --tag "$RELEASE_TAG" --no-head --require-artifacts
```

本机也可以对已下载的产物跑：

```bash
npm run release:check -- --tag v1.0.1 --artifacts dist/release --require-artifacts
```

检查项：

- tag 与 `package.json` version 一致；
- （默认）tag 指向 HEAD；
- 每个目标都有单文件包、目录归档、`.sha256`，且校验和正确；
- manifest 的 version 与每个产物的 sha256 对得上。

## 5. 为什么不在本地打包发布

- 发布产物必须来自**已提交的 tag**，否则源码、WebUI、Go Core 可能来自不同状态；
- CI 在固定的 Linux runner 上构建全部平台，避免「本机 macOS 打出来的 Linux 包没验证」；
- 单文件包自带 Node 运行时，体积大，不适合作为每次提交的产物。

## 6. 常见失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `working tree is not clean` | 有未提交改动 | 先提交或 stash |
| `release must run on main` | 当前不在 main | 切回 main |
| `behind origin/main` | 本地落后 | `git pull --ff-only` |
| `ahead of origin/main` | 本地有未推送提交 | 先 push 或 reset |
| `tag already exists` | 版本号重复 | 换一个更大的版本 |
| CI `tag does not match package.json` | 手动 tag 与 version 不一致 | 改 version 后重新打 tag |
