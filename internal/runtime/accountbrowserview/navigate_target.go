package accountbrowserview

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"
)

const navigateResolveTimeout = 2 * time.Second

var errNavigateTargetBlocked = errors.New("browser navigate target blocked")

// validateNavigateURL applies the structural policy shared by the transport and
// runtime command validators. It never performs I/O.
func validateNavigateURL(raw string) (*url.URL, error) {
	if len(raw) > 8192 || strings.ContainsAny(raw, "\r\n\x00") {
		return nil, errNavigateTargetBlocked
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil {
		return nil, errNavigateTargetBlocked
	}
	host := strings.ToLower(parsed.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.Contains(host, "metadata") {
		return nil, errNavigateTargetBlocked
	}
	return parsed, nil
}

// ValidateNavigateTarget rejects targets whose hostname or resolved addresses
// are not public internet addresses. A public-looking name that resolves to
// loopback (for example localtest.me) must not reach the server's local ports.
func ValidateNavigateTarget(raw string) error {
	parsed, err := validateNavigateURL(raw)
	if err != nil {
		return err
	}
	host := strings.ToLower(parsed.Hostname())
	if blockedHostname(host) {
		return errNavigateTargetBlocked
	}
	if ip := net.ParseIP(host); ip != nil {
		if !isPublicAddress(ip) {
			return errNavigateTargetBlocked
		}
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), navigateResolveTimeout)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(addresses) == 0 {
		return errNavigateTargetBlocked
	}
	for _, address := range addresses {
		// Transparent proxies with fake-IP DNS map every name into 198.18.0.0/15.
		// Those answers do not describe the real destination, so they cannot be
		// used to prove that a name is public or private.
		if v4 := address.IP.To4(); v4 != nil && benchmarkRange.Contains(v4) {
			continue
		}
		if !isPublicAddress(address.IP) {
			return errNavigateTargetBlocked
		}
	}
	return nil
}

var (
	loopbackAliasSuffixes = []string{"localtest.me", "lvh.me", "local.gd", "vcap.me", "traefik.me"}
	embeddedIPSuffixes    = []string{"nip.io", "sslip.io", "xip.io"}
)

func blockedHostname(host string) bool {
	for _, suffix := range loopbackAliasSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	for _, suffix := range embeddedIPSuffixes {
		if host != suffix && !strings.HasSuffix(host, "."+suffix) {
			continue
		}
		prefix := strings.TrimSuffix(host, "."+suffix)
		if prefix == host || prefix == "" {
			return true
		}
		candidate := strings.ReplaceAll(prefix, "-", ".")
		if ip := net.ParseIP(candidate); ip != nil {
			return !isPublicAddress(ip)
		}
		// Encodings this parser does not understand must not reach the browser.
		return true
	}
	return false
}

var (
	cgnatRange     = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}
	benchmarkRange = &net.IPNet{IP: net.IPv4(198, 18, 0, 0), Mask: net.CIDRMask(15, 32)}
	protocolRange  = &net.IPNet{IP: net.IPv4(192, 0, 0, 0), Mask: net.CIDRMask(24, 32)}
	thisNetwork    = &net.IPNet{IP: net.IPv4(0, 0, 0, 0), Mask: net.CIDRMask(8, 32)}
)

func isPublicAddress(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		for _, blocked := range []*net.IPNet{cgnatRange, protocolRange, thisNetwork} {
			if blocked.Contains(v4) {
				return false
			}
		}
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	return ip.IsGlobalUnicast()
}
