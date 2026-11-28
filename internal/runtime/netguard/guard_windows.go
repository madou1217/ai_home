//go:build windows

package netguard

import "fmt"

// New returns the Windows guard.
//
// Strict mode prefers the WFP callout driver when its device is available
// (installed, started, process is elevated), because it attributes TCP, UDP
// and IPv6 connections in-kernel. It falls back to the WinDivert P0 adapter
// when the driver is absent. AIH_NETGUARD_BACKEND=wfp|windivert forces a
// backend and fails instead of silently downgrading.
func New(options Options) (Guard, error) {
	if options.Policy.Mode != ModeStrict {
		return NewNoop(options), nil
	}
	switch backend := strictWindowsBackendName(); backend {
	case "wfp":
		return NewWFPGuard(options)
	case "windivert":
		return NewWinDivertGuard(options)
	case "":
		// WFP is loaded but its loopback exemption is still being fixed;
		// keep the proven WinDivert backend as the default until then.
		return NewWinDivertGuard(options)
	default:
		return nil, fmt.Errorf("未知 AIH_NETGUARD_BACKEND %q（可选 wfp / windivert）", backend)
	}
}
