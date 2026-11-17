package providercliupgrade

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"unicode"
)

// npmRuntimeCommand shares the packaged Node/npm runtime between read-only
// registry checks and managed installs. Never put npm arguments through cmd.exe:
// its quoting adds literal quotes to argv and breaks Windows background checks.
func npmRuntimeCommand(args []string, goos string, env []string, node string) (string, []string, error) {
	if goos == "" {
		goos = runtime.GOOS
	}
	node = strings.TrimSpace(node)
	explicit := node != ""
	if !explicit {
		node = npmEnvironmentValue(env, "AIH_SERVER_NODE_EXEC", goos)
		explicit = node != ""
	}
	if node == "" {
		node, _ = exec.LookPath("node")
	}
	if node != "" {
		if info, err := os.Stat(node); err != nil || !info.Mode().IsRegular() {
			return "", nil, errors.New("bundled_node_unavailable")
		}
		entry := filepath.Join(filepath.Dir(filepath.Dir(node)), "lib", "node_modules", "npm", "bin", "npm-cli.js")
		if isWindowsOS(goos) {
			entry = filepath.Join(filepath.Dir(node), "node_modules", "npm", "bin", "npm-cli.js")
		}
		if info, err := os.Stat(entry); err == nil && info.Mode().IsRegular() {
			return node, append([]string{entry}, args...), nil
		}
	}
	if explicit || isWindowsOS(goos) {
		return "", nil, errors.New("bundled_npm_unavailable")
	}
	return "npm", args, nil
}

func npmEnvironmentValue(env []string, name, goos string) string {
	if len(env) == 0 {
		env = os.Environ()
	}
	// Match exec.Cmd environment deduplication: the last case-insensitive
	// Windows key wins, with no fallback outside an explicitly supplied env.
	for i := len(env) - 1; i >= 0; i-- {
		key, value, ok := strings.Cut(env[i], "=")
		if ok && (key == name || (isWindowsOS(goos) && strings.EqualFold(key, name))) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func runNpmCommand(ctx context.Context, args []string, goos string, env []string) (string, string, error) {
	command, argv, err := npmRuntimeCommand(args, goos, env, "")
	if err != nil {
		return "", "", err
	}
	cmd := exec.CommandContext(ctx, command, argv...)
	if len(env) > 0 {
		cmd.Env = env
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	return stdout.String(), stderr.String(), err
}

// npm emits some errors to stdout. Keep a bounded readable diagnostic rather
// than hiding those failures behind only "exit status 1".
func npmCommandFailure(stdout, stderr string, err error) string {
	message := strings.TrimSpace(stderr)
	if message == "" {
		message = strings.TrimSpace(stdout)
	}
	if message == "" && err != nil {
		message = err.Error()
	}
	message = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, message)
	runes := []rune(message)
	if len(runes) > 200 {
		message = string(runes[:200])
	}
	return strings.TrimSpace(message)
}
