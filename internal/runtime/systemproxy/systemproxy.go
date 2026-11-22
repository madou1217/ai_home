package systemproxy

import (
	"context"
	"fmt"
	"net/netip"
	"runtime"
	"strings"
	"time"
)

// Snapshot scopes identify who owns the settings being read or written.
const (
	ScopeMacOSNetworksetup  = "macos-networksetup"
	ScopeWindowsWinINET     = "windows-wininet-hkcu"
	ScopeLinuxGNOMESettings = "linux-gnome-gsettings"
)

// Action kinds returned in Result.Actions.
const (
	ActionSetWebProxy            = "set_web_proxy"
	ActionSetSecureWebProxy      = "set_secure_web_proxy"
	ActionDisableWebProxy        = "disable_web_proxy"
	ActionDisableSecureWebProxy  = "disable_secure_web_proxy"
	ActionSetBypassDomains       = "set_bypass_domains"
	ActionRegistrySet            = "registry_set"
	ActionGSettingsSet           = "gsettings_set"
	ActionNotifySettingsChanged  = "notify_settings_changed"
	ActionProxyModeChange        = "proxy_mode_change"
	ActionAuthenticationDisabled = "authentication_disabled"
)

// ProxyState is one protocol's proxy configuration.
//
// Password is deliberately absent: the package never captures credentials.
// Authentication reports whether the platform says the proxy requires
// authentication, and Username is recorded only when the platform exposes it.
type ProxyState struct {
	Enabled        bool   `json:"enabled"`
	Host           string `json:"host,omitempty"`
	Port           int    `json:"port,omitempty"`
	Authentication bool   `json:"authentication,omitempty"`
	Username       string `json:"username,omitempty"`
}

// ServiceState is the captured proxy configuration of one network service.
//
// Service is the platform identity: a macOS network service name, the WinINET
// current-user scope, or the GNOME dconf scope. HardwarePort and Device are
// best-effort macOS metadata and may be empty elsewhere.
type ServiceState struct {
	Service      string     `json:"service"`
	HardwarePort string     `json:"hardwarePort,omitempty"`
	Device       string     `json:"device,omitempty"`
	HTTP         ProxyState `json:"http"`
	HTTPS        ProxyState `json:"https"`
	Bypass       []string   `json:"bypass"`
}

// Snapshot is a point-in-time capture of host proxy settings. It is safe to
// serialize and to log: it contains no passwords.
type Snapshot struct {
	Platform   string            `json:"platform"`
	Scope      string            `json:"scope"`
	CapturedAt time.Time         `json:"capturedAt"`
	Services   []ServiceState    `json:"services"`
	Metadata   map[string]string `json:"metadata,omitempty"`
}

// Service reports the captured state for name and whether it was present.
func (s Snapshot) Service(name string) (ServiceState, bool) {
	for _, service := range s.Services {
		if service.Service == name {
			return service, true
		}
	}
	return ServiceState{}, false
}

// Service is a network service exposed by the platform.
type Service struct {
	Name         string `json:"name"`
	HardwarePort string `json:"hardwarePort,omitempty"`
	Device       string `json:"device,omitempty"`
	Enabled      bool   `json:"enabled"`
}

// Endpoint is an HTTP proxy endpoint. Password is used only to build platform
// commands and is never copied into Results, Snapshots, or errors.
type Endpoint struct {
	Host     string
	Port     int
	Username string
	Password string
}

// Authenticated reports whether any credentials were supplied.
func (e Endpoint) Authenticated() bool {
	return e.Username != "" || e.Password != ""
}

// Redacted returns a log-safe "http://[user@]host:port" representation.
func (e Endpoint) Redacted() string {
	host := e.Host
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	userinfo := ""
	if e.Username != "" {
		userinfo = e.Username + "@"
	}
	return fmt.Sprintf("http://%s%s:%d", userinfo, host, e.Port)
}

// ApplyOptions describes an Apply request.
//
// Service must name an existing network service on macOS; the package never
// guesses one. Windows and Linux have a single current-user scope and accept an
// empty Service (or the exact scope identity returned by ListServices).
//
// HTTPS is optional. When HTTPS.Host is empty the HTTP endpoint is applied to
// both the web and secure web proxy.
//
// Bypass controls bypass domains: nil leaves them untouched, while a non-nil
// empty slice clears them.
//
// ApplyOptions.AllowRemoteHost must be true before a non-loopback host is
// accepted. DryRun only computes action commands and executes nothing.
type ApplyOptions struct {
	Service         string
	HTTP            Endpoint
	HTTPS           Endpoint
	Bypass          []string
	AllowRemoteHost bool
	DryRun          bool
}

// RestoreOptions describes a Restore request.
//
// Service limits the restore to one captured service; empty restores every
// service in the snapshot. DryRun only computes action commands and executes
// nothing.
type RestoreOptions struct {
	Service string
	DryRun  bool
}

// Action is one planned or executed host mutation. Args are always redacted;
// a password argument, if any, appears as "***".
type Action struct {
	Service string   `json:"service,omitempty"`
	Kind    string   `json:"kind"`
	Command string   `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	Note    string   `json:"note,omitempty"`
}

// Result reports what Apply or Restore planned or executed. Changed is true
// when at least one action was required; with DryRun it means actions would
// have run.
type Result struct {
	Platform string   `json:"platform"`
	Scope    string   `json:"scope"`
	DryRun   bool     `json:"dryRun"`
	Changed  bool     `json:"changed"`
	Actions  []Action `json:"actions"`
}

// Capture reads the current system HTTP/HTTPS proxy configuration without
// mutating anything. Passwords are never captured.
func Capture(ctx context.Context) (Snapshot, error) {
	return currentBackend().capture(nonNilContext(ctx), commandRunner{})
}

// ListServices lists the network services the platform exposes. On Windows and
// Linux it returns the single current-user scope. Disabled services are
// reported with Enabled=false.
func ListServices(ctx context.Context) ([]Service, error) {
	return currentBackend().listServices(nonNilContext(ctx), commandRunner{})
}

// Apply points the selected network service at an HTTP proxy. It reads the live
// state first, so repeating the same request is a no-op. Validation failures
// are returned before any command runs.
func Apply(ctx context.Context, options ApplyOptions) (Result, error) {
	normalized, err := normalizeApply(options)
	if err != nil {
		return Result{Platform: runtime.GOOS}, err
	}
	backend := currentBackend()
	return backend.apply(nonNilContext(ctx), commandRunner{}, normalized)
}

// Restore replays a previously captured snapshot. It only writes settings that
// differ from the live state, which makes repeated restores idempotent.
//
// A snapshot whose captured configuration used proxy authentication cannot be
// restored faithfully because passwords are intentionally not captured; in
// that case Restore returns ErrAuthNotRestorable before mutating anything.
func Restore(ctx context.Context, snapshot Snapshot, options RestoreOptions) (Result, error) {
	if snapshot.Platform == "" || snapshot.Platform != runtime.GOOS {
		return Result{Platform: runtime.GOOS}, fmt.Errorf(
			"systemproxy: snapshot platform %q cannot be restored on %q: %w",
			snapshot.Platform, runtime.GOOS, ErrSnapshotPlatformMismatch,
		)
	}
	if err := validateSnapshot(snapshot); err != nil {
		return Result{Platform: runtime.GOOS}, err
	}
	backend := currentBackend()
	if snapshot.Scope != "" && snapshot.Scope != backend.scope() {
		return Result{Platform: runtime.GOOS}, fmt.Errorf(
			"systemproxy: snapshot scope %q cannot be restored by the %q backend: %w",
			snapshot.Scope, backend.scope(), ErrSnapshotPlatformMismatch,
		)
	}
	return backend.restore(nonNilContext(ctx), commandRunner{}, snapshot, options)
}

func nonNilContext(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}

func normalizeApply(options ApplyOptions) (ApplyOptions, error) {
	options.Service = strings.TrimSpace(options.Service)

	httpEndpoint, err := normalizeEndpoint(options.HTTP, options.AllowRemoteHost)
	if err != nil {
		return ApplyOptions{}, err
	}
	options.HTTP = httpEndpoint

	if strings.TrimSpace(options.HTTPS.Host) == "" {
		options.HTTPS = httpEndpoint
	} else {
		httpsEndpoint, err := normalizeEndpoint(options.HTTPS, options.AllowRemoteHost)
		if err != nil {
			return ApplyOptions{}, err
		}
		options.HTTPS = httpsEndpoint
	}
	options.Bypass = normalizeBypass(options.Bypass)
	return options, nil
}

func normalizeEndpoint(endpoint Endpoint, allowRemote bool) (Endpoint, error) {
	endpoint.Host = strings.TrimSpace(endpoint.Host)
	endpoint.Username = strings.TrimSpace(endpoint.Username)
	if endpoint.Password != "" && endpoint.Username == "" {
		return Endpoint{}, fmt.Errorf("systemproxy: password requires a username: %w", ErrInvalidCredentials)
	}
	if endpoint.Port < 1 || endpoint.Port > 65535 {
		return Endpoint{}, fmt.Errorf("systemproxy: proxy port %d is outside 1-65535: %w", endpoint.Port, ErrInvalidPort)
	}
	if err := validateHost(endpoint.Host); err != nil {
		return Endpoint{}, err
	}
	if !allowRemote && !isLoopbackHost(endpoint.Host) {
		return Endpoint{}, fmt.Errorf(
			"systemproxy: proxy host %q is not loopback; set AllowRemoteHost to opt in: %w",
			endpoint.Host, ErrRemoteHostNotAllowed,
		)
	}
	return endpoint, nil
}

func validateHost(host string) error {
	if host == "" {
		return fmt.Errorf("systemproxy: proxy host is empty: %w", ErrInvalidHost)
	}
	if strings.ContainsAny(host, " \t\r\n/\\@?#") || strings.Contains(host, "://") {
		return fmt.Errorf("systemproxy: proxy host %q is malformed: %w", host, ErrInvalidHost)
	}
	if strings.Contains(host, ":") {
		if _, err := netip.ParseAddr(host); err != nil {
			return fmt.Errorf("systemproxy: proxy host %q is malformed: %w", host, ErrInvalidHost)
		}
	}
	return nil
}

// isLoopbackHost reports whether host is localhost or a loopback IP literal.
func isLoopbackHost(host string) bool {
	trimmed := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if trimmed == "localhost" {
		return true
	}
	address, err := netip.ParseAddr(strings.Trim(trimmed, "[]"))
	if err != nil {
		return false
	}
	return address.IsLoopback()
}

func normalizeBypass(bypass []string) []string {
	if bypass == nil {
		return nil
	}
	normalized := make([]string, 0, len(bypass))
	for _, domain := range bypass {
		trimmed := strings.TrimSpace(domain)
		if trimmed != "" {
			normalized = append(normalized, trimmed)
		}
	}
	return normalized
}

func validateSnapshot(snapshot Snapshot) error {
	if len(snapshot.Services) == 0 {
		return nil
	}
	for _, service := range snapshot.Services {
		if strings.TrimSpace(service.Service) == "" {
			return fmt.Errorf("systemproxy: snapshot service has empty identity: %w", ErrServiceNotFound)
		}
		if err := validateCapturedState(service.HTTP); err != nil {
			return fmt.Errorf("systemproxy: snapshot service %q http: %w", service.Service, err)
		}
		if err := validateCapturedState(service.HTTPS); err != nil {
			return fmt.Errorf("systemproxy: snapshot service %q https: %w", service.Service, err)
		}
	}
	return nil
}

func validateCapturedState(state ProxyState) error {
	if !state.Enabled {
		return nil
	}
	if state.Host == "" {
		return fmt.Errorf("systemproxy: enabled proxy has empty host: %w", ErrInvalidHost)
	}
	if state.Port < 1 || state.Port > 65535 {
		return fmt.Errorf("systemproxy: proxy port %d is outside 1-65535: %w", state.Port, ErrInvalidPort)
	}
	return nil
}

func newServiceState(service, hardwarePort, device string) ServiceState {
	return ServiceState{
		Service:      service,
		HardwarePort: hardwarePort,
		Device:       device,
		Bypass:       []string{},
	}
}

func emptySnapshot(scope string) Snapshot {
	return Snapshot{
		Platform:   runtime.GOOS,
		Scope:      scope,
		CapturedAt: time.Now().UTC(),
		Services:   []ServiceState{},
	}
}

// stateDiffers compares a live and desired state. When the desired state is
// disabled, host/port values are irrelevant because the proxy is not used.
func stateDiffers(current, desired ProxyState) bool {
	if current.Enabled != desired.Enabled {
		return true
	}
	if !desired.Enabled {
		return false
	}
	return current.Host != desired.Host ||
		current.Port != desired.Port ||
		current.Authentication != desired.Authentication
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func restoreTargets(snapshot Snapshot, options RestoreOptions) ([]ServiceState, error) {
	name := strings.TrimSpace(options.Service)
	if name == "" {
		return snapshot.Services, nil
	}
	service, found := snapshot.Service(name)
	if !found {
		return nil, fmt.Errorf("systemproxy: snapshot has no service %q: %w", name, ErrServiceNotFound)
	}
	return []ServiceState{service}, nil
}

func authRequired(service ServiceState) bool {
	return service.HTTP.Authentication || service.HTTPS.Authentication
}
