package managedproxy

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"strings"
)

// PublicAddress resolves once and returns a validated literal to the SSH dialer.
// sshd cannot perform a second DNS resolution that bypasses address validation.
func PublicAddress(ctx context.Context, address string) (string, error) {
	return publicAddress(ctx, address, net.DefaultResolver.LookupIPAddr)
}
func publicAddress(ctx context.Context, address string, lookup func(context.Context, string) ([]net.IPAddr, error)) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	if ip := net.ParseIP(host); ip != nil {
		if !publicIP(ip) {
			return "", fmt.Errorf("private destination")
		}
		return address, nil
	}
	if strings.ContainsAny(host, "\x00\r\n") {
		return "", fmt.Errorf("invalid destination")
	}
	addresses, err := lookup(ctx, host)
	if err != nil || len(addresses) == 0 {
		return "", fmt.Errorf("public destination resolution failed")
	}
	// Reject mixed public/private answers as well as a wholly private hostname.
	for _, entry := range addresses {
		if !publicIP(entry.IP) {
			return "", fmt.Errorf("private destination")
		}
	}
	for _, entry := range addresses {
		if entry.IP.To4() != nil {
			return net.JoinHostPort(entry.IP.String(), port), nil
		}
	}
	return net.JoinHostPort(addresses[0].IP.String(), port), nil
}
func publicIP(ip net.IP) bool {
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	for _, prefix := range nonPublicPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"), netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("100::/64"), netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"), netip.MustParsePrefix("2002::/16"),
}
