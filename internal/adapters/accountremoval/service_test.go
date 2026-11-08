package accountremoval_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accountremoval"
)

const testAccountRef = "acct_0123456789abcdef0123"

func tempRoot(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("解析临时目录: %v", err)
	}
	return resolved
}

func newService(t *testing.T, aiHome string, probe accountremoval.SessionProbe) *accountremoval.Service {
	t.Helper()
	service, err := accountremoval.New(accountremoval.Options{AIHomeDir: aiHome, Probe: probe})
	if err != nil {
		t.Fatalf("创建宿主清理服务: %v", err)
	}
	return service
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("创建目录 %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写入 %s: %v", path, err)
	}
}

func assertMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("%s 应不存在, lstat err = %v", path, err)
	}
}

func TestNewRejectsInvalidHome(t *testing.T) {
	if _, err := accountremoval.New(accountremoval.Options{}); !errors.Is(err, accountremoval.ErrInvalidOptions) {
		t.Fatalf("空 AIH_HOME 应被拒绝, err = %v", err)
	}
	if _, err := accountremoval.New(accountremoval.Options{AIHomeDir: "relative/path"}); !errors.Is(err, accountremoval.ErrInvalidOptions) {
		t.Fatalf("相对 AIH_HOME 应被拒绝, err = %v", err)
	}
	if _, err := accountremoval.New(accountremoval.Options{
		AIHomeDir: filepath.Join(tempRoot(t), "missing"),
	}); !errors.Is(err, accountremoval.ErrInvalidOptions) {
		t.Fatalf("不存在的 AIH_HOME 应被拒绝, err = %v", err)
	}
}

func TestRuntimeProjectionDirs(t *testing.T) {
	aiHome := tempRoot(t)
	service := newService(t, aiHome, nil)

	tests := []struct {
		name         string
		provider     string
		accountRef   string
		wantSuffixes []string
	}{
		{
			name:       "codex 同时有 auth projection 与 desktop 根",
			provider:   "codex",
			accountRef: testAccountRef,
			wantSuffixes: []string{
				filepath.Join("run", "auth-projections", "codex", testAccountRef),
				filepath.Join("run", "codex-desktop", testAccountRef),
			},
		},
		{
			name:         "claude 只有 auth projection",
			provider:     "claude",
			accountRef:   testAccountRef,
			wantSuffixes: []string{filepath.Join("run", "auth-projections", "claude", testAccountRef)},
		},
		{
			name:       "Provider 与账号引用都按边界归一",
			provider:   "  CODEX  ",
			accountRef: " " + testAccountRef + " ",
			wantSuffixes: []string{
				filepath.Join("run", "auth-projections", "codex", testAccountRef),
				filepath.Join("run", "codex-desktop", testAccountRef),
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dirs, err := service.RuntimeProjectionDirs(test.provider, test.accountRef)
			if err != nil {
				t.Fatalf("解析投影目录: %v", err)
			}
			if len(dirs) != len(test.wantSuffixes) {
				t.Fatalf("投影目录数量 = %d, want %d (%v)", len(dirs), len(test.wantSuffixes), dirs)
			}
			for index, suffix := range test.wantSuffixes {
				want := filepath.Join(aiHome, suffix)
				if dirs[index] != want {
					t.Fatalf("投影目录[%d] = %s, want %s", index, dirs[index], want)
				}
			}
		})
	}
}

func TestRuntimeProjectionDirsRejectUnsafeTargets(t *testing.T) {
	service := newService(t, tempRoot(t), nil)

	tests := []struct {
		name       string
		provider   string
		accountRef string
	}{
		{name: "空 Provider", provider: "", accountRef: testAccountRef},
		{name: "Provider 含路径分隔符", provider: "../codex", accountRef: testAccountRef},
		{name: "Provider 含反斜杠", provider: `codex\..\claude`, accountRef: testAccountRef},
		{name: "账号引用为空", provider: "codex", accountRef: ""},
		{name: "账号引用越界", provider: "codex", accountRef: "acct_../../etc/passwd"},
		{name: "账号引用非规范十六进制", provider: "codex", accountRef: "acct_0123456789ABCDEF0123"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.RuntimeProjectionDirs(test.provider, test.accountRef); !errors.Is(err, accountremoval.ErrInvalidRequest) {
				t.Fatalf("应拒绝非法目标, err = %v", err)
			}
		})
	}
}

func TestRemoveRuntimeProjectionsIsIdempotent(t *testing.T) {
	ctx := context.Background()
	aiHome := tempRoot(t)
	service := newService(t, aiHome, nil)

	authRoot := filepath.Join(aiHome, "run", "auth-projections", "codex", testAccountRef)
	desktopRoot := filepath.Join(aiHome, "run", "codex-desktop", testAccountRef)
	writeFile(t, filepath.Join(authRoot, ".codex", "auth.json"), `{"token":"x"}`)
	writeFile(t, filepath.Join(desktopRoot, "auth.json"), `{"token":"x"}`)
	hostFile := filepath.Join(aiHome, "host-codex-auth.json")
	writeFile(t, hostFile, "keep")
	// 同 Provider 的其它账号投影不能被顺带删除。
	siblingRoot := filepath.Join(aiHome, "run", "auth-projections", "codex", "acct_ffffffffffffffffffff")
	writeFile(t, filepath.Join(siblingRoot, ".codex", "auth.json"), `{"token":"y"}`)

	if has, err := service.HasRuntimeProjection("codex", testAccountRef); err != nil || !has {
		t.Fatalf("删除前应存在投影, has = %v, err = %v", has, err)
	}
	if err := service.RemoveRuntimeProjections(ctx, "codex", testAccountRef); err != nil {
		t.Fatalf("删除投影: %v", err)
	}
	assertMissing(t, authRoot)
	assertMissing(t, desktopRoot)
	if content, err := os.ReadFile(hostFile); err != nil || string(content) != "keep" {
		t.Fatalf("AIH_HOME 下的其它文件不能被误删, content = %q, err = %v", content, err)
	}
	if _, err := os.Lstat(siblingRoot); err != nil {
		t.Fatalf("其它账号的投影不能被误删, stat err = %v", err)
	}
	if has, err := service.HasRuntimeProjection("codex", testAccountRef); err != nil || has {
		t.Fatalf("删除后不应再有投影, has = %v, err = %v", has, err)
	}
	// 幂等：目录已不存在时重复删除必须成功。
	if err := service.RemoveRuntimeProjections(ctx, "codex", testAccountRef); err != nil {
		t.Fatalf("重复删除投影应成功: %v", err)
	}
}

func TestRemoveRuntimeProjectionsRejectsSymlinkEscape(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name        string
		symlinkRoot bool
	}{
		{name: "父级目录是 symlink"},
		{name: "投影根自身是 symlink", symlinkRoot: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			aiHome := tempRoot(t)
			outside := tempRoot(t)
			sentinel := filepath.Join(outside, "sentinel.txt")
			writeFile(t, sentinel, "outside")
			if err := os.MkdirAll(filepath.Join(aiHome, "run"), 0o700); err != nil {
				t.Fatalf("创建 run 目录: %v", err)
			}
			if test.symlinkRoot {
				parent := filepath.Join(aiHome, "run", "auth-projections", "claude")
				if err := os.MkdirAll(parent, 0o700); err != nil {
					t.Fatalf("创建投影父级: %v", err)
				}
				if err := os.Symlink(outside, filepath.Join(parent, testAccountRef)); err != nil {
					t.Fatalf("创建投影 symlink: %v", err)
				}
			} else if err := os.Symlink(outside, filepath.Join(aiHome, "run", "auth-projections")); err != nil {
				t.Fatalf("创建父级 symlink: %v", err)
			}

			service := newService(t, aiHome, nil)
			err := service.RemoveRuntimeProjections(ctx, "claude", testAccountRef)
			if !errors.Is(err, accountremoval.ErrRuntimeProjectionUnsafe) {
				t.Fatalf("symlink 投影应被拒绝, err = %v", err)
			}
			if content, readErr := os.ReadFile(sentinel); readErr != nil || string(content) != "outside" {
				t.Fatalf("数据根外文件必须保持原样, content = %q, err = %v", content, readErr)
			}
		})
	}
}

func TestRemoveRuntimeProjectionsRejectsFileAtRoot(t *testing.T) {
	ctx := context.Background()
	aiHome := tempRoot(t)
	service := newService(t, aiHome, nil)
	root := filepath.Join(aiHome, "run", "auth-projections", "claude", testAccountRef)
	writeFile(t, root, "not a directory")

	err := service.RemoveRuntimeProjections(ctx, "claude", testAccountRef)
	if !errors.Is(err, accountremoval.ErrRuntimeProjectionUnsafe) {
		t.Fatalf("投影根是文件时应失败关闭, err = %v", err)
	}
	if _, statErr := os.Lstat(root); statErr != nil {
		t.Fatalf("失败时不能删除任何东西, stat err = %v", statErr)
	}
}
