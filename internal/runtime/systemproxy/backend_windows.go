//go:build windows

package systemproxy

import (
	"context"
	"fmt"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

const (
	windowsInternetSettingsKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
	windowsServiceName         = "WinINET (current user)"
	windowsRegCommand          = "reg.exe"

	internetOptionRefresh         = 37
	internetOptionSettingsChanged = 39
)

var internetSetOptionW = syscall.NewLazyDLL("wininet.dll").NewProc("InternetSetOptionW")

type windowsBackend struct{}

func currentBackend() backend {
	return windowsBackend{}
}

func (windowsBackend) scope() string {
	return ScopeWindowsWinINET
}

func (backend windowsBackend) capture(ctx context.Context, run runner) (Snapshot, error) {
	state, err := readWindowsServiceState(ctx, run)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot := emptySnapshot(ScopeWindowsWinINET)
	snapshot.Services = append(snapshot.Services, state)
	return snapshot, nil
}

func (windowsBackend) listServices(context.Context, runner) ([]Service, error) {
	// WinINET proxy settings are per user, not per network adapter. The single
	// scope is always available without administrator rights.
	return []Service{{Name: windowsServiceName, Enabled: true}}, nil
}

func (backend windowsBackend) apply(ctx context.Context, run runner, options ApplyOptions) (Result, error) {
	if options.Service != "" && options.Service != windowsServiceName {
		return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, fmt.Errorf(
			"systemproxy: service %q is not the WinINET scope %q: %w",
			options.Service, windowsServiceName, ErrServiceNotFound,
		)
	}
	if options.HTTP.Authenticated() || options.HTTPS.Authenticated() {
		return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, fmt.Errorf(
			"systemproxy: WinINET registry settings cannot store proxy credentials: %w", ErrAuthUnsupported,
		)
	}

	current, err := readWindowsServiceState(ctx, run)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, err
	}

	desiredHTTP := ProxyState{Enabled: true, Host: options.HTTP.Host, Port: options.HTTP.Port}
	desiredHTTPS := ProxyState{Enabled: true, Host: options.HTTPS.Host, Port: options.HTTPS.Port}

	changes := newPlan("apply", ScopeWindowsWinINET)
	addWindowsProxySteps(changes, current, desiredHTTP, desiredHTTPS)
	addWindowsBypassSteps(changes, current.Bypass, options.Bypass)
	if !changes.empty() {
		changes.addAction(windowsServiceName, ActionNotifySettingsChanged,
			"broadcast WinINET settings change to running processes", notifyWindowsInternetSettings)
	}
	return changes.execute(ctx, run, options.DryRun)
}

func (backend windowsBackend) restore(ctx context.Context, run runner, snapshot Snapshot, options RestoreOptions) (Result, error) {
	targets, err := restoreTargets(snapshot, options)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, err
	}
	changes := newPlan("restore", ScopeWindowsWinINET)
	for _, target := range targets {
		if target.Service != windowsServiceName {
			return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, fmt.Errorf(
				"systemproxy: snapshot service %q is not the WinINET scope %q: %w",
				target.Service, windowsServiceName, ErrServiceNotFound,
			)
		}
		if authRequired(target) {
			return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, fmt.Errorf(
				"systemproxy: snapshot service %q used proxy authentication whose password was not captured: %w",
				target.Service, ErrAuthNotRestorable,
			)
		}
		current, err := readWindowsServiceState(ctx, run)
		if err != nil {
			return Result{Platform: runtime.GOOS, Scope: ScopeWindowsWinINET}, err
		}
		addWindowsProxySteps(changes, current, target.HTTP, target.HTTPS)
		addWindowsBypassSteps(changes, current.Bypass, target.Bypass)
	}
	if !changes.empty() {
		changes.addAction(windowsServiceName, ActionNotifySettingsChanged,
			"broadcast WinINET settings change to running processes", notifyWindowsInternetSettings)
	}
	return changes.execute(ctx, run, options.DryRun)
}

func readWindowsServiceState(ctx context.Context, run runner) (ServiceState, error) {
	state := newServiceState(windowsServiceName, "", "")
	outcome := run.Run(ctx, windowsRegCommand, "query", windowsInternetSettingsKey)
	if !outcome.OK() {
		if outcome.Err != nil {
			return ServiceState{}, failedDetection("WinINET registry settings", outcome)
		}
		if windowsKeyMissing(outcome) {
			return state, nil
		}
		return ServiceState{}, failedDetection("WinINET registry settings", outcome)
	}

	values := parseWindowsRegistryValues(outcome.Stdout)
	state.Bypass = parseWindowsOverrides(values["proxyoverride"])

	if !windowsProxyEnabled(values["proxyenable"]) {
		return state, nil
	}
	proxies := parseWindowsProxyServer(values["proxyserver"])
	state.HTTP = proxies["http"]
	state.HTTPS = proxies["https"]
	return state, nil
}

func windowsKeyMissing(outcome runResult) bool {
	lower := strings.ToLower(outcome.Stderr + "\n" + outcome.Stdout)
	return strings.Contains(lower, "unable to find") ||
		strings.Contains(lower, "cannot find") ||
		strings.Contains(lower, "system cannot find") ||
		strings.Contains(lower, "not found")
}

func parseWindowsRegistryValues(output string) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		if !strings.HasPrefix(strings.ToUpper(fields[1]), "REG_") {
			continue
		}
		values[strings.ToLower(fields[0])] = strings.Join(fields[2:], " ")
	}
	return values
}

func windowsProxyEnabled(raw string) bool {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return false
	}
	base := 10
	if strings.HasPrefix(strings.ToLower(trimmed), "0x") {
		base = 16
		trimmed = trimmed[2:]
	}
	value, err := strconv.ParseInt(trimmed, base, 64)
	return err == nil && value == 1
}

func parseWindowsOverrides(raw string) []string {
	overrides := []string{}
	for _, item := range strings.Split(raw, ";") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			overrides = append(overrides, trimmed)
		}
	}
	return overrides
}

// parseWindowsProxyServer understands both the single-endpoint form
// ("host:port") and the per-protocol form ("http=host:port;https=host:port").
// Credentials embedded in a value are recorded as authentication with a
// username only; the password is discarded and never captured.
func parseWindowsProxyServer(raw string) map[string]ProxyState {
	proxies := map[string]ProxyState{}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return proxies
	}
	if !strings.Contains(trimmed, "=") {
		state, ok := parseWindowsEndpoint(trimmed)
		if ok {
			proxies["http"] = state
			proxies["https"] = state
		}
		return proxies
	}
	for _, segment := range strings.Split(trimmed, ";") {
		key, value, found := strings.Cut(segment, "=")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if key != "http" && key != "https" {
			continue
		}
		if state, ok := parseWindowsEndpoint(value); ok {
			proxies[key] = state
		}
	}
	return proxies
}

func parseWindowsEndpoint(raw string) (ProxyState, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ProxyState{}, false
	}
	candidate := trimmed
	if !strings.Contains(candidate, "://") {
		candidate = "http://" + candidate
	}
	parsed, err := url.Parse(candidate)
	if err != nil || parsed.Hostname() == "" {
		return ProxyState{}, false
	}
	portText := parsed.Port()
	if portText == "" {
		return ProxyState{}, false
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return ProxyState{}, false
	}
	state := ProxyState{Enabled: true, Host: parsed.Hostname(), Port: port}
	if parsed.User != nil {
		state.Authentication = true
		state.Username = parsed.User.Username()
	}
	return state, true
}

func addWindowsProxySteps(changes *plan, current ServiceState, desiredHTTP, desiredHTTPS ProxyState) {
	desiredEnabled := desiredHTTP.Enabled || desiredHTTPS.Enabled
	if !desiredEnabled {
		if current.HTTP.Enabled || current.HTTPS.Enabled {
			changes.addCommand(windowsServiceName, ActionRegistrySet, windowsRegCommand,
				[]string{"add", windowsInternetSettingsKey, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"}, nil)
		}
		return
	}

	currentEnabled := current.HTTP.Enabled || current.HTTPS.Enabled
	if currentEnabled &&
		!stateDiffers(current.HTTP, desiredHTTP) &&
		!stateDiffers(current.HTTPS, desiredHTTPS) {
		return
	}

	server := windowsProxyServerValue(desiredHTTP, desiredHTTPS)
	changes.addCommand(windowsServiceName, ActionRegistrySet, windowsRegCommand,
		[]string{"add", windowsInternetSettingsKey, "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"}, nil)
	changes.addCommand(windowsServiceName, ActionRegistrySet, windowsRegCommand,
		[]string{"add", windowsInternetSettingsKey, "/v", "ProxyServer", "/t", "REG_SZ", "/d", server, "/f"}, nil)
}

func windowsProxyServerValue(httpState, httpsState ProxyState) string {
	parts := make([]string, 0, 2)
	if httpState.Enabled {
		parts = append(parts, fmt.Sprintf("http=%s:%d", httpState.Host, httpState.Port))
	}
	if httpsState.Enabled {
		parts = append(parts, fmt.Sprintf("https=%s:%d", httpsState.Host, httpsState.Port))
	}
	return strings.Join(parts, ";")
}

func addWindowsBypassSteps(changes *plan, current []string, desired []string) {
	if desired == nil || equalStrings(current, desired) {
		return
	}
	changes.addCommand(windowsServiceName, ActionRegistrySet, windowsRegCommand,
		[]string{
			"add", windowsInternetSettingsKey,
			"/v", "ProxyOverride", "/t", "REG_SZ",
			"/d", strings.Join(desired, ";"), "/f",
		}, nil)
}

func notifyWindowsInternetSettings() error {
	for _, option := range []uintptr{internetOptionSettingsChanged, internetOptionRefresh} {
		result, _, callErr := internetSetOptionW.Call(0, option, 0, 0)
		if result != 0 {
			continue
		}
		if callErr != nil && callErr != syscall.Errno(0) {
			return callErr
		}
		return fmt.Errorf("InternetSetOptionW option %d failed", option)
	}
	return nil
}
