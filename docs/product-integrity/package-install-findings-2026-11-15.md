# Package components and installer ownership checkpoint

## PKG-01 missing required CLI

Actual old `copyGoCore` using repository native binaries produced a temporary directory with aih-server and no aih-go, though public CLI routes require it. The build default skipped Go and compilation errors were warnings.

Now: release builds both Server and CLI by default; errors are fatal. Dedicated `native-components.js` requires both files and verifies the Server stamp hash/target before copying. Copied artifacts both exist, copied aih-go --help exit0; missing source component rejected explicitly. No full npm/runtime/Web/SFX release build or published package verified yet; cross-target executable architecture and CLI stamp remain further checks.

## PKG-02 destructive prefix ownership

Actual old generated POSIX `--uninstall --prefix <unrelated temp dir>` deleted a user sentinel and exited0. No system/user real directory was used.

New installer adapters:
- templates split into installers/posix.sh and windows.ps1; bundle composition only loads/writes them.
- canonical root/HOME/AIH data/ancestor rejection; explicit receipt matching installed prefix before uninstall or nonempty owned replacement.
- foreign aih link is neither replaced nor removed; matching link only.
- exclusively created staging/backup paths; Windows replacement failure restores previous directory; no blind removal of predictable PID temporary directories.
- unowned legacy installations fail closed by default. Explicit preserve-existing moves the original aside and keeps it permanently, rather than deleting or silently adopting it.
- generated PS script keeps BOM byte0 for PS5.1 Chinese parsing; Windows reparse-point guard is source-only here.

Actual isolated POSIX validation: unowned uninstall rejects and preserves sentinel; install/reinstall succeeds; unowned source preserve-existing upgrade keeps old sentinel; uninstall removes only owned install/link; a foreign link survives; root/HOME and missing args reject. Evidence: installer-ownership-evidence and installer-upgrade-evidence JSON.

First guarded run exposed /bin/sh multibyte variable-boundary output corruption; final printf output is intact in upgrade evidence. Initial evidence is retained as before/imperfect-run record, not overwritten to fake a clean history.

## Remaining

Independent review found four issues (Windows wildcard source, POSIX signal rollback, PS5 receipt decoding, incomplete stamp validation). All four have code corrections; final focused rereview accepted all four source corrections. Windows PS5/7 runtime unavailable, not certified. Full bundled runtime/Web/Go integration, target packaging, source/stamp coherence, rollback on real filesystem errors, concurrent installer ownership and pathological path inputs need continued verification. No actual release, user PATH/profile, production autostart or installed system software changed. No test cases added.

### Review correction evidence boundary

- Windows copy now enumerates LiteralPath children and validates stage components before replacing; receipt uses explicit UTF8. No PS runtime available, not claimed executed.
- POSIX EXIT cleanup knows backup/publication state and restores moved original if target absent; subsequent actual normal install/reinstall/uninstall all exit0. Precise interruption gap was source-reviewed, not artificially paused via a fake mv.
- Native component copying calls the same runtime verifyBuildStamp for schema/hash/version/route, retains target check; actual existing artifacts pass copied-component verification.

Final reviewer scope: current literal copy/stage validation, EXIT rollback, UTF8 receipt, shared stamp verifier confirmed. No independently executed Windows/interruption test; those gates remain open.

POSIX含空格/单引号路径的实际安装和卸载均exit0；symlink安装目标拒绝且外部sentinel/链接保留。最新验证仍不是Windows或完整SFX发布验收。

## Resumed checkpoint verification (2026-11-15)

- Current five source files still match their reviewed SHA-256 snapshot; JS syntax and POSIX shell syntax checks pass.
- Actual generated POSIX installer in an isolated HOME: install, reinstall, and uninstall all exit 0, including a path with spaces and a single quote. Unowned uninstall exits 1 and preserves its sentinel. No user installation or profile changed.
- Before the peer rebuild, native copying correctly rejected a stale route-ownership stamp. After the separately managed rebuild, actual Server/CLI copy and copied CLI `--help` pass. This session did not rebuild, deploy, or restart the shared gateway.
- PowerShell BOM verified only; Windows execution and a complete published bundle remain unverified.
