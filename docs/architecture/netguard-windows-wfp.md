# aih-netguard WFP callout (Windows)

Per-process network enforcement for AIH instances. The driver registers a WFP
callout at `FWPM_LAYER_ALE_AUTH_CONNECT_V4/V6` and blocks every outbound
connection whose owning process is in the PID set supplied by user mode.
Loopback destinations are always permitted so the instance can reach its local
proxy listener (and AIH's own gateway/OAuth callbacks); every external
destination is blocked unless the proxy (or an allowed local service) forwards
it.

This is the strict backend. It complements the user-mode WinDivert P0 prototype
(`internal/runtime/netguard/windivert_windows.go`), which cannot attribute UDP
or IPv6 traffic.

## Layout

| File | Purpose |
| --- | --- |
| `driver.c` | WFP callout driver (no WDF; plain WDM + `fwpkclnt`) |
| `build.ps1` | Compiles `driver.c` to `aih-netguard.sys` |
| `sign.ps1` | Creates/reuses a test code-signing certificate and signs the `.sys` |
| `install.ps1` | Copies the driver to `System32\drivers`, registers the `AihNetGuard` service |

## Build prerequisites

A full WDK install provides `ntdef.h`, `dpfilter.h`, `fwpstypes.h` and the UCRT
headers. This build currently uses the WDK NuGet package (`Microsoft.Windows.WDK.x64`)
for `ntddk.h`/`fwpsk.h`/`ntoskrnl.lib`, plus the matched 16299 header tree from
the public `tpn/winsdk-10` mirror for the base headers the NuGet package omits.
The script expects:

- `%TEMP%\wdk-nuget\x\c` — extracted `Microsoft.Windows.WDK.x64` NuGet package
- `%TEMP%\winsdk10\winsdk-10-master\Include\10.0.16299.0` — extracted mirror

Build:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

Produces `aih-netguard.sys` next to the script.

## Sign (test only)

```powershell
powershell -ExecutionPolicy Bypass -File sign.ps1
```

Creates a self-signed code-signing certificate (`CN=AIH NetGuard Test`) in
`LocalMachine\My`, trusts it in `LocalMachine\Root` and `TrustedPublisher`, and
embeds a signature in the driver. This is for test-signing development machines
only; production needs an EV certificate and Microsoft attestation signing.

## Load

Test signing must be enabled (Secure Boot off) and the machine rebooted once:

```powershell
bcdedit /set testsigning on
shutdown /r /t 0
```

Then, as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Start
```

If `sc start` fails with error 577, test signing is not active yet.

## Protocol

- Device: `\\.\AihNetGuard`
- `IOCTL_SET_PIDS` (`0x222004`): input `ULONG count` followed by `count` x
  `ULONG` PIDs; replaces the protected set.
- `IOCTL_GET_STATUS` (`0x222008`): output `ULONG count`, `ULONG blocked`.

## Known limits (tracked in `docs/architecture/netguard-roadmap.md`)

- PID reuse after an instance exits is not yet detected in-kernel; user mode
  must remove dead PIDs promptly (the Go adapter watches the process tree).
- Existing connections opened before the PID set is applied are not revoked.
- Loopback is allowed wholesale; per-port allowlisting is a later refinement.
- The driver is test-signed; production signing is not done.
- One global PID set: multiple AIH instances share it (the Go controller
  maintains the union), which matches the block-external semantics.