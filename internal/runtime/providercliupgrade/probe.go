package providercliupgrade

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const defaultVersionProbeTimeout = 8 * time.Second

var (
	jsScriptExtRe = regexp.MustCompile(`(?i)\.(?:js|cjs|mjs)$`)
	ps1ScriptRe   = regexp.MustCompile(`(?i)\.ps1$`)
	shebangNodeRe = regexp.MustCompile(`^#!\s*/usr/bin/env\s+node\b`)
	shebangShRe   = regexp.MustCompile(`^#!\s*(?:/bin/sh|/usr/bin/env\s+(?:sh|bash)|/bin/bash)\b`)
)

// ResolveCommandPath 解析可执行命令路径，兼容 PATH 与常见用户本地安装目录。
func ResolveCommandPath(binaryName string, hostHomeDir string, goos string, extraEnvPath string) string {
	name := strings.TrimSpace(binaryName)
	if name == "" {
		return ""
	}
	if filepath.IsAbs(name) {
		if pathExists(name) {
			return name
		}
		return ""
	}
	if resolved, err := exec.LookPath(name); err == nil && resolved != "" {
		return resolved
	}
	sep := string(filepath.ListSeparator)
	var candidateDirs []string
	if extraEnvPath != "" {
		candidateDirs = append(candidateDirs, strings.Split(extraEnvPath, sep)...)
	}
	if home := strings.TrimSpace(hostHomeDir); home != "" {
		candidateDirs = append(candidateDirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".opencode", "bin"),
		)
	}
	if !isWindowsOS(goos) {
		candidateDirs = append(candidateDirs, "/opt/homebrew/bin", "/usr/local/bin")
	}
	exts := []string{""}
	if isWindowsOS(goos) {
		exts = []string{"", ".exe", ".cmd", ".bat", ".ps1"}
	}
	for _, dir := range candidateDirs {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			continue
		}
		for _, ext := range exts {
			candidate := filepath.Join(dir, name+ext)
			info, err := os.Stat(candidate)
			if err == nil && !info.IsDir() {
				if isWindowsOS(goos) || info.Mode()&0o111 != 0 {
					return candidate
				}
			}
		}
	}
	return ""
}

// ProbeOptions 配置版本探测命令与超时。
type ProbeOptions struct {
	GoOS                 string
	NodeExecutable       string
	PowerShellExecutable string
	Timeout              time.Duration
	Env                  []string
}

// ProbeVersion 探测目标 CLI 自报版本号并归一化，空输出自动重试一次（与 Node probeVersion 同口径）。
func ProbeVersion(ctx context.Context, cliPath string, opts ProbeOptions) string {
	target := strings.TrimSpace(cliPath)
	if target == "" {
		return ""
	}
	first := probeVersionOnce(ctx, target, opts)
	if first != "" {
		return first
	}
	return probeVersionOnce(ctx, target, opts)
}

func probeVersionOnce(ctx context.Context, cliPath string, opts ProbeOptions) string {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultVersionProbeTimeout
	}
	goos := strings.TrimSpace(opts.GoOS)
	if goos == "" {
		goos = runtime.GOOS
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := buildVersionProbeCommand(probeCtx, cliPath, goos, opts)
	if len(opts.Env) > 0 {
		cmd.Env = opts.Env
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	_ = cmd.Run()

	line := firstNonEmptyLine(stdout.String())
	if line == "" {
		line = firstNonEmptyLine(stderr.String())
	}
	if line == "" {
		return ""
	}
	return NormalizeVersionText(line)
}

func buildVersionProbeCommand(ctx context.Context, cliPath string, goos string, opts ProbeOptions) *exec.Cmd {
	prefix := readPrefixString(cliPath, 160)
	nodeBin := strings.TrimSpace(opts.NodeExecutable)
	if nodeBin == "" {
		nodeBin = "node"
	}
	psBin := strings.TrimSpace(opts.PowerShellExecutable)
	if psBin == "" {
		psBin = "powershell.exe"
	}

	if jsScriptExtRe.MatchString(cliPath) || shebangNodeRe.MatchString(prefix) {
		return exec.CommandContext(ctx, nodeBin, cliPath, "--version")
	}
	if ps1ScriptRe.MatchString(cliPath) {
		return exec.CommandContext(ctx, psBin, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", cliPath, "--version")
	}
	if isWindowsOS(goos) && cmdOrBatExtRe.MatchString(cliPath) {
		if shimTarget := followNpmCmdShim(cliPath); shimTarget != "" && jsScriptExtRe.MatchString(shimTarget) {
			return exec.CommandContext(ctx, nodeBin, shimTarget, "--version")
		}
		return exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", `"`+cliPath+`" --version`)
	}
	if !isWindowsOS(goos) && shebangShRe.MatchString(prefix) {
		return exec.CommandContext(ctx, cliPath, "--version")
	}
	return exec.CommandContext(ctx, cliPath, "--version")
}

func readPrefixString(filePath string, limit int) string {
	file, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer file.Close()
	buf := make([]byte, limit)
	n, _ := file.Read(buf)
	return string(buf[:n])
}

func firstNonEmptyLine(raw string) string {
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}
