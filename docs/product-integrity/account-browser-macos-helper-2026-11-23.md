# macOS surface helper build cache and signing (2026-11-23)

Purpose: stop the macOS surface helper from asking for Screen Recording and
Accessibility on every browser start, and stop recompiling Swift on each start.
The helper is compiled from embedded sources, so its code identity changed
whenever the temporary build path or bytes changed.

## Environment

- macOS 27.2.1 (build 26B131), Apple Silicon
- Microsoft Edge stable 156.0.4314.58 (installed at `/Applications/Microsoft Edge.app`)
- Server built from the commit that introduced the cache (see the commit log),
  launched with a temporary HOME and port 19791 so the running service on 9527
  was not touched

## Change

- Cache root: `<AIH home>/run/cache/account-browser/helper/<key>/aih-browser-surface`.
- `<key>` is the first 24 hex characters of SHA-256 over the cache format tag,
  the Swift target triple and every embedded Swift source. A source edit
  therefore produces a new directory and a new grant; identical sources reuse
  the exact same bytes.
- The build runs in `.build-*` inside the cache root, is signed with
  `codesign --force --sign - --identifier com.meadeo.aih.browser-surface`, and
  is published by `rename`. A `helper.json` manifest records the key and the
  binary SHA-256; a mismatch rebuilds instead of executing unknown bytes.
- Old revisions and abandoned staging directories are pruned after a
  successful start. If the home is not writable the old transient build remains
  as a fallback, with the old re-prompt behavior.

## Evidence

- `codesign -dvv` on the cached binary:
  `Identifier=com.meadeo.aih.browser-surface`, `Signature=adhoc`,
  `Format=Mach-O thin (arm64)`.
- Cold start (cache miss, includes Swift compile): `ready` in 8.56 s.
- Warm start (cache hit): `ready` in 1.75 s and 1.81 s in two runs.
- Across a full server restart the cached binary kept the same inode and mtime
  (`inode=1178176803 mtime=1795399965 size=194256`), and the cache root held a
  single revision directory.
- Tamper check: appending one byte to the binary made the next start rebuild
  it; the new size and SHA-256 matched `helper.json` again and a session
  reached `ready`.
- The cached binary reports
  `{"eventPosting":true,"screenCapture":true,"type":"preflight"}` without a new
  permission prompt.
- Job-scope start created `run/account-browser/pending/<jobId>/user-data` and
  produced frames at 1200x900, so the cached helper is a working surface.

## Keyboard activation (fixed 2026-11-23)

`navigate`, `key` and `text` now raise the captured Edge window through
Accessibility (`kAXFrontmost`, `kAXRaise`, focused/main window) before posting
events, with `NSRunningApplication.activate` as the fallback. Pointer and
scroll keep addressing the captured `windowID` directly and do not take focus
away from the WebUI.

Verified on this Mac:

- `https://www.baidu.com` and `https://example.com` load and render after one
  `navigate` (140+ frames at 1200x900). Before the fix the same command left
  `about:blank` with the URL only typed in the address bar.
- The Codex authorize URL commits and enters the loading state. Its page stays
  blank in this environment because `auth.openai.com` is unreachable without
  the account egress proxy (`curl` returns 403), so a real login still needs a
  configured proxy or the Windows host.

## TCC attribution under the launchd service (2026-11-23)

The cached helper works when the server is started from a terminal, because TCC
treats the terminal as the responsible process and reuses its Screen Recording
grant. The installed service is a launchd job, and `tccd` then reports:

```
Service kTCCServiceScreenCapture does not allow prompting; returning denied.
Service kTCCServicePostEvent does not allow prompting; returning denied.
attribution={responsible={... responsible_path=.../bin/native/darwin-arm64/aih-server},
             requesting={identifier=com.meadeo.aih.browser-surface, ...}}
```

So the grant belongs to the **server binary**, not the helper, and a background
process cannot show the permission dialog. A launchd `--preflight` returns
`{"eventPosting":false,"screenCapture":false}` while the same binary from a
terminal returns both true.

Required one-time setup for the service: add
`<repo>/bin/native/darwin-arm64/aih-server` to System Settings → Privacy &
Security → Screen Recording **and** Accessibility (the list's "+" button;
Cmd+Shift+G accepts the absolute path). Rebuilding the server changes its
cdhash and may require toggling the entry again.

To keep the permission entry independent of the source-hash cache, the helper is
now also published at `<AIH home>/bin/aih-browser-surface` (atomic rename,
identical content left untouched) and executed from there. The stable file and
the cache file share SHA-256 `dbbdbab2…`, and `codesign` reports
`com.meadeo.aih.browser-surface`. The TCC responsible process is still the
server, so this path is for a future app-bundle layout rather than the current
grant target.

## Stable TCC identity and OAuth proxy (2026-11-23)

TCC attributes Screen Recording and Accessibility to the **responsible process**
of the launchd job. When the job runs the server directly, every server rebuild
changes the code identity and the grant stops matching
(`Failed to match existing code requirement`). The service now runs through
`<AIH home>/bin/aih-launch`, a small parent that spawns the server, forwards
signals and mirrors its exit code:

```
launchd -> aih-launch (granted once) -> aih-server (rebuilt freely) -> surface helper
```

Verified on the installed service: after switching the plist to
`aih-launch -- <server>`, `tccd` reported
`responsible_path=/Users/model/.ai_home/bin/aih-launch` for the surface helper,
and the server ran as its child with `/readyz` 200. The launcher must stay byte
identical across releases; changing its source or the Go toolchain requires the
one-time grant again. Packaging ships it for darwin, the autostart plist uses it
when present, and the distribution installer publishes it at the fixed path.

The OAuth job browser now inherits the server's outbound proxy pool
(`config:server.proxyUrl`). With `socks5://127.0.0.1:1080` configured, a real
job-scope start launched Edge with `--proxy-server=socks5://127.0.0.1:1080
--disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
which is what lets the authorize page leave an unsupported region.

Deployment note: replacing a running server binary **in place** corrupts the
ad-hoc code-signature cache and the next launch dies with
`EXC_BAD_ACCESS / CODESIGNING, Invalid Page` (SIGKILL). Write a temporary file
in the same directory and rename it over the target; the build script already
does this and manual deployments must follow the same rule.

## Remaining macOS risk

Rapidly restarting sessions on the same profile, or starting while the previous
Edge is still shutting down, can leave two Edge windows;
`browser_multiple_windows_not_supported` then ends the session. A clean
close -> start cycle leaves no Edge process and no `host.active` marker and
reproduces neither problem. Any persistent second window of at least 100x80,
including an OAuth popup, still aborts the session, so popup-based flows are not
supported on macOS yet.

## Reproduce

```sh
AIH_HOME_DIR=/private/tmp/aih-mac-oauth-home \
AIH_SERVER_API_KEY=sk-local AIH_SERVER_MANAGEMENT_KEY=mk-local \
aih-server --host 127.0.0.1 --port 19791

find /private/tmp/aih-mac-oauth-home/run/cache/account-browser/helper -name aih-browser-surface
codesign -dvv <that path>
```

Start the same task-scope surface twice and compare `stat -f '%i %m' <binary>`
between the runs; a cache hit leaves both unchanged.

## Launcher 冻结（2026-11-23）

安装流程不再覆盖已存在的 `~/.ai_home/bin/aih-launch`：TCC 记录的是它的代码身份，
每次升级替换都会让已授权失效。只有文件缺失时才安装；确实需要更新 launcher 时，
先删除该文件、重新运行安装，并接受一次新的系统授权。

## 翻译 helper 继承授权（2026-11-23）

翻译 helper 不再调用 responsibility disclaim：它作为 aih-launch 的后代启动，直接继承
launcher 的辅助功能授权，系统设置里不再需要单独的 AIH Translation 条目。旧的条目可以
删除；只有从 Finder 直接双击 AIH Translation.app 时才仍会按独立 App 授权。

## 多窗口保护调整（2026-11-23）

输入侧原先要求 Edge 只能有一个 >=100x80 的窗口，一次辅助窗口（Chat、工具栏提示、
导航弹出的新窗口）就会终止会话。现在输入固定到捕获的 windowID，键盘命令先 raise
该窗口，因此删除了 count==1 的检查；辅助窗口不再影响控制。

实测：start -> navigate -> pointer -> key -> close 全部 202，帧号从 2 增长到 11，
没有再出现 browser_multiple_windows_not_supported。
