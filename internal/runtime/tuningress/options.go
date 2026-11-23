package tuningress

import (
	"fmt"
	"net"
	"strings"
	"time"
	"unicode"
)

const (
	// DefaultMTU is used when Options.MTU is zero. It is large enough for
	// loopback-style payloads and is reduced by normal TCP MSS negotiation.
	DefaultMTU = 9000

	// DefaultStack is used when Options.Stack is empty.
	DefaultStack = "system"

	// DefaultTUNAddress is used when Options.Addresses is empty. It is a
	// private, non-loopback /30 with a single usable peer address.
	DefaultTUNAddress = "172.19.0.1/30"

	// DefaultDirectDNSServer is used when Options.DirectDNSServer is empty. The
	// query is sent through the direct outbound, never through the HTTP
	// ingress, so proxy-server resolution can never recurse into the tunnel.
	DefaultDirectDNSServer = "223.5.5.5"

	// DefaultShutdownTimeout bounds Runtime.Close.
	DefaultShutdownTimeout = 5 * time.Second

	// DefaultCheckTimeout bounds Check when its context has no deadline.
	DefaultCheckTimeout = 30 * time.Second

	minMTU           = 576
	maxMTU           = 65535
	maxAddresses     = 4
	maxInterfaceLen  = 64
	maxCredentialLen = 4096
)

// Options describes one local TUN ingress.
type Options struct {
	// UpstreamHost is the host of the existing local HTTP proxy ingress. It
	// must be a loopback IP literal or localhost; Render rejects anything else
	// with ErrNonLoopbackUpstream.
	UpstreamHost string
	// UpstreamPort is the HTTP proxy port of the local ingress.
	UpstreamPort int
	// UpstreamUsername and UpstreamPassword authenticate to the local ingress.
	// Leave both empty only when the ingress explicitly allows anonymous
	// loopback clients. Supplying just one of them is invalid.
	UpstreamUsername string
	UpstreamPassword string

	// InterfaceName is passed to sing-box as interface_name. Empty lets
	// sing-box choose a platform default name.
	InterfaceName string
	// Addresses are TUN interface addresses in CIDR form. Empty uses
	// DefaultTUNAddress. At most four addresses are accepted.
	Addresses []string
	// MTU is the TUN interface MTU. Zero uses DefaultMTU.
	MTU int
	// AutoRoute installs interface routes. This is the actual traffic
	// takeover; it is never implied by Render, Check, or Start.
	AutoRoute bool
	// StrictRoute asks sing-box for its platform-specific strict routing mode.
	StrictRoute bool
	// Stack is one of system, gvisor, or mixed. Empty uses DefaultStack.
	Stack string

	// LogFile is the sing-box log output path. Empty omits the output field;
	// Start discards the child's standard streams in that case, so no log is
	// retained. Relative paths resolve against the process working directory
	// because Start does not change it.
	LogFile string
	// DirectDNSServer is the resolver used for DNS and for proxy-server name
	// resolution. It is always reached through the direct outbound. Empty uses
	// DefaultDirectDNSServer; it must be an IP literal.
	DirectDNSServer string

	// SingBoxPath is the sing-box executable. Check falls back to
	// DiscoverBinary when it is empty. Start requires it explicitly and never
	// guesses.
	SingBoxPath string
	// AllowStart is the explicit network-layer takeover consent. Start refuses
	// to launch unless it is true.
	AllowStart bool
	// ShutdownTimeout bounds Runtime.Close. Zero uses DefaultShutdownTimeout.
	ShutdownTimeout time.Duration
}

// settings is the normalized, immutable form used by the rest of the package.
// It intentionally does not embed Options so accidental formatting of a
// settings value cannot print credentials.
type settings struct {
	upstreamHost    string
	upstreamPort    int
	upstreamUser    string
	upstreamPass    string
	interfaceName   string
	addresses       []string
	mtu             int
	autoRoute       bool
	strictRoute     bool
	stack           string
	logFile         string
	directDNSServer string
	binaryPath      string
	shutdownTimeout time.Duration
}

func (o Options) settings() (*settings, error) {
	host, err := normalizeUpstreamHost(o.UpstreamHost)
	if err != nil {
		return nil, err
	}
	if o.UpstreamPort < 1 || o.UpstreamPort > 65535 {
		return nil, invalidOption(nil, "upstream proxy port must be between 1 and 65535")
	}
	if err := validateCredentials(o.UpstreamUsername, o.UpstreamPassword); err != nil {
		return nil, invalidOption(err, "")
	}
	interfaceName := strings.TrimSpace(o.InterfaceName)
	if err := validateInterfaceName(interfaceName); err != nil {
		return nil, err
	}
	addresses, err := normalizeAddresses(o.Addresses)
	if err != nil {
		return nil, err
	}
	mtu := o.MTU
	if mtu == 0 {
		mtu = DefaultMTU
	}
	if mtu < minMTU || mtu > maxMTU {
		return nil, invalidOption(ErrInvalidMTU, fmt.Sprintf("must be between %d and %d", minMTU, maxMTU))
	}
	stack, err := normalizeStack(o.Stack)
	if err != nil {
		return nil, err
	}
	logFile := strings.TrimSpace(o.LogFile)
	if hasControlChars(logFile) {
		return nil, invalidOption(ErrInvalidLogFile, "must not contain control characters")
	}
	dnsServer, err := normalizeDNSServer(o.DirectDNSServer)
	if err != nil {
		return nil, err
	}
	shutdownTimeout := o.ShutdownTimeout
	if shutdownTimeout == 0 {
		shutdownTimeout = DefaultShutdownTimeout
	}
	if shutdownTimeout < 0 {
		return nil, invalidOption(nil, "shutdown timeout must not be negative")
	}
	return &settings{
		upstreamHost:    host,
		upstreamPort:    o.UpstreamPort,
		upstreamUser:    o.UpstreamUsername,
		upstreamPass:    o.UpstreamPassword,
		interfaceName:   interfaceName,
		addresses:       addresses,
		mtu:             mtu,
		autoRoute:       o.AutoRoute,
		strictRoute:     o.StrictRoute,
		stack:           stack,
		logFile:         logFile,
		directDNSServer: dnsServer,
		binaryPath:      strings.TrimSpace(o.SingBoxPath),
		shutdownTimeout: shutdownTimeout,
	}, nil
}

func invalidOption(reason error, detail string) error {
	switch {
	case reason != nil && detail != "":
		return fmt.Errorf("%w: %w: %s", ErrInvalidOptions, reason, detail)
	case reason != nil:
		return fmt.Errorf("%w: %w", ErrInvalidOptions, reason)
	case detail != "":
		return fmt.Errorf("%w: %s", ErrInvalidOptions, detail)
	default:
		return ErrInvalidOptions
	}
}

func normalizeUpstreamHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)
	if host == "" {
		return "", invalidOption(nil, "upstream proxy host is required")
	}
	if strings.EqualFold(host, "localhost") {
		// Canonicalize instead of relying on the resolver: the ingress is
		// always local, and a hosts-file override must not redirect OS traffic.
		return "127.0.0.1", nil
	}
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", invalidOption(ErrNonLoopbackUpstream, "")
	}
	return ip.String(), nil
}

func validateCredentials(username, password string) error {
	if username == "" && password == "" {
		return nil
	}
	if username == "" || password == "" {
		return ErrInvalidCredentials
	}
	if strings.ContainsRune(username, ':') {
		return ErrInvalidCredentials
	}
	if hasControlChars(username) || hasControlChars(password) {
		return ErrInvalidCredentials
	}
	if len(username)+len(password) > maxCredentialLen {
		return ErrInvalidCredentials
	}
	return nil
}

func validateInterfaceName(name string) error {
	if name == "" {
		return nil
	}
	if len(name) > maxInterfaceLen {
		return invalidOption(ErrInvalidInterface, fmt.Sprintf("must not exceed %d bytes", maxInterfaceLen))
	}
	if hasControlChars(name) {
		return invalidOption(ErrInvalidInterface, "must not contain control characters")
	}
	return nil
}

func normalizeAddresses(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return []string{DefaultTUNAddress}, nil
	}
	if len(raw) > maxAddresses {
		return nil, invalidOption(ErrInvalidAddress, fmt.Sprintf("at most %d addresses are accepted", maxAddresses))
	}
	out := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, entry := range raw {
		normalized, err := normalizeAddress(entry)
		if err != nil {
			return nil, err
		}
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	if len(out) == 0 {
		return nil, invalidOption(ErrInvalidAddress, "at least one address is required")
	}
	return out, nil
}

func normalizeAddress(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	ip, network, err := net.ParseCIDR(trimmed)
	if err != nil {
		return "", invalidOption(ErrInvalidAddress, fmt.Sprintf("%q is not an IP CIDR", trimmed))
	}
	ones, bits := network.Mask.Size()
	if v4 := ip.To4(); v4 != nil {
		if bits == 128 {
			if ones < 96 {
				return "", invalidOption(ErrInvalidAddress, fmt.Sprintf("%q is not a usable IPv4 CIDR", trimmed))
			}
			ones -= 96
		}
		ip = v4
	}
	if ones == 0 {
		return "", invalidOption(ErrInvalidAddress, fmt.Sprintf("%q must not use a zero-length prefix", trimmed))
	}
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsLoopback() {
		return "", invalidOption(ErrInvalidAddress, fmt.Sprintf("%q must be a non-loopback unicast address", trimmed))
	}
	return fmt.Sprintf("%s/%d", ip.String(), ones), nil
}

func normalizeStack(raw string) (string, error) {
	stack := strings.ToLower(strings.TrimSpace(raw))
	switch stack {
	case "":
		return DefaultStack, nil
	case "system", "gvisor", "mixed":
		return stack, nil
	default:
		return "", invalidOption(ErrUnsupportedStack, fmt.Sprintf("%q is not one of system, gvisor, or mixed", stack))
	}
}

func normalizeDNSServer(raw string) (string, error) {
	server := strings.TrimSpace(raw)
	if server == "" {
		server = DefaultDirectDNSServer
	}
	if strings.HasPrefix(server, "[") && strings.HasSuffix(server, "]") {
		server = server[1 : len(server)-1]
	}
	ip := net.ParseIP(server)
	if ip == nil || ip.IsUnspecified() || ip.IsMulticast() {
		return "", invalidOption(ErrInvalidDNSServer, "must be a unicast IP literal")
	}
	return ip.String(), nil
}

func hasControlChars(value string) bool {
	return strings.IndexFunc(value, unicode.IsControl) >= 0
}
