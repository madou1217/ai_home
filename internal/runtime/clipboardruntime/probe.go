package clipboardruntime

import (
	"os/exec"

	"github.com/madou1217/ai_home/application/clipboard"
)

// Probe combines Capture, Syncer, and truthful local transport detection into clipboard.RuntimeProbe.
type Probe struct {
	capture *Capture
	syncer  *Syncer
}

// NewProbe creates a combined runtime probe for clipboard.Service.Status.
func NewProbe(capture *Capture, syncer *Syncer) *Probe {
	return &Probe{
		capture: capture,
		syncer:  syncer,
	}
}

// CaptureStatus reports local capture capability and run state.
func (p *Probe) CaptureStatus() clipboard.CaptureStatus {
	if p == nil || p.capture == nil {
		return clipboard.CaptureStatus{Supported: false, Reason: "capture runtime unavailable"}
	}
	return p.capture.Status()
}

// SyncStatus reports background sync status.
func (p *Probe) SyncStatus() clipboard.SyncStatus {
	if p == nil || p.syncer == nil {
		return clipboard.SyncStatus{}
	}
	return p.syncer.Status()
}

// Transports reports truthfully detected local transport options without claiming P2P.
func (p *Probe) Transports() []clipboard.TransportStatus {
	return DetectTransports()
}

// DetectTransports always includes server-relay and adds wireguard/tailscale only when
// real local executables are detected on PATH.
func DetectTransports() []clipboard.TransportStatus {
	transports := []clipboard.TransportStatus{
		{Name: "server-relay", Available: true},
	}
	if path, ok := lookAnyPath("wg", "wireguard-go"); ok {
		transports = append(transports, clipboard.TransportStatus{
			Name:      "wireguard",
			Available: true,
			Detail:    path,
		})
	}
	if path, ok := lookAnyPath("tailscale"); ok {
		transports = append(transports, clipboard.TransportStatus{
			Name:      "tailscale",
			Available: true,
			Detail:    path,
		})
	}
	return transports
}

func lookAnyPath(names ...string) (string, bool) {
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil && path != "" {
			return path, true
		}
	}
	return "", false
}

var _ clipboard.RuntimeProbe = (*Probe)(nil)
