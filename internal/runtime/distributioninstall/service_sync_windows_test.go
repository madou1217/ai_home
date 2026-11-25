//go:build windows

package distributioninstall

import (
	"os"
	"path/filepath"
	"testing"
)

func writeSyncTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func readSyncTestFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func TestSyncLegacyServiceFilesCopiesNativeAndWeb(t *testing.T) {
	home := t.TempDir()
	packageRoot := t.TempDir()
	writeSyncTestFile(t, filepath.Join(home, "bin", "run.cmd"), "@echo off\r\nlegacy")
	writeSyncTestFile(t, filepath.Join(home, "bin", "aih-server.exe"), "old-server")
	writeSyncTestFile(t, filepath.Join(home, "web", "dist", "index.html"), "old-index")
	writeSyncTestFile(t, filepath.Join(home, "web", "dist", "stale.txt"), "stale")

	native := filepath.Join(packageRoot, "bin", "native", Target())
	writeSyncTestFile(t, filepath.Join(native, "aih-server.exe"), "new-server")
	writeSyncTestFile(t, filepath.Join(native, "aih-go.exe"), "new-cli")
	writeSyncTestFile(t, filepath.Join(native, "aih-server.exe.build.json"), "build-meta")
	writeSyncTestFile(t, filepath.Join(packageRoot, "web", "dist", "index.html"), "new-index")
	writeSyncTestFile(t, filepath.Join(packageRoot, "web", "dist", "assets", "app.js"), "new-asset")

	if err := syncLegacyServiceFiles(Options{Home: home, PackageRoot: packageRoot}); err != nil {
		t.Fatalf("syncLegacyServiceFiles: %v", err)
	}

	if got := readSyncTestFile(t, filepath.Join(home, "bin", "aih-server.exe")); got != "new-server" {
		t.Fatalf("server = %q", got)
	}
	if got := readSyncTestFile(t, filepath.Join(home, "bin", "aih-go.exe")); got != "new-cli" {
		t.Fatalf("cli = %q", got)
	}
	if got := readSyncTestFile(t, filepath.Join(home, "bin", "run.cmd")); got != "@echo off\r\nlegacy" {
		t.Fatalf("run.cmd changed = %q", got)
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "aih-server.exe.build.json")); !os.IsNotExist(err) {
		t.Fatalf("build metadata should not be copied, err=%v", err)
	}
	if got := readSyncTestFile(t, filepath.Join(home, "web", "dist", "index.html")); got != "new-index" {
		t.Fatalf("index = %q", got)
	}
	if got := readSyncTestFile(t, filepath.Join(home, "web", "dist", "assets", "app.js")); got != "new-asset" {
		t.Fatalf("asset = %q", got)
	}
	if _, err := os.Stat(filepath.Join(home, "web", "dist", "stale.txt")); !os.IsNotExist(err) {
		t.Fatalf("stale web file should be removed, err=%v", err)
	}
}

func TestSyncLegacyServiceFilesSkipsWithoutRunScript(t *testing.T) {
	home := t.TempDir()
	packageRoot := t.TempDir()
	native := filepath.Join(packageRoot, "bin", "native", Target())
	writeSyncTestFile(t, filepath.Join(native, "aih-server.exe"), "new-server")

	if err := syncLegacyServiceFiles(Options{Home: home, PackageRoot: packageRoot}); err != nil {
		t.Fatalf("syncLegacyServiceFiles: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "aih-server.exe")); !os.IsNotExist(err) {
		t.Fatalf("fresh layout should not be modified, err=%v", err)
	}
}
