package webuitoolkitruntimeapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

// fakeLookPath 只认 PATH 名（不含路径分隔符），绝对路径一律视为不存在，
// 这样「全部缺失」与「已知位置兜底」两个场景都能被精确控制。
func fakeLookPath(available map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if strings.ContainsRune(name, '/') {
			return "", errors.New("not found")
		}
		if path, ok := available[name]; ok {
			return path, nil
		}
		return "", errors.New("not found")
	}
}

type fakeRunner struct {
	outputs map[string]string
	err     error
	delay   time.Duration
}

func (fake fakeRunner) run(ctx context.Context, executable string, args []string) (string, error) {
	if fake.delay > 0 {
		select {
		case <-time.After(fake.delay):
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	if fake.err != nil {
		return "", fake.err
	}
	if output, ok := fake.outputs[executable]; ok {
		return output, nil
	}
	return "", nil
}

func newHandler(t *testing.T, dependencies Dependencies) http.Handler {
	t.Helper()
	if dependencies.Authorizer == nil {
		dependencies.Authorizer = fakeAuthorizer{allowed: true}
	}
	if dependencies.HostHomeDir == "" {
		dependencies.HostHomeDir = t.TempDir()
	}
	if dependencies.LookPath == nil {
		dependencies.LookPath = fakeLookPath(nil)
	}
	if dependencies.RunVersion == nil {
		dependencies.RunVersion = fakeRunner{}.run
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func decodeResponse(t *testing.T, recorder *httptest.ResponseRecorder) responseView {
	t.Helper()
	var payload responseView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	return payload
}

func toolByID(t *testing.T, payload responseView, id string) ToolView {
	t.Helper()
	for _, tool := range payload.Tools {
		if tool.ID == id {
			return tool
		}
	}
	t.Fatalf("缺少工具 %q：%#v", id, payload.Tools)
	return ToolView{}
}

func TestNewHandlerRequiresAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("error = %v, want ErrInvalidDependencies", err)
	}
}

func TestUnauthorized(t *testing.T) {
	handler := newHandler(t, Dependencies{Authorizer: fakeAuthorizer{allowed: false}})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", got)
	}
	var payload errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if payload.OK || payload.Error != "unauthorized" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	handler := newHandler(t, Dependencies{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, strings.NewReader("{}")))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow = %q", got)
	}
}

func TestAllToolsMissing(t *testing.T) {
	handler := newHandler(t, Dependencies{HostHomeDir: t.TempDir()})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeResponse(t, recorder)
	want := len(toolsForPlatform(currentPlatform()))
	if payload.Total != want || len(payload.Tools) != want {
		t.Fatalf("total = %d / %d, want %d", payload.Total, len(payload.Tools), want)
	}
	if !payload.OK || payload.Platform != currentPlatform() || payload.DerivedBy != derivedByGoPartial {
		t.Fatalf("payload = %#v", payload)
	}
	if payload.AvailableCount != 0 {
		t.Fatalf("availableCount = %d, want 0", payload.AvailableCount)
	}
	kinds := map[string]string{}
	for _, spec := range toolsForPlatform(currentPlatform()) {
		kinds[spec.ID] = spec.Kind
	}
	for _, tool := range payload.Tools {
		if tool.Available || tool.Version != "" || tool.VersionStatus != versionStatusMissing {
			t.Fatalf("tool = %#v", tool)
		}
		// 目录型工具照抄 Node：path 始终给出候选根目录（可能不存在）；命令型必须为空。
		if kinds[tool.ID] == kindCommand && tool.Path != "" {
			t.Fatalf("命令型工具 path = %q, want empty", tool.Path)
		}
	}
}

func TestPartiallyAvailableParsesVersion(t *testing.T) {
	handler := newHandler(t, Dependencies{
		HostHomeDir: t.TempDir(),
		LookPath: fakeLookPath(map[string]string{
			"git":  "/usr/bin/git",
			"go":   "/usr/local/go/bin/go",
			"pnpm": "/opt/homebrew/bin/pnpm",
		}),
		RunVersion: fakeRunner{outputs: map[string]string{
			"/usr/bin/git":           "git version 2.39.3 (Apple Git-145)\n",
			"/usr/local/go/bin/go":   "go version go1.22.1 darwin/arm64\n",
			"/opt/homebrew/bin/pnpm": "9.12.2\n",
		}}.run,
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	payload := decodeResponse(t, recorder)
	if payload.AvailableCount != 3 {
		t.Fatalf("availableCount = %d, want 3", payload.AvailableCount)
	}
	cases := []struct {
		id      string
		version string
		path    string
	}{
		{"git", "2.39.3", "/usr/bin/git"},
		{"go", "1.22.1", "/usr/local/go/bin/go"},
		{"pnpm", "9.12.2", "/opt/homebrew/bin/pnpm"},
	}
	for _, item := range cases {
		tool := toolByID(t, payload, item.id)
		if !tool.Available || tool.Version != item.version || tool.Path != item.path || tool.VersionStatus != versionStatusOK {
			t.Fatalf("%s = %#v", item.id, tool)
		}
	}
	if tool := toolByID(t, payload, "yarn"); tool.Available || tool.VersionStatus != versionStatusMissing {
		t.Fatalf("yarn = %#v", tool)
	}
}

func TestKnownPathFallback(t *testing.T) {
	home := t.TempDir()
	handler := newHandler(t, Dependencies{
		HostHomeDir: home,
		LookPath:    fakeLookPath(nil),
		RunVersion: fakeRunner{outputs: map[string]string{
			filepath.Join(home, ".cargo/bin/rustup"): "rustup 1.27.1 (2024-05-07)\n",
		}}.run,
	})
	// 兜底探测走 LookPath，这里让绝对路径命中一次。
	handler.(*Handler).lookPath = func(name string) (string, error) {
		if name == filepath.Join(home, ".cargo/bin/rustup") {
			return name, nil
		}
		return "", errors.New("not found")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	tool := toolByID(t, decodeResponse(t, recorder), "rustup")
	want := filepath.Join(home, ".cargo/bin/rustup")
	if !tool.Available || tool.Path != want || tool.Version != "1.27.1" || tool.VersionStatus != versionStatusOK {
		t.Fatalf("rustup = %#v", tool)
	}
}

func TestNVMAndCondaDirectoryProbes(t *testing.T) {
	home := t.TempDir()
	for _, directory := range []string{
		filepath.Join(home, ".nvm", "versions", "node", "v20.11.0"),
		filepath.Join(home, ".nvm", "versions", "node", "v22.1.0"),
		filepath.Join(home, "miniconda3"),
	} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", directory, err)
		}
	}
	handler := newHandler(t, Dependencies{HostHomeDir: home})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	payload := decodeResponse(t, recorder)
	if tool := toolByID(t, payload, "nvm"); !tool.Available || tool.Version != "2 个 Node.js 版本" {
		t.Fatalf("nvm = %#v", tool)
	}
	// conda 命令不可用但 ~/miniconda3 存在：照抄 Node 的「已安装」占位串。
	if tool := toolByID(t, payload, "conda"); !tool.Available || tool.Version != "已安装" || tool.Path != filepath.Join(home, "miniconda3") {
		t.Fatalf("conda = %#v", tool)
	}
}

// commandToolCount 返回当前平台上走命令探测的工具数（目录型 nvm/pyenv/conda 除外）。
func commandToolCount(platform string) int {
	return len(commandToolPaths(platform))
}

// commandToolPaths 为当前平台上每个命令型工具给出一个假的 PATH 命中，
// 这样目录型工具不会被命令探测顺带命中。
func commandToolPaths(platform string) map[string]string {
	paths := map[string]string{}
	for _, tool := range toolsForPlatform(platform) {
		if tool.Kind != kindCommand {
			continue
		}
		paths[tool.Command] = "/fake/bin/" + tool.ID
	}
	return paths
}

func TestVersionTimeoutDegrades(t *testing.T) {
	handler := newHandler(t, Dependencies{
		HostHomeDir: t.TempDir(),
		LookPath:    fakeLookPath(commandToolPaths(currentPlatform())),
		RunVersion:  fakeRunner{err: context.DeadlineExceeded}.run,
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	payload := decodeResponse(t, recorder)
	// 可执行文件找到了就是 available；版本超时只降级 version 字段。
	if want := commandToolCount(currentPlatform()); payload.AvailableCount != want {
		t.Fatalf("availableCount = %d, want %d", payload.AvailableCount, want)
	}
	for _, tool := range payload.Tools {
		if !tool.Available {
			continue
		}
		if tool.Version != "" || tool.VersionStatus != versionStatusTimeout {
			t.Fatalf("tool = %#v", tool)
		}
	}
}

func TestSlowVersionProbesRunConcurrently(t *testing.T) {
	handler := newHandler(t, Dependencies{
		HostHomeDir: t.TempDir(),
		LookPath:    fakeLookPath(commandToolPaths(currentPlatform())),
		RunVersion:  fakeRunner{delay: 80 * time.Millisecond}.run,
	})
	started := time.Now()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	elapsed := time.Since(started)
	payload := decodeResponse(t, recorder)
	// 串行 12 个工具 × 80ms 必然超过 900ms；并发时总耗时接近单次延迟。
	if elapsed > 600*time.Millisecond {
		t.Fatalf("elapsed = %s，版本探测没有并发", elapsed)
	}
	if want := commandToolCount(currentPlatform()); payload.AvailableCount != want {
		t.Fatalf("availableCount = %d, want %d", payload.AvailableCount, want)
	}
}

// 清单必须与 Node listRuntimeTools() 的顺序和 id 完全一致（界面顺序依赖它）。
func TestCatalogMatchesNodeOrder(t *testing.T) {
	want := []string{
		"nvm", "fnm", "volta", "pnpm", "yarn", "bun",
		"pyenv", "conda", "uv", "poetry",
		"rustup", "cargo-binstall",
		"go", "goenv",
		"git",
	}
	if len(environmentTools) != len(want) {
		t.Fatalf("工具数 = %d, want %d", len(environmentTools), len(want))
	}
	for index, id := range want {
		if environmentTools[index].ID != id {
			t.Fatalf("第 %d 项 = %q, want %q", index, environmentTools[index].ID, id)
		}
	}
	// 平台过滤：nvm、pyenv、goenv 只在 macos/linux 出现。
	for _, platform := range []string{"macos", "linux", "windows"} {
		filtered := toolsForPlatform(platform)
		if platform == "windows" && len(filtered) != len(want)-3 {
			t.Fatalf("windows 工具数 = %d, want %d", len(filtered), len(want)-3)
		}
		if platform != "windows" && len(filtered) != len(want) {
			t.Fatalf("%s 工具数 = %d, want %d", platform, len(filtered), len(want))
		}
	}
}
func TestResourcesShapeMatchesNode(t *testing.T) {
	handler := newHandler(t, Dependencies{HostHomeDir: t.TempDir()})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	payload := decodeResponse(t, recorder)
	if len(payload.Resources) != len(payload.Tools) {
		t.Fatalf("resources = %d, tools = %d", len(payload.Resources), len(payload.Tools))
	}
	for _, resource := range payload.Resources {
		if resource.ID == "" || resource.Platform != currentPlatform() {
			t.Fatalf("resource = %#v", resource)
		}
		if resource.ManagedVersions == nil {
			t.Fatalf("managedVersions 不能是 null: %#v", resource)
		}
		if resource.Lifecycle.Install != resource.CanInstall || resource.Lifecycle.Update != resource.CanUpdate || resource.Lifecycle.Uninstall != resource.CanUninstall {
			t.Fatalf("lifecycle 与 can 字段不一致: %#v", resource)
		}
	}
}
