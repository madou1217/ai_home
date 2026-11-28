//go:build linux

package clipboardsource

import (
	"context"
	"os"
	"os/exec"
	"strings"
)

// linuxResolver reads the X11 active window. Wayland compositors do not expose
// a portable equivalent, so attribution is simply unavailable there and the UI
// must fall back to "来源未知" instead of guessing.
type linuxResolver struct{}

func New() Resolver { return &linuxResolver{} }

func (r *linuxResolver) Frontmost(ctx context.Context) (App, bool) {
	if strings.TrimSpace(os.Getenv("DISPLAY")) == "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return App{}, false
	}
	xprop, err := exec.LookPath("xprop")
	if err != nil {
		return App{}, false
	}

	rootCtx, rootCancel := withTimeout(ctx)
	defer rootCancel()
	out, err := exec.CommandContext(rootCtx, xprop, "-root", "_NET_ACTIVE_WINDOW").Output()
	if err != nil {
		return App{}, false
	}
	windowID := lastHexToken(string(out))
	if windowID == "" || strings.HasSuffix(windowID, "0x0") {
		return App{}, false
	}

	classCtx, classCancel := withTimeout(ctx)
	defer classCancel()
	raw, err := exec.CommandContext(classCtx, xprop, "-id", windowID, "WM_CLASS").Output()
	if err != nil {
		return App{}, false
	}
	classes := quotedTokens(string(raw))
	name := ""
	if len(classes) > 0 {
		name = classes[len(classes)-1]
	}
	if name == "" {
		return App{}, false
	}
	return App{Name: name, BundleID: strings.ToLower(name)}, true
}

func lastHexToken(text string) string {
	fields := strings.Fields(text)
	for i := len(fields) - 1; i >= 0; i-- {
		if strings.HasPrefix(fields[i], "0x") {
			return fields[i]
		}
	}
	return ""
}

func quotedTokens(text string) []string {
	var out []string
	for {
		start := strings.IndexByte(text, '"')
		if start < 0 {
			return out
		}
		rest := text[start+1:]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			return out
		}
		out = append(out, rest[:end])
		text = rest[end+1:]
	}
}
