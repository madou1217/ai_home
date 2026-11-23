package apps

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// buildTestAihGoHelper 在临时仓库根目录构建受管的 aih-go 构件，供需要真实
// Go CLI 解析的用例使用；布局与 scripts/build-go-cli.js 一致：
// bin/native/<platform>-<arch>/aih-go。
//
// 用例把 AIH_ROOT 指向返回目录即可，不再依赖源码树里预构建的 bin/native。
func buildTestAihGoHelper(t *testing.T) string {
	t.Helper()
	root := testRepositoryRoot(t)
	tempRoot := t.TempDir()
	platform := runtime.GOOS
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
	target := filepath.Join(tempRoot, "bin", "native", packagePlatform+"-"+arch, name)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	build := exec.Command("go", "build", "-o", target, "./cmd/aih")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build aih-go: %v\n%s", err, output)
	}
	return tempRoot
}

func testRepositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试源文件")
	}
	dir := filepath.Dir(file)
	for depth := 0; depth < 12; depth++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatal("无法定位仓库根目录")
	return ""
}
