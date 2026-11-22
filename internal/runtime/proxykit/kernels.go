package proxykit

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

const (
	RelaySettingsEnv     = "AIH_RELAY_SETTINGS"
	SingBoxRelayBasePort = 23100
	MihomoRelayBasePort  = 23400
	RelayDefaultMaxPorts = 256
)

var (
	singBoxVerOutRegex = regexp.MustCompile(`(?i)sing-box\s+version\s+v?(\d+\.\d+(?:\.\d+)?)`)
	mihomoVerOutRegex  = regexp.MustCompile(`v(\d+\.\d+(?:\.\d+)?)`)
)

func normalizePlatformName(p string) string {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "windows", "win32", "win":
		return "win32"
	case "darwin", "mac", "macos":
		return "darwin"
	case "linux":
		return "linux"
	default:
		return strings.ToLower(strings.TrimSpace(p))
	}
}

// ParseRelaySettings 解析 AIH_RELAY_SETTINGS（逗号分隔的 key=value 串）。
func ParseRelaySettings(raw string) map[string]string {
	out := map[string]string{}
	for _, part := range strings.Split(raw, ",") {
		idx := strings.IndexByte(part, '=')
		if idx <= 0 {
			continue
		}
		k := strings.TrimSpace(part[:idx])
		v := strings.TrimSpace(part[idx+1:])
		if k == "" || v == "" {
			continue
		}
		if decoded, err := url.QueryUnescape(v); err == nil {
			out[k] = decoded
		} else {
			out[k] = v
		}
	}
	return out
}

// ReadRelaySetting 读取指定 key 的中转运行参数（不存在返回 fallback）。
func ReadRelaySetting(env map[string]string, key, fallback string) string {
	var raw string
	if env != nil {
		raw = env[RelaySettingsEnv]
	} else {
		raw = os.Getenv(RelaySettingsEnv)
	}
	fields := ParseRelaySettings(raw)
	if val, ok := fields[key]; ok && val != "" {
		return val
	}
	return fallback
}

// ResolveKernelBinary 按 explicit -> managed -> PATH -> system 顺序定位内核可执行文件。
func ResolveKernelBinary(spec RelayKernelSpec, env map[string]string, aiHomeDir, platform string) *ResolvedKernelBinary {
	if platform == "" {
		platform = runtime.GOOS
	}
	normPlat := normalizePlatformName(platform)
	explicit := strings.TrimSpace(ReadRelaySetting(env, spec.EnvField, ""))
	if explicit != "" {
		if executableExists(explicit) {
			return &ResolvedKernelBinary{Path: explicit, Source: "explicit"}
		}
		return nil
	}

	names := make([]string, 0, 1+len(spec.Aliases))
	allNames := append([]string{spec.ID}, spec.Aliases...)
	for _, n := range allNames {
		if normPlat == "win32" && !strings.HasSuffix(strings.ToLower(n), ".exe") {
			names = append(names, n+".exe")
		} else {
			names = append(names, n)
		}
	}

	if aiHomeDir != "" {
		for _, n := range names {
			candidate := filepath.Join(aiHomeDir, "bin", n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "managed"}
			}
		}
	}

	pathEnv := envLookup(env, "PATH")
	for _, dir := range filepath.SplitList(pathEnv) {
		if dir == "" {
			continue
		}
		for _, n := range names {
			candidate := filepath.Join(dir, n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "path"}
			}
		}
	}

	for _, dir := range kernelBaseDirs(normPlat) {
		for _, n := range names {
			candidate := filepath.Join(dir, n)
			if executableExists(candidate) {
				return &ResolvedKernelBinary{Path: candidate, Source: "system"}
			}
		}
	}
	return nil
}

// ResolvePoolKernel 定位并读取指定内核的版本；找不到返回 nil。
func ResolvePoolKernel(id, aiHomeDir, platform string) *PoolKernel {
	var spec RelayKernelSpec
	switch strings.ToLower(strings.TrimSpace(id)) {
	case "sing-box":
		spec = SingBoxKernelSpec
	case "mihomo":
		spec = MihomoKernelSpec
	default:
		return nil
	}
	binary := ResolveKernelBinary(spec, nil, aiHomeDir, platform)
	if binary == nil {
		return nil
	}
	return &PoolKernel{
		ID:      spec.ID,
		Path:    binary.Path,
		Source:  binary.Source,
		Version: readKernelVersion(spec, binary.Path),
	}
}

func readKernelVersion(spec RelayKernelSpec, path string) string {
	if len(spec.VersionArgs) == 0 || spec.ParseVersion == nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, spec.VersionArgs...).CombinedOutput()
	if err != nil {
		return ""
	}
	return spec.ParseVersion(string(output))
}

// ResolvedKernelBinary 描述找到的内核可执行文件与来源。
type ResolvedKernelBinary struct {
	Path    string
	Source  string
	Version string
}

// RelayKernelSpec 描述一种中转内核（sing-box / mihomo）的能力与查找规则。
type RelayKernelSpec struct {
	ID                      string
	Label                   string
	EnvField                string
	Aliases                 []string
	ConfigFileName          string
	BasePort                int
	MaxPorts                int
	VersionArgs             []string
	BuildDependentProtocols []string
	ParseVersion            func(string) string
	CheckArgs               func(configFile, runDir string) []string
	RunArgs                 func(configFile, runDir string) []string
}

// CompileSingBoxRelayConfig 生成 sing-box 本机中转边车 JSON 配置与端口表。
// PoolKernel 描述出口池可用的代理内核（sing-box / mihomo）。
type PoolKernel struct {
	ID      string
	Path    string
	Source  string
	Version string
}

func kernelBaseDirs(platform string) []string {
	if platform == "win32" || platform == "windows" {
		return []string{`C:\ProgramData\chocolatey\bin`, `C:\Program Files\sing-box`, `C:\Program Files\mihomo`}
	}
	return []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"}
}

func executableExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func envLookup(env map[string]string, key string) string {
	if env != nil {
		return env[key]
	}
	return os.Getenv(key)
}

var (
	SingBoxKernelSpec = RelayKernelSpec{
		ID:                      "sing-box",
		Label:                   "sing-box",
		EnvField:                "singBoxBin",
		ConfigFileName:          "sing-box.json",
		BasePort:                SingBoxRelayBasePort,
		MaxPorts:                RelayDefaultMaxPorts,
		VersionArgs:             []string{"version"},
		BuildDependentProtocols: []string{"naive"},
		ParseVersion: func(stdout string) string {
			m := singBoxVerOutRegex.FindStringSubmatch(stdout)
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		},
		CheckArgs: func(configFile, _ string) []string {
			return []string{"check", "-c", configFile}
		},
		RunArgs: func(configFile, _ string) []string {
			return []string{"run", "-c", configFile}
		},
	}

	MihomoKernelSpec = RelayKernelSpec{
		ID:                      "mihomo",
		Label:                   "mihomo",
		EnvField:                "mihomoBin",
		Aliases:                 []string{"verge-mihomo-alpha", "clash-meta", "clash.meta"},
		ConfigFileName:          "mihomo.yaml",
		BasePort:                MihomoRelayBasePort,
		MaxPorts:                RelayDefaultMaxPorts,
		VersionArgs:             []string{"-v"},
		BuildDependentProtocols: []string{},
		ParseVersion: func(stdout string) string {
			m := mihomoVerOutRegex.FindStringSubmatch(stdout)
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		},
		CheckArgs: func(configFile, runDir string) []string {
			return []string{"-t", "-d", runDir, "-f", configFile}
		},
		RunArgs: func(configFile, runDir string) []string {
			return []string{"-d", runDir, "-f", configFile}
		},
	}
)
