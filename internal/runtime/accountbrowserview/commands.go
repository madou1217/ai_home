package accountbrowserview

import (
	"math"
	"net"
	"net/url"
	"strings"
)

func validCommand(c Command) bool {
	if len(c.URL) > 8192 || len(c.Text) > 4096 {
		return false
	}
	switch c.Type {
	case "start", "close":
		return true
	case "navigate":
		u, err := url.Parse(c.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil || strings.ContainsAny(c.URL, "\r\n\x00") {
			return false
		}
		host := strings.ToLower(u.Hostname())
		if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.Contains(host, "metadata") {
			return false
		}
		if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || !ip.IsGlobalUnicast()) {
			return false
		}
		return true
	case "text":
		return c.Text != "" && !strings.ContainsRune(c.Text, 0)
	case "key":
		switch c.Key {
		case "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown", "back", "forward", "reload":
			return true
		}
	case "pointer":
		return finite(c.X) && finite(c.Y) && c.X >= 0 && c.X <= 1 && c.Y >= 0 && c.Y <= 1 && (c.Button == 0 || c.Button == 2)
	case "scroll":
		return finite(c.DeltaX) && finite(c.DeltaY) && math.Abs(c.DeltaX) <= 2000 && math.Abs(c.DeltaY) <= 2000
	}
	return false
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
