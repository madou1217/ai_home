package systemproxy

import (
	"context"
	"fmt"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const networksetupCommand = "networksetup"

var (
	darwinOrderNamePattern   = regexp.MustCompile(`^\((\d+|\*)\)\s+(.+?)\s*$`)
	darwinOrderDetailPattern = regexp.MustCompile(`^\(Hardware Port:\s*(.*?),\s*Device:\s*(.*?)\)\s*$`)
)

type darwinBackend struct{}

func currentBackend() backend {
	return darwinBackend{}
}

func (darwinBackend) scope() string {
	return ScopeMacOSNetworksetup
}

func (backend darwinBackend) capture(ctx context.Context, run runner) (Snapshot, error) {
	services, err := backend.listServices(ctx, run)
	if err != nil {
		return Snapshot{}, err
	}
	snapshot := emptySnapshot(ScopeMacOSNetworksetup)
	for _, service := range services {
		state, err := captureDarwinService(ctx, run, service)
		if err != nil {
			return Snapshot{}, err
		}
		snapshot.Services = append(snapshot.Services, state)
	}
	return snapshot, nil
}

func (backend darwinBackend) listServices(ctx context.Context, run runner) ([]Service, error) {
	listed := run.Run(ctx, networksetupCommand, "-listallnetworkservices")
	if !listed.OK() {
		return nil, failedDetection("network services", listed)
	}

	orderDetails := map[string]Service{}
	if order := run.Run(ctx, networksetupCommand, "-listnetworkserviceorder"); order.OK() {
		orderDetails = parseDarwinServiceOrder(order.Stdout)
	}

	services := make([]Service, 0, 8)
	for _, line := range strings.Split(listed.Stdout, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(strings.ToLower(trimmed), "an asterisk") {
			continue
		}
		service := Service{Name: trimmed, Enabled: true}
		if strings.HasPrefix(trimmed, "*") {
			service.Name = strings.TrimSpace(strings.TrimPrefix(trimmed, "*"))
			service.Enabled = false
		}
		if service.Name == "" {
			continue
		}
		if detail, found := orderDetails[service.Name]; found {
			service.HardwarePort = detail.HardwarePort
			service.Device = detail.Device
		}
		services = append(services, service)
	}
	return services, nil
}

func (backend darwinBackend) apply(ctx context.Context, run runner, options ApplyOptions) (Result, error) {
	if options.Service == "" {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup},
			fmt.Errorf("systemproxy: macOS apply requires an explicit network service: %w", ErrServiceRequired)
	}
	services, err := backend.listServices(ctx, run)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, err
	}
	service, found := findService(services, options.Service)
	if !found {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup},
			fmt.Errorf("systemproxy: network service %q not found: %w", options.Service, ErrServiceNotFound)
	}
	current, err := captureDarwinService(ctx, run, service)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, err
	}

	desiredHTTP := ProxyState{
		Enabled:        true,
		Host:           options.HTTP.Host,
		Port:           options.HTTP.Port,
		Authentication: options.HTTP.Authenticated(),
		Username:       options.HTTP.Username,
	}
	desiredHTTPS := ProxyState{
		Enabled:        true,
		Host:           options.HTTPS.Host,
		Port:           options.HTTPS.Port,
		Authentication: options.HTTPS.Authenticated(),
		Username:       options.HTTPS.Username,
	}

	changes := newPlan("apply", ScopeMacOSNetworksetup)
	addDarwinProxySteps(changes, options.Service, current.HTTP, desiredHTTP, options.HTTP,
		"-setwebproxy", ActionSetWebProxy)
	addDarwinProxySteps(changes, options.Service, current.HTTPS, desiredHTTPS, options.HTTPS,
		"-setsecurewebproxy", ActionSetSecureWebProxy)
	addDarwinBypassSteps(changes, options.Service, current.Bypass, options.Bypass)
	return changes.execute(ctx, run, options.DryRun)
}

func (backend darwinBackend) restore(ctx context.Context, run runner, snapshot Snapshot, options RestoreOptions) (Result, error) {
	targets, err := restoreTargets(snapshot, options)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, err
	}
	for _, target := range targets {
		if authRequired(target) {
			return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, fmt.Errorf(
				"systemproxy: snapshot service %q used proxy authentication whose password was not captured: %w",
				target.Service, ErrAuthNotRestorable,
			)
		}
	}

	services, err := backend.listServices(ctx, run)
	if err != nil {
		return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, err
	}
	changes := newPlan("restore", ScopeMacOSNetworksetup)
	for _, target := range targets {
		service, found := findService(services, target.Service)
		if !found {
			return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup},
				fmt.Errorf("systemproxy: network service %q from snapshot no longer exists: %w", target.Service, ErrServiceNotFound)
		}
		current, err := captureDarwinService(ctx, run, service)
		if err != nil {
			return Result{Platform: runtime.GOOS, Scope: ScopeMacOSNetworksetup}, err
		}
		addDarwinRestoreProxySteps(changes, target.Service, current.HTTP, target.HTTP,
			"-setwebproxy", "-setwebproxystate", ActionSetWebProxy, ActionDisableWebProxy)
		addDarwinRestoreProxySteps(changes, target.Service, current.HTTPS, target.HTTPS,
			"-setsecurewebproxy", "-setsecurewebproxystate", ActionSetSecureWebProxy, ActionDisableSecureWebProxy)
		addDarwinBypassSteps(changes, target.Service, current.Bypass, target.Bypass)
	}
	return changes.execute(ctx, run, options.DryRun)
}

func captureDarwinService(ctx context.Context, run runner, service Service) (ServiceState, error) {
	state := newServiceState(service.Name, service.HardwarePort, service.Device)

	web := run.Run(ctx, networksetupCommand, "-getwebproxy", service.Name)
	if !web.OK() {
		return ServiceState{}, failedDetection("web proxy for "+service.Name, web)
	}
	state.HTTP = parseDarwinProxyState(web.Stdout)

	secure := run.Run(ctx, networksetupCommand, "-getsecurewebproxy", service.Name)
	if !secure.OK() {
		return ServiceState{}, failedDetection("secure web proxy for "+service.Name, secure)
	}
	state.HTTPS = parseDarwinProxyState(secure.Stdout)

	bypass := run.Run(ctx, networksetupCommand, "-getproxybypassdomains", service.Name)
	if !bypass.OK() {
		return ServiceState{}, failedDetection("proxy bypass domains for "+service.Name, bypass)
	}
	state.Bypass = parseDarwinBypass(bypass.Stdout)
	return state, nil
}

func parseDarwinProxyState(output string) ProxyState {
	state := ProxyState{}
	for _, line := range strings.Split(output, "\n") {
		key, value, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		value = strings.TrimSpace(value)
		switch key {
		case "enabled":
			state.Enabled = strings.EqualFold(value, "yes")
		case "server":
			state.Host = value
		case "port":
			port, err := strconv.Atoi(value)
			if err == nil {
				state.Port = port
			}
		case "authenticated proxy enabled":
			state.Authentication = value == "1" || strings.EqualFold(value, "yes")
		}
	}
	return state
}

func parseDarwinBypass(output string) []string {
	domains := []string{}
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "there aren't any bypass domains") ||
			strings.Contains(lower, "there are no bypass domains") {
			continue
		}
		domains = append(domains, trimmed)
	}
	return domains
}

func parseDarwinServiceOrder(output string) map[string]Service {
	details := map[string]Service{}
	var pending string
	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if match := darwinOrderNamePattern.FindStringSubmatch(trimmed); match != nil {
			pending = strings.TrimSpace(match[2])
			if pending != "" {
				details[pending] = Service{Name: pending, Enabled: match[1] != "*"}
			}
			continue
		}
		if match := darwinOrderDetailPattern.FindStringSubmatch(trimmed); match != nil && pending != "" {
			service := details[pending]
			service.HardwarePort = strings.TrimSpace(match[1])
			service.Device = strings.TrimSpace(match[2])
			details[pending] = service
		}
	}
	return details
}

func findService(services []Service, name string) (Service, bool) {
	for _, service := range services {
		if service.Name == name {
			return service, true
		}
	}
	return Service{}, false
}

// addDarwinProxySteps plans a web/secure-web proxy write. networksetup's set
// command also turns the proxy on, so no separate state command is needed.
func addDarwinProxySteps(
	changes *plan,
	service string,
	current ProxyState,
	desired ProxyState,
	endpoint Endpoint,
	setCommand string,
	setAction string,
) {
	if !stateDiffers(current, desired) {
		return
	}
	args, display := darwinProxyArgs(setCommand, service, endpoint, current.Authentication)
	changes.addCommand(service, setAction, networksetupCommand, args, display)
}

// addDarwinRestoreProxySteps plans the difference between live and captured
// state. Captured snapshots never carry credentials, so a disabled target only
// needs the state command.
func addDarwinRestoreProxySteps(
	changes *plan,
	service string,
	current ProxyState,
	target ProxyState,
	setCommand string,
	stateCommand string,
	setAction string,
	disableAction string,
) {
	if !stateDiffers(current, target) {
		return
	}
	if !target.Enabled {
		changes.addCommand(service, disableAction, networksetupCommand,
			[]string{stateCommand, service, "off"}, nil)
		return
	}
	endpoint := Endpoint{Host: target.Host, Port: target.Port}
	args, display := darwinProxyArgs(setCommand, service, endpoint, current.Authentication)
	changes.addCommand(service, setAction, networksetupCommand, args, display)
}

// darwinProxyArgs builds -setwebproxy/-setsecurewebproxy arguments. When the
// live configuration used authentication, an explicit "off" is written so a
// restore actually clears it instead of relying on an omitted optional triplet.
func darwinProxyArgs(setCommand, service string, endpoint Endpoint, disableAuthentication bool) ([]string, []string) {
	args := []string{setCommand, service, endpoint.Host, strconv.Itoa(endpoint.Port)}
	display := append([]string(nil), args...)
	switch {
	case endpoint.Authenticated():
		args = append(args, "on", endpoint.Username, endpoint.Password)
		display = append(display, "on", endpoint.Username, "***")
	case disableAuthentication:
		args = append(args, "off", "", "")
		display = append(display, "off", "", "")
	}
	return args, display
}

func addDarwinBypassSteps(changes *plan, service string, current, target []string) {
	if target == nil || equalStrings(current, target) {
		return
	}
	args := []string{"-setproxybypassdomains", service}
	display := append([]string(nil), args...)
	if len(target) == 0 {
		args = append(args, "Empty")
		display = append(display, "Empty")
	} else {
		args = append(args, target...)
		display = append(display, target...)
	}
	changes.addCommand(service, ActionSetBypassDomains, networksetupCommand, args, display)
}
