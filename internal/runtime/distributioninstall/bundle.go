package distributioninstall

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
)

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$`)

func Target() string {
	platform := runtime.GOOS
	if platform == "windows" {
		platform = "win32"
	}
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	return platform + "-" + arch
}
func ReadBuild(root string) (Build, error) {
	var b Build
	raw, err := os.ReadFile(filepath.Join(root, "BUILD_INFO.json"))
	if err != nil {
		return b, errors.New("请使用完整的 AIH 发行包安装或更新")
	}
	if len(raw) > 64*1024 || json.Unmarshal(raw, &b) != nil || b.Name != "ai-home" || !versionPattern.MatchString(b.Version) || b.Target != Target() || !b.BundledUI {
		return b, errors.New("安装包不适用于当前平台或缺少发行信息")
	}
	expected := filepath.Join("bin", "native", b.Target, "aih-server")
	if runtime.GOOS == "windows" {
		expected += ".exe"
	}
	if filepath.Clean(filepath.FromSlash(b.GoCore.Binary)) != expected {
		return b, errors.New("安装包原生组件路径无效")
	}
	hash, err := hashFile(filepath.Join(root, expected))
	if err != nil || hash != b.GoCore.SHA256 {
		return b, errors.New("安装包完整性校验失败，请重新下载")
	}
	// 运行资源校验以 Go CLI 为准：安装包的 aih 入口不再经由 Node 旧入口。
	cli := filepath.Join(filepath.Dir(filepath.FromSlash(b.GoCore.Binary)), "aih-go")
	if runtime.GOOS == "windows" {
		cli += ".exe"
	}
	for _, name := range []string{cli, "web/dist/index.html"} {
		if _, err := os.Stat(filepath.Join(root, name)); err != nil {
			return b, errors.New("安装包缺少运行资源")
		}
	}
	return b, nil
}
func bundleNode(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, "runtime", "node.exe")
	}
	return filepath.Join(root, "runtime", "bin", "node")
}
func bundleServer(root string) string {
	path := filepath.Join(root, "bin", "native", Target(), "aih-server")
	if runtime.GOOS == "windows" {
		path += ".exe"
	}
	return path
}
