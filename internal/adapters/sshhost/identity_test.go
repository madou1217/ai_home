package sshhost

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func newIdentityHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".ssh"), 0o700); err != nil {
		t.Fatalf("创建 .ssh 失败: %v", err)
	}
	return home
}

func writeIdentityFile(t *testing.T, path string, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte("PRIVATE KEY"), perm); err != nil {
		t.Fatalf("写私钥失败: %v", err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatalf("改私钥权限失败: %v", err)
	}
}

func TestResolveIdentityFilePath(t *testing.T) {
	t.Parallel()
	home := newIdentityHome(t)
	keyPath := filepath.Join(home, ".ssh", "id_ed25519")
	writeIdentityFile(t, keyPath, 0o600)

	wantPath, err := filepath.EvalSymlinks(keyPath)
	if err != nil {
		t.Fatalf("解析真实路径失败: %v", err)
	}
	resolved, err := ResolveIdentityFilePath(keyPath, IdentityOptions{HomeDir: home})
	if err != nil {
		t.Fatalf("绝对路径解析失败: %v", err)
	}
	if resolved != wantPath {
		t.Fatalf("resolved = %q, want %q", resolved, wantPath)
	}

	tildeResolved, err := ResolveIdentityFilePath("~/.ssh/id_ed25519", IdentityOptions{HomeDir: home})
	if err != nil {
		t.Fatalf("~ 展开失败: %v", err)
	}
	if tildeResolved != wantPath {
		t.Fatalf("~ 展开 = %q, want %q", tildeResolved, wantPath)
	}
}

func TestResolveIdentityFilePathErrors(t *testing.T) {
	t.Parallel()
	home := newIdentityHome(t)
	missing := filepath.Join(home, ".ssh", "missing")
	directory := filepath.Join(home, ".ssh", "config-dir")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	openPerm := filepath.Join(home, ".ssh", "open_key")
	writeIdentityFile(t, openPerm, 0o644)
	outside := filepath.Join(t.TempDir(), "outside_key")
	writeIdentityFile(t, outside, 0o600)
	symlinkOutside := filepath.Join(home, ".ssh", "symlink_outside")
	if err := os.Symlink(outside, symlinkOutside); err != nil {
		t.Fatalf("创建软链接失败: %v", err)
	}

	cases := []struct {
		name     string
		value    string
		homeDir  string
		platform string
		wantCode string
	}{
		{name: "空值", value: "", homeDir: home, wantCode: IdentityFileRequired},
		{name: "仅空白", value: "   ", homeDir: home, wantCode: IdentityFileRequired},
		{name: "相对路径", value: ".ssh/id_ed25519", homeDir: home, wantCode: IdentityFileMustBeAbsolute},
		{name: "波浪号本身不是私钥", value: "~", homeDir: home, wantCode: IdentityFileOutsideSSHDir},
		{name: "ssh 目录之外", value: outside, homeDir: home, wantCode: IdentityFileOutsideSSHDir},
		{name: "软链接逃逸", value: symlinkOutside, homeDir: home, wantCode: IdentityFileOutsideSSHDir},
		{name: "文件不存在", value: missing, homeDir: home, wantCode: IdentityFileNotFound},
		{name: "目录不是普通文件", value: directory, homeDir: home, wantCode: IdentityFileNotRegularFile},
		{name: "权限过宽", value: openPerm, homeDir: home, wantCode: IdentityFilePermissionsTooOpen},
		{name: "windows 跳过权限检查", value: openPerm, homeDir: home, platform: "windows", wantCode: ""},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if testCase.wantCode == IdentityFilePermissionsTooOpen && runtime.GOOS == "windows" {
				t.Skip("windows 不做权限位检查")
			}
			_, err := ResolveIdentityFilePath(testCase.value, IdentityOptions{
				HomeDir:  testCase.homeDir,
				Platform: testCase.platform,
			})
			if testCase.wantCode == "" {
				if err != nil {
					t.Fatalf("预期成功，得到 %v", err)
				}
				return
			}
			var identityErr *IdentityFileError
			if !errors.As(err, &identityErr) {
				t.Fatalf("error = %v, want *IdentityFileError", err)
			}
			if identityErr.Code != testCase.wantCode {
				t.Fatalf("code = %q, want %q", identityErr.Code, testCase.wantCode)
			}
		})
	}
}

func TestResolveIdentityFilePathMissingSSHDir(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	_, err := ResolveIdentityFilePath(filepath.Join(home, ".ssh", "id"), IdentityOptions{HomeDir: home})
	var identityErr *IdentityFileError
	if !errors.As(err, &identityErr) || identityErr.Code != IdentityFileNotFound {
		t.Fatalf("error = %v, want %s", err, IdentityFileNotFound)
	}
}

func TestIsPathInside(t *testing.T) {
	t.Parallel()
	cases := []struct {
		parent    string
		candidate string
		want      bool
	}{
		{parent: "/home/me/.ssh", candidate: "/home/me/.ssh/id", want: true},
		{parent: "/home/me/.ssh", candidate: "/home/me/.ssh", want: true},
		{parent: "/home/me/.ssh", candidate: "/home/me/.sshh/id", want: false},
		{parent: "/home/me/.ssh", candidate: "/home/me/id", want: false},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.candidate, func(t *testing.T) {
			t.Parallel()
			if got := isPathInside(testCase.parent, testCase.candidate); got != testCase.want {
				t.Fatalf("isPathInside(%q, %q) = %v, want %v", testCase.parent, testCase.candidate, got, testCase.want)
			}
		})
	}
}
