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

## Remaining macOS blockers (not fixed here)

A real OpenAI login was not completed on macOS. Two input-path problems showed
up while driving the OAuth URL, and both are outside the build cache:

1. `navigate` types the URL through Cmd+L and Return using `postToPid`. When the
   Edge window is not the active application, Return frequently does not
   commit the omnibox; the address bar keeps the typed text and the tab title
   stays `about:blank`. Activating Microsoft Edge first made the address bar
   enter the loading state, so window activation is the missing piece
   (Windows already activates its surface for the same reason).
2. After a successful navigation, the helper reported
   `browser_multiple_windows_not_supported` and stopped the session, freezing
   frames. A window probe during a later run showed the browser window plus a
   small auxiliary layer-0 window owned by the same Edge process. The input
   guard requires exactly one on-screen window of at least 100x80, so a
   transient or auxiliary window aborts the session. OAuth flows also open
   popups, which the same guard would reject.

Next step: activate the owned window before synthetic input and decide how to
treat extra Edge windows (ignore windows other than the captured one, or make
the single-window violation retryable instead of fatal). Until then, real
OAuth logins should use the Windows execution host.

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
