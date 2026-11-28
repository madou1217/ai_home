// Package netguard defines the platform-neutral contract for per-instance
// network enforcement.
//
// A guard is attached to one launch instance (a process tree, not a single
// PID). strict mode must make every non-allowlisted external connection fail;
// it must never fall back to the direct network. Platform adapters own the
// actual mechanism (WinDivert/WFP, sandbox, cgroup/netns) and report their
// real capability instead of pretending strict is available.
package netguard

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// Mode is the network policy requested for an instance.
type Mode string

const (
	// ModeDirect explicitly allows direct network access.
	ModeDirect Mode = "direct"
	// ModeCooperative injects proxy settings but does not block bypasses.
	ModeCooperative Mode = "cooperative"
	// ModeStrict only allows the configured proxy (and loopback allowlist);
	// every other external connection must fail.
	ModeStrict Mode = "strict_proxy"
)

// ProxyKind identifies how the proxy endpoint is chosen.
type ProxyKind string

const (
	ProxyDirect   ProxyKind = "direct"
	ProxyLocal    ProxyKind = "local"
	ProxySelector ProxyKind = "selector"
	ProxyURL      ProxyKind = "url"
)

// ProxySpec is the durable, user-visible proxy selection. It deliberately
// stores a selector rather than a resolved node so a remembered region can be
// re-resolved on the next launch.
type ProxySpec struct {
	Kind     ProxyKind `json:"kind"`
	Selector string    `json:"selector,omitempty"`
	URL      string    `json:"url,omitempty"`
}

// Normalize trims and validates the selector/URL fields.
func (spec ProxySpec) Normalize() (ProxySpec, error) {
	spec.Selector = strings.TrimSpace(spec.Selector)
	spec.URL = strings.TrimSpace(spec.URL)
	switch spec.Kind {
	case ProxyDirect:
		return spec, nil
	case ProxyLocal:
		return spec, nil
	case ProxySelector:
		if spec.Selector == "" || strings.ContainsAny(spec.Selector, "\r\n\x00") {
			return ProxySpec{}, errors.New("代理选择器为空或包含控制字符")
		}
	case ProxyURL:
		if spec.URL == "" || strings.ContainsAny(spec.URL, "\r\n\x00") {
			return ProxySpec{}, errors.New("代理 URL 为空或包含控制字符")
		}
	default:
		return ProxySpec{}, fmt.Errorf("未知代理类型 %q", spec.Kind)
	}
	return spec, nil
}

// DNSMode controls how names are resolved under a strict guard.
type DNSMode string

const (
	// DNSProxy requires proxy-side resolution; local DNS must not escape.
	DNSProxy DNSMode = "proxy"
	// DNSBridge sends DNS through a local DoH/DoT bridge that uses the proxy.
	DNSBridge DNSMode = "doh_bridge"
	// DNSLocal explicitly permits local resolvers (not strict DNS).
	DNSLocal DNSMode = "local"
)

// Policy is the complete network policy for one launch.
type Policy struct {
	Mode  Mode      `json:"mode"`
	Proxy ProxySpec `json:"proxy"`
	DNS   DNSMode   `json:"dns"`
	// AllowLoopback lists additional loopback ports allowed for this instance
	// (AIH gateway, MCP servers, OAuth callbacks). The proxy port is always
	// allowed by the platform adapter.
	AllowLoopback []int `json:"allowLoopback,omitempty"`
}

// Validate checks the combination before a launch is attempted.
func (policy Policy) Validate(proxyURL string) error {
	if policy.Mode != ModeDirect && policy.Mode != ModeCooperative && policy.Mode != ModeStrict {
		return fmt.Errorf("未知网络策略 %q", policy.Mode)
	}
	if policy.Mode == ModeStrict {
		if strings.TrimSpace(proxyURL) == "" {
			return errors.New("strict_proxy 需要已解析的代理入口")
		}
		if policy.DNS != DNSProxy && policy.DNS != DNSBridge {
			return errors.New("strict_proxy 只允许 DNSProxy 或 DNSBridge")
		}
	}
	return nil
}

// Target identifies what is being launched.
type Target struct {
	Provider     string `json:"provider"`
	Surface      string `json:"surface"` // cli | desktop
	AccountRef   string `json:"accountRef,omitempty"`
	InstanceSlot string `json:"instanceSlot,omitempty"`
}

// Profile is the remembered launch configuration for a target.
type Profile struct {
	Target      Target `json:"target"`
	Policy      Policy `json:"policy"`
	LastProxy   string `json:"lastProxy,omitempty"`
	LastExitIP  string `json:"lastExitIP,omitempty"`
	LastSuccess int64  `json:"lastSuccess,omitempty"`
	UpdatedAt   int64  `json:"updatedAt,omitempty"`
}

// GuardStatus is the observable state of one guard.
type GuardStatus struct {
	Active        bool    `json:"active"`
	Mode          Mode    `json:"mode"`
	Backend       string  `json:"backend"` // windivert | wfp | sandbox | cgroup
	DNSMode       DNSMode `json:"dnsMode,omitempty"`
	ProtectedPIDs int     `json:"protectedPids"`
	Blocked       uint64  `json:"blocked"`
	LastError     string  `json:"lastError,omitempty"`
}

// Audit is evidence collected from the guard/host for one instance.
type Audit struct {
	ExternalSockets []string `json:"externalSockets,omitempty"`
	ExitIP          string   `json:"exitIP,omitempty"`
	DNSMode         DNSMode  `json:"dnsMode,omitempty"`
	Notes           []string `json:"notes,omitempty"`
}

// Guard enforces one instance's Policy.
type Guard interface {
	// Start prepares the platform mechanism. It must be called before app
	// packets are allowed to flow.
	Start(ctx context.Context) error
	// SetProcessTree attaches the instance root and current descendants.
	// Implementations may start a watcher for future children.
	SetProcessTree(ctx context.Context, rootPID int, pids []int) error
	// Stop removes all enforcement and releases resources.
	Stop(ctx context.Context) error
	Status() GuardStatus
	Audit(ctx context.Context) (Audit, error)
}

// Options configures a guard.
type Options struct {
	InstanceID string
	Policy     Policy
	// ProxyURL is the resolved local proxy endpoint, e.g.
	// http://127.0.0.1:61687. Required for strict mode.
	ProxyURL string
}

// ErrUnsupportedStrict means this platform/build cannot currently provide a
// strict guard. Callers must refuse the launch or require explicit downgrade.
var ErrUnsupportedStrict = errors.New("当前平台暂不支持 strict_proxy")

// NoopGuard implements direct/cooperative modes and is used by platform builds
// that do not yet have a strict adapter.
type NoopGuard struct {
	options Options
	status  GuardStatus
}

// NewNoop creates a guard that performs no network enforcement.
func NewNoop(options Options) *NoopGuard {
	return &NoopGuard{options: options, status: GuardStatus{Mode: options.Policy.Mode}}
}

func (guard *NoopGuard) Start(context.Context) error {
	guard.status.Active = true
	return nil
}

func (guard *NoopGuard) SetProcessTree(_ context.Context, rootPID int, pids []int) error {
	guard.status.ProtectedPIDs = len(pids)
	if guard.status.ProtectedPIDs == 0 && rootPID > 0 {
		guard.status.ProtectedPIDs = 1
	}
	return nil
}

func (guard *NoopGuard) Stop(context.Context) error {
	guard.status.Active = false
	return nil
}

func (guard *NoopGuard) Status() GuardStatus { return guard.status }

func (guard *NoopGuard) Audit(context.Context) (Audit, error) {
	return Audit{DNSMode: guard.options.Policy.DNS}, nil
}
