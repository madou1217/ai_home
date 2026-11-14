package webuiopenappapi

import (
	"debug/buildinfo"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const goCLIProgramPath = "github.com/madou1217/ai_home/cmd/aih"

// resolveGoCLIExecutable 只接受 cmd/aih 的原生构件，不能把当前 aih-server、
// PATH 上的 Node aih 包装器或任意同名脚本当成 CLI。构件布局与 build-go-cli.js 一致。
func resolveGoCLIExecutable(deps NativeLauncherDependencies, environ []string) (string, error) {
	platform := normalizePlatformKey(deps.Platform)
	packagePlatform := platform
	name := "aih-go"
	if platform == "windows" {
		packagePlatform = "win32"
		name += ".exe"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	var candidates []string
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(executable), name))
	}
	if root := strings.TrimSpace(deps.RepoRoot); root != "" {
		candidates = append(candidates, filepath.Join(root, "bin", "native", packagePlatform+"-"+arch, name))
	}
	for _, directory := range hostSearchDirectories(environ, platform) {
		candidates = append(candidates, filepath.Join(directory, name))
	}
	for _, candidate := range candidates {
		if !filepath.IsAbs(candidate) || !isExecutableFile(candidate, platform) {
			continue
		}
		info, err := buildinfo.ReadFile(candidate)
		if err != nil || info.Path != goCLIProgramPath {
			continue
		}
		var goos, goarch string
		for _, setting := range info.Settings {
			switch setting.Key {
			case "GOOS":
				goos = setting.Value
			case "GOARCH":
				goarch = setting.Value
			}
		}
		if goos != platform || goarch != runtime.GOARCH {
			continue
		}
		return candidate, nil
	}
	return "", errors.New("未找到当前平台的 Go CLI 构件（aih-go）；请构建 cmd/aih 或安装完整发布包，不会回落 Node")
}
