package providercliupgrade

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var defaultHomebrewRoots = []string{
	"/opt/homebrew",
	"/usr/local/Homebrew",
	"/usr/local",
	"/home/linuxbrew/.linuxbrew",
}

// InstallRoots 汇总各安装渠道在当前宿主上的根目录。
type InstallRoots struct {
	NpmGlobalRoot         string
	StandaloneRoots       []string
	VendorSelfUpdateRoots []string
	HomebrewRoots         []string
}

// CollectStandaloneRootCandidates 按注册插件声明返回官方 standalone 安装根候选。
func CollectStandaloneRootCandidates(hostHomeDir string, localAppData string) []string {
	var out []string
	if home := strings.TrimSpace(hostHomeDir); home != "" {
		out = append(out, filepath.Join(home, ".codex", "packages", "standalone"))
	}
	if appData := strings.TrimSpace(localAppData); appData != "" {
		out = append(out, filepath.Join(appData, "codex", "packages", "standalone"))
	}
	return out
}

// CollectVendorSelfUpdateRootCandidates 返回 provider 自带更新器安装根候选。
func CollectVendorSelfUpdateRootCandidates(hostHomeDir string) []string {
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		return nil
	}
	return []string{
		filepath.Join(home, ".local", "share", "claude"),
		filepath.Join(home, ".claude", "local"),
		filepath.Join(home, ".opencode"),
	}
}

// ResolveInstallRoots 探测当前宿主上实际存在的各渠道根目录。
func ResolveInstallRoots(
	ctx context.Context,
	hostHomeDir string,
	env map[string]string,
	goos string,
	overrideNpmGlobalRoot string,
	nodeExecPath string,
) InstallRoots {
	if goos == "" {
		goos = runtime.GOOS
	}
	home := strings.TrimSpace(hostHomeDir)
	if home == "" {
		home = strings.TrimSpace(lookupEnvMapOrOS(env, "HOME"))
	}
	localAppData := strings.TrimSpace(lookupEnvMapOrOS(env, "LOCALAPPDATA"))

	npmRoot := strings.TrimSpace(overrideNpmGlobalRoot)
	if npmRoot == "" {
		npmRoot = ProbeNpmGlobalRoot(ctx, goos, nodeExecPath, env)
	}

	return InstallRoots{
		NpmGlobalRoot:         npmRoot,
		StandaloneRoots:       existingDirs(CollectStandaloneRootCandidates(home, localAppData)),
		VendorSelfUpdateRoots: existingDirs(CollectVendorSelfUpdateRootCandidates(home)),
		HomebrewRoots:         existingDirs(defaultHomebrewRoots),
	}
}

// ProbeNpmGlobalRoot 执行 `npm root -g` 取实际全局目录；失败时按 nodeExecPath 推导回退。
func ProbeNpmGlobalRoot(ctx context.Context, goos string, nodeExecPath string, env map[string]string) string {
	if ctx == nil {
		ctx = context.Background()
	}
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	cmdName := "npm"
	var cmd *exec.Cmd
	if isWindowsOS(goos) {
		cmd = exec.CommandContext(probeCtx, "cmd.exe", "/d", "/s", "/c", "npm.cmd root -g")
	} else {
		cmd = exec.CommandContext(probeCtx, cmdName, "root", "-g")
	}
	if len(env) > 0 {
		cmd.Env = envSliceFromMap(env)
	}
	if out, err := cmd.Output(); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" {
				return trimmed
			}
		}
	}

	nodeBin := strings.TrimSpace(nodeExecPath)
	if nodeBin == "" {
		nodeBin, _ = exec.LookPath("node")
	}
	if nodeBin == "" {
		return ""
	}
	binDir := filepath.Dir(nodeBin)
	if isWindowsOS(goos) {
		return filepath.Join(binDir, "node_modules")
	}
	return filepath.Join(filepath.Dir(binDir), "lib", "node_modules")
}

// NpmPackageDirFor 返回 npm 全局包在 root 下的预期目录路径。
func NpmPackageDirFor(npmGlobalRoot string, packageName string) string {
	root := strings.TrimSpace(npmGlobalRoot)
	pkg := strings.TrimSpace(packageName)
	if root == "" || pkg == "" {
		return ""
	}
	parts := append([]string{root}, strings.Split(pkg, "/")...)
	return filepath.Join(parts...)
}

func existingDirs(candidates []string) []string {
	seen := make(map[string]struct{}, len(candidates))
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		value := strings.TrimSpace(candidate)
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		if pathExists(value) {
			out = append(out, value)
		}
	}
	return out
}

func lookupEnvMapOrOS(env map[string]string, key string) string {
	if env != nil {
		if val, ok := env[key]; ok {
			return val
		}
	}
	return os.Getenv(key)
}

func envSliceFromMap(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}
