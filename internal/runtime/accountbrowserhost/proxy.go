package accountbrowserhost

import (
	"fmt"
	"net/url"
	"strings"
)

// normalizeProxyURL accepts only a credential-free proxy URL. Credentials must
// never be passed through the browser command line or process environment.
func NormalizeProxyURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.User != nil || parsed.Host == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("invalid browser proxy URL: %w", ErrUnsafePath)
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "socks4", "socks5":
	default:
		return "", fmt.Errorf("unsupported browser proxy scheme: %w", ErrUnsafePath)
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("browser proxy path is not supported: %w", ErrUnsafePath)
	}
	parsed.Path = ""
	return parsed.String(), nil
}
