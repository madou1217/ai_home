package providercli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrWorkbuddyRuntimeMissing 表示没有找到 WorkBuddy 桌面应用内嵌的 CLI 运行时。
//
// WorkBuddy 没有独立发行的 CLI：官方运行时只随桌面 App 分发在
// Contents/Resources/app.asar.unpacked/cli，通用 codebuddy 二进制读不到它的
// workbuddy-desktop(-ai).info，启动后只会提示重新登录。
var ErrWorkbuddyRuntimeMissing = errors.New("WorkBuddy 原生运行时缺失")

// LaunchBinary 是原生 CLI 的最终启动命令。
type LaunchBinary struct {
	Path       string
	PrefixArgs []string
	Env        map[string]string
}

type workbuddyApp struct {
	appName string
	authID  string
	label   string
}

var workbuddyApps = map[string]workbuddyApp{
	"workbuddy":   {appName: "WorkBuddy AI.app", authID: "workbuddy-desktop-ai", label: "WorkBuddy AI"},
	"workbuddycn": {appName: "WorkBuddy.app", authID: "workbuddy-desktop", label: "WorkBuddy"},
}

// ApplyLaunchEnv 把启动命令的固定环境覆盖进 K=V 列表。
func ApplyLaunchEnv(environment []string, extra map[string]string) []string {
	if len(extra) == 0 {
		return environment
	}
	out := make([]string, 0, len(environment)+len(extra))
	for _, entry := range environment {
		name, _, found := strings.Cut(entry, "=")
		if !found {
			continue
		}
		if _, overridden := extra[name]; overridden {
			continue
		}
		out = append(out, entry)
	}
	for name, value := range extra {
		out = append(out, name+"="+value)
	}
	return out
}

// ResolveLaunchBinary 解析 Provider 的原生启动命令。WorkBuddy 两支必须使用桌面
// App 内嵌 runtime，其余 Provider 维持 PATH 解析。
func ResolveLaunchBinary(providerID string, binary string, hostHomeDir string, goos string) (LaunchBinary, error) {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if spec, ok := workbuddyApps[normalized]; ok {
		return resolveWorkbuddyLaunch(spec, hostHomeDir, goos)
	}
	path, err := ResolveBinary(providerID, binary)
	if err != nil {
		return LaunchBinary{}, err
	}
	return LaunchBinary{Path: path}, nil
}

func resolveWorkbuddyLaunch(spec workbuddyApp, hostHomeDir string, goos string) (LaunchBinary, error) {
	if strings.ToLower(strings.TrimSpace(goos)) != "darwin" {
		return LaunchBinary{}, fmt.Errorf("%w: 仅支持 macOS 桌面 App", ErrWorkbuddyRuntimeMissing)
	}
	for _, appRoot := range workbuddyAppRoots(spec.appName, hostHomeDir) {
		entry := filepath.Join(appRoot, "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy")
		if info, err := os.Stat(entry); err != nil || info.IsDir() {
			continue
		}
		if !workbuddyProductMatches(filepath.Join(appRoot, "Contents", "Resources", "app.asar.unpacked", "cli", "product.json"), spec.authID) {
			continue
		}
		node, err := exec.LookPath("node")
		if err != nil {
			return LaunchBinary{}, fmt.Errorf("%w: 找不到 node 可执行文件", ErrWorkbuddyRuntimeMissing)
		}
		return LaunchBinary{
			Path:       node,
			PrefixArgs: []string{entry},
			Env:        map[string]string{"CODEBUDDY_FORCE_LITE_WB_BUNDLE": "1"},
		}, nil
	}
	return LaunchBinary{}, fmt.Errorf("%w: 请安装或修复 %s.app", ErrWorkbuddyRuntimeMissing, spec.label)
}

func workbuddyAppRoots(appName string, hostHomeDir string) []string {
	roots := []string{filepath.Join("/Applications", appName)}
	if home := strings.TrimSpace(hostHomeDir); home != "" {
		roots = append(roots, filepath.Join(home, "Applications", appName))
	}
	// 用户可能直接从 DMG 镜像卷里打开 App，此时运行时就只在 /Volumes 下。
	if volumes, err := os.ReadDir("/Volumes"); err == nil {
		for _, volume := range volumes {
			if !volume.IsDir() {
				continue
			}
			roots = append(roots, filepath.Join("/Volumes", volume.Name(), appName))
		}
	}
	return roots
}

func workbuddyProductMatches(path string, wantAuthID string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var product struct {
		Authentication struct {
			ID string `json:"id"`
		} `json:"authentication"`
	}
	if err := json.Unmarshal(data, &product); err != nil {
		return false
	}
	return strings.TrimSpace(product.Authentication.ID) == wantAuthID
}
