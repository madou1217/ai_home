//go:build linux

package systemproxy

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
)

const (
	gsettingsCommand      = "gsettings"
	linuxServiceName      = "GNOME (dconf)"
	linuxProxySchema      = "org.gnome.system.proxy"
	linuxHTTPProxySchema  = "org.gnome.system.proxy.http"
	linuxHTTPSProxySchema = "org.gnome.system.proxy.https"
	linuxProxyModeKey     = "gnome.proxy.mode"
)

type linuxBackend struct{}

func currentBackend() backend {
	return linuxBackend{}
}

func (linuxBackend) scope() string {
	return ScopeLinuxGNOMESettings
}

func (backend linuxBackend) capture(ctx context.Context, run runner) (Snapshot, error) {
	mode, err := linuxProxyMode(ctx, run)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot := emptySnapshot(ScopeLinuxGNOMESettings)
	snapshot.Metadata = map[string]string{linuxProxyModeKey: mode}

	state := newServiceState(linuxServiceName, "", "")
	if mode == "manual" {
		if state.HTTP, err = captureLinuxProxyState(ctx, run, linuxHTTPProxySchema, true); err != nil {
			return Snapshot{}, err
		}
		if state.HTTPS, err = captureLinuxProxyState(ctx, run, linuxHTTPSProxySchema, false); err != nil {
			return Snapshot{}, err
		}
	}
	bypass, err := gsettingsGet(ctx, run, linuxProxySchema, "ignore-hosts")
	if err != nil {
		return Snapshot{}, err
	}
	state.Bypass = parseGVariantStrings(bypass)
	snapshot.Services = append(snapshot.Services, state)
	return snapshot, nil
}

func (backend linuxBackend) listServices(ctx context.Context, run runner) ([]Service, error) {
	if _, err := linuxProxyMode(ctx, run); err != nil {
		return nil, err
	}
	return []Service{{Name: linuxServiceName, Enabled: true}}, nil
}

func (backend linuxBackend) apply(ctx context.Context, run runner, options ApplyOptions) (Result, error) {
	if options.Service != "" && options.Service != linuxServiceName {
		return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, fmt.Errorf(
			"systemproxy: service %q is not the GNOME scope %q: %w",
			options.Service, linuxServiceName, ErrServiceNotFound,
		)
	}
	if options.HTTP.Authenticated() || options.HTTPS.Authenticated() {
		return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, fmt.Errorf(
			"systemproxy: GNOME proxy credentials are not applied by this package: %w", ErrAuthUnsupported,
		)
	}

	snapshot, err := backend.capture(ctx, run)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, err
	}
	current := snapshot.Services[0]
	desiredHTTP := ProxyState{Enabled: true, Host: options.HTTP.Host, Port: options.HTTP.Port}
	desiredHTTPS := ProxyState{Enabled: true, Host: options.HTTPS.Host, Port: options.HTTPS.Port}

	changes := newPlan("apply", ScopeLinuxGNOMESettings)
	addLinuxProxySteps(changes, linuxHTTPProxySchema, current.HTTP, desiredHTTP)
	addLinuxProxySteps(changes, linuxHTTPSProxySchema, current.HTTPS, desiredHTTPS)
	if current.HTTP.Authentication {
		addLinuxAuthDisableSteps(changes)
	}
	addLinuxBypassSteps(changes, current.Bypass, options.Bypass)
	addLinuxModeSteps(changes, snapshot.Metadata[linuxProxyModeKey], "manual")
	return changes.execute(ctx, run, options.DryRun)
}

func (backend linuxBackend) restore(ctx context.Context, run runner, snapshot Snapshot, options RestoreOptions) (Result, error) {
	targets, err := restoreTargets(snapshot, options)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, err
	}
	currentSnapshot, err := backend.capture(ctx, run)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, err
	}
	current := currentSnapshot.Services[0]

	mode := snapshot.Metadata[linuxProxyModeKey]
	if mode == "" {
		mode = "none"
		for _, target := range targets {
			if target.HTTP.Enabled || target.HTTPS.Enabled {
				mode = "manual"
			}
		}
	}
	changes := newPlan("restore", ScopeLinuxGNOMESettings)
	for _, target := range targets {
		if target.Service != linuxServiceName {
			return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, fmt.Errorf(
				"systemproxy: snapshot service %q is not the GNOME scope %q: %w",
				target.Service, linuxServiceName, ErrServiceNotFound,
			)
		}
		if authRequired(target) {
			return Result{Platform: runtime.GOOS, Scope: ScopeLinuxGNOMESettings}, fmt.Errorf(
				"systemproxy: snapshot service %q used proxy authentication whose password was not captured: %w",
				target.Service, ErrAuthNotRestorable,
			)
		}
		if mode == "manual" {
			addLinuxProxySteps(changes, linuxHTTPProxySchema, current.HTTP, target.HTTP)
			addLinuxProxySteps(changes, linuxHTTPSProxySchema, current.HTTPS, target.HTTPS)
			if current.HTTP.Authentication {
				addLinuxAuthDisableSteps(changes)
			}
		}
		addLinuxBypassSteps(changes, current.Bypass, target.Bypass)
	}
	addLinuxModeSteps(changes, currentSnapshot.Metadata[linuxProxyModeKey], mode)
	return changes.execute(ctx, run, options.DryRun)
}

func captureLinuxProxyState(ctx context.Context, run runner, schema string, withAuth bool) (ProxyState, error) {
	host, err := gsettingsGet(ctx, run, schema, "host")
	if err != nil {
		return ProxyState{}, err
	}
	portText, err := gsettingsGet(ctx, run, schema, "port")
	if err != nil {
		return ProxyState{}, err
	}
	port, err := strconv.Atoi(strings.TrimSpace(portText))
	if err != nil {
		port = 0
	}
	state := ProxyState{Host: gvariantFirst(host), Port: port}
	state.Enabled = state.Host != "" && state.Port > 0
	if withAuth {
		auth, err := gsettingsGet(ctx, run, schema, "use-authentication")
		if err != nil {
			return ProxyState{}, err
		}
		state.Authentication = strings.TrimSpace(auth) == "true"
		if state.Authentication {
			user, err := gsettingsGet(ctx, run, schema, "authentication-user")
			if err != nil {
				return ProxyState{}, err
			}
			state.Username = gvariantFirst(user)
		}
	}
	return state, nil
}

func linuxProxyMode(ctx context.Context, run runner) (string, error) {
	raw, err := gsettingsGet(ctx, run, linuxProxySchema, "mode")
	if err != nil {
		return "", err
	}
	mode := strings.Trim(strings.TrimSpace(raw), "'")
	if mode == "" {
		mode = "none"
	}
	return mode, nil
}

func gsettingsGet(ctx context.Context, run runner, schema, key string) (string, error) {
	outcome := run.Run(ctx, gsettingsCommand, "get", schema, key)
	if !outcome.OK() {
		return "", gsettingsProbeFailure(schema+" "+key, outcome)
	}
	return strings.TrimSpace(outcome.Stdout), nil
}

func gsettingsProbeFailure(op string, outcome runResult) error {
	if outcome.Err != nil {
		if errors.Is(outcome.Err, exec.ErrNotFound) {
			return fmt.Errorf("systemproxy: gsettings is not available: %v: %w", outcome.Err, ErrUnsupportedScope)
		}
		return failedDetection(op, outcome)
	}
	lower := strings.ToLower(outcome.Stderr)
	if strings.Contains(lower, "no such schema") ||
		(strings.Contains(lower, "schema") && strings.Contains(lower, "not found")) {
		return fmt.Errorf("systemproxy: GNOME proxy schema is not available: %w", ErrUnsupportedScope)
	}
	return failedDetection(op, outcome)
}

// addLinuxProxySteps writes host and port for one GNOME proxy schema. GNOME has
// no per-protocol enabled flag in manual mode: an empty host disables it.
func addLinuxProxySteps(changes *plan, schema string, current, desired ProxyState) {
	if !desired.Enabled {
		if current.Enabled {
			changes.addCommand(linuxServiceName, ActionGSettingsSet, gsettingsCommand,
				[]string{"set", schema, "host", gvariantQuote("")}, nil)
			changes.addCommand(linuxServiceName, ActionGSettingsSet, gsettingsCommand,
				[]string{"set", schema, "port", "0"}, nil)
		}
		return
	}
	if !stateDiffers(current, desired) {
		return
	}
	changes.addCommand(linuxServiceName, ActionGSettingsSet, gsettingsCommand,
		[]string{"set", schema, "host", gvariantQuote(desired.Host)}, nil)
	changes.addCommand(linuxServiceName, ActionGSettingsSet, gsettingsCommand,
		[]string{"set", schema, "port", strconv.Itoa(desired.Port)}, nil)
}

func addLinuxAuthDisableSteps(changes *plan) {
	changes.addCommand(linuxServiceName, ActionAuthenticationDisabled, gsettingsCommand,
		[]string{"set", linuxHTTPProxySchema, "use-authentication", "false"}, nil)
	changes.addCommand(linuxServiceName, ActionAuthenticationDisabled, gsettingsCommand,
		[]string{"set", linuxHTTPProxySchema, "authentication-user", gvariantQuote("")}, nil)
}

func addLinuxBypassSteps(changes *plan, current, desired []string) {
	if desired == nil || equalStrings(current, desired) {
		return
	}
	changes.addCommand(linuxServiceName, ActionGSettingsSet, gsettingsCommand,
		[]string{"set", linuxProxySchema, "ignore-hosts", gvariantStringArray(desired)}, nil)
}

func addLinuxModeSteps(changes *plan, current, desired string) {
	if current == desired {
		return
	}
	changes.addCommand(linuxServiceName, ActionProxyModeChange, gsettingsCommand,
		[]string{"set", linuxProxySchema, "mode", gvariantQuote(desired)}, nil)
}

func gvariantQuote(value string) string {
	return "'" + strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(value) + "'"
}

func gvariantStringArray(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, gvariantQuote(value))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func gvariantFirst(raw string) string {
	values := parseGVariantStrings(raw)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// parseGVariantStrings extracts single-quoted strings from a GVariant text
// representation such as "['localhost', '10.0.0.0/8']" or "'127.0.0.1'".
func parseGVariantStrings(raw string) []string {
	values := []string{}
	inQuote := false
	escaped := false
	var current strings.Builder
	for _, character := range raw {
		if !inQuote {
			if character == '\'' {
				inQuote = true
				current.Reset()
			}
			continue
		}
		switch {
		case escaped:
			current.WriteRune(character)
			escaped = false
		case character == '\\':
			escaped = true
		case character == '\'':
			values = append(values, current.String())
			current.Reset()
			inQuote = false
		default:
			current.WriteRune(character)
		}
	}
	return values
}
