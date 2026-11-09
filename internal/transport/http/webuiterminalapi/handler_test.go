package webuiterminalapi

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

const testManagementKey = "test-management-key"

type testAuthorizer struct{}

func (testAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("Authorization") == "Bearer "+testManagementKey
}

// fakeDurable 隔离 tmux；默认「没有 tmux」，因此 keyed 会话退化为非持久会话。
type fakeDurable struct {
	probe     DurableProbe
	create    DurableCreate
	createErr error
	closed    []string
}

func (durable *fakeDurable) Probe(string) DurableProbe { return durable.probe }

func (durable *fakeDurable) Create(string, DurableSpec) (DurableCreate, error) {
	if durable.createErr != nil {
		return DurableCreate{}, durable.createErr
	}
	return durable.create, nil
}

func (durable *fakeDurable) AttachCommand(string) (string, []string) {
	return "tmux", []string{"attach-session", "-t", "=web"}
}

func (durable *fakeDurable) Close(key string) error {
	durable.closed = append(durable.closed, key)
	return nil
}

func newTestHandler(t *testing.T, durable DurableStore) (*Handler, *httptest.Server) {
	t.Helper()
	service := terminalsession.NewService(pty.NewStarter(), terminalsession.Options{
		IdleTimeout:   time.Minute,
		ExitRetention: 250 * time.Millisecond,
	})
	t.Cleanup(service.Shutdown)
	if durable == nil {
		durable = &fakeDurable{probe: DurableProbe{State: DurableMissing}}
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:        testAuthorizer{},
		Sessions:          service,
		Durable:           durable,
		HomeDir:           t.TempDir(),
		Shell:             func() Shell { return Shell{File: "/bin/sh", Args: []string{"-c", "exec /bin/sh"}} },
		HeartbeatInterval: time.Minute,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return handler, server
}

func postJSON(t *testing.T, server *httptest.Server, path string, body any) (*http.Response, map[string]any) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+Prefix+path, bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	_ = response.Body.Close()
	return response, decoded
}

func getJSON(t *testing.T, server *httptest.Server, path string) (*http.Response, map[string]any) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, server.URL+Prefix+path, nil)
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	_ = response.Body.Close()
	return response, decoded
}

type sseFrame struct {
	Type   string `json:"type"`
	TermID string `json:"termId"`
	Data   string `json:"data"`
}

// openMux 建立一条 mux SSE 并返回逐帧读取的通道。
func openMux(t *testing.T, server *httptest.Server, muxID string) (<-chan sseFrame, func()) {
	t.Helper()
	request, _ := http.NewRequest(http.MethodGet, server.URL+Prefix+"/mux?muxId="+muxID, nil)
	request.Header.Set("Authorization", "Bearer "+testManagementKey)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("open mux: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("mux status = %d", response.StatusCode)
	}
	frames := make(chan sseFrame, 128)
	done := make(chan struct{})
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(response.Body)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var frame sseFrame
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &frame) != nil {
				continue
			}
			select {
			case frames <- frame:
			case <-done:
				return
			}
		}
	}()
	return frames, func() {
		close(done)
		_ = response.Body.Close()
	}
}

func waitForOutput(t *testing.T, frames <-chan sseFrame, termID string, contains string) string {
	t.Helper()
	deadline := time.After(10 * time.Second)
	var collected strings.Builder
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatalf("mux 提前结束，已收到 %q", collected.String())
			}
			if frame.Type != "output" || frame.TermID != termID {
				continue
			}
			data, err := base64.StdEncoding.DecodeString(frame.Data)
			if err != nil {
				t.Fatalf("output 不是 base64: %v", err)
			}
			collected.Write(data)
			if strings.Contains(collected.String(), contains) {
				return collected.String()
			}
		case <-deadline:
			t.Fatalf("等待输出 %q 超时，已收到 %q", contains, collected.String())
		}
	}
}

func TestServeHTTPRequiresManagementKey(t *testing.T) {
	_, server := newTestHandler(t, nil)
	response, err := http.Post(server.URL+Prefix+"/open", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}
}

func TestLaunchInputResizeCloseAndMuxFrames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	_, server := newTestHandler(t, nil)
	muxID := "mux-test-1"
	frames, closeMux := openMux(t, server, muxID)
	defer closeMux()

	response, opened := postJSON(t, server, "/launch", map[string]any{
		"muxId": muxID,
		"file":  "/bin/sh",
		"args":  []string{"-c", "printf 'READY\\n'; read line; printf 'GOT:%s\\n' \"$line\""},
		"cols":  80,
		"rows":  24,
	})
	if response.StatusCode != http.StatusOK || opened["ok"] != true {
		t.Fatalf("launch = %d %#v", response.StatusCode, opened)
	}
	termID, _ := opened["termId"].(string)
	if termID == "" {
		t.Fatalf("launch 没有返回 termId: %#v", opened)
	}
	if opened["shell"] != "/bin/sh" || opened["durable"] != false {
		t.Fatalf("launch 元数据 = %#v", opened)
	}

	waitForOutput(t, frames, termID, "READY")

	resizeResponse, resized := postJSON(t, server, "/resize", map[string]any{
		"termId": termID, "cols": 100, "rows": 30,
	})
	if resizeResponse.StatusCode != http.StatusOK || resized["cols"] != float64(100) || resized["rows"] != float64(30) {
		t.Fatalf("resize = %d %#v", resizeResponse.StatusCode, resized)
	}

	inputResponse, _ := postJSON(t, server, "/input", map[string]any{"termId": termID, "data": "hi\n"})
	if inputResponse.StatusCode != http.StatusOK {
		t.Fatalf("input status = %d", inputResponse.StatusCode)
	}
	waitForOutput(t, frames, termID, "GOT:hi")

	closeResponse, closed := postJSON(t, server, "/close", map[string]any{"termId": termID})
	if closeResponse.StatusCode != http.StatusOK || closed["ok"] != true {
		t.Fatalf("close = %d %#v", closeResponse.StatusCode, closed)
	}
}

func TestLaunchAppliesEnvOverrides(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	_, server := newTestHandler(t, nil)
	muxID := "mux-env"
	frames, closeMux := openMux(t, server, muxID)
	defer closeMux()
	response, opened := postJSON(t, server, "/launch", map[string]any{
		"muxId": muxID,
		"file":  "/bin/sh",
		"args":  []string{"-c", "printf 'ENV:%s\\n' \"$AIH_E2E_ENV\""},
		"env":   []string{"AIH_E2E_ENV=from-node"},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("launch = %d %#v", response.StatusCode, opened)
	}
	termID, _ := opened["termId"].(string)
	waitForOutput(t, frames, termID, "ENV:from-node")
	_, _ = postJSON(t, server, "/close", map[string]any{"termId": termID})
}

func TestAttachWithoutMuxKeepsExistingBinding(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	_, server := newTestHandler(t, nil)
	muxID := "mux-sticky"
	frames, closeMux := openMux(t, server, muxID)
	defer closeMux()
	_, opened := postJSON(t, server, "/launch", map[string]any{
		"sessionKey": "sticky-key",
		"muxId":      muxID,
		"file":       "/bin/sh",
		"args":       []string{"-c", "printf 'BOUND\\n'; read line; printf 'AFTER:%s\\n' \"$line\""},
	})
	termID, _ := opened["termId"].(string)
	waitForOutput(t, frames, termID, "BOUND")

	// attach 不带 muxId：不能把会话从仍开着的面板上摘下来（对应 Node
	// 「只有 body.muxId 存在才更新 session.muxId」）。
	attach, attached := postJSON(t, server, "/attach", map[string]any{"sessionKey": "sticky-key"})
	if attach.StatusCode != http.StatusOK || attached["muxId"] != muxID {
		t.Fatalf("attach = %d %#v", attach.StatusCode, attached)
	}
	_, _ = postJSON(t, server, "/input", map[string]any{"termId": termID, "data": "x\n"})
	waitForOutput(t, frames, termID, "AFTER:x")
	_, _ = postJSON(t, server, "/close", map[string]any{"sessionKey": "sticky-key"})
}

func TestBrowserOpenIgnoresExecutableFields(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	_, server := newTestHandler(t, nil)
	// /open 只收浏览器字段：file/args 必须被忽略，否则任意命令执行就绕过了 /launch 边界。
	response, opened := postJSON(t, server, "/open", map[string]any{
		"cols": 80, "rows": 24, "file": "/bin/echo", "args": []string{"pwned"},
	})
	if response.StatusCode != http.StatusOK || opened["ok"] != true {
		t.Fatalf("open = %d %#v", response.StatusCode, opened)
	}
	termID, _ := opened["termId"].(string)
	defer func() { _, _ = postJSON(t, server, "/close", map[string]any{"termId": termID}) }()
	if opened["shell"] != "/bin/sh" {
		t.Fatalf("open 应该使用默认 shell，实际 %#v", opened["shell"])
	}
}

func TestAttachMissingSessionReturnsNotFound(t *testing.T) {
	_, server := newTestHandler(t, nil)
	response, body := postJSON(t, server, "/attach", map[string]any{"sessionKey": "no-such-session"})
	if response.StatusCode != http.StatusNotFound || body["error"] != "terminal_not_found" {
		t.Fatalf("attach = %d %#v", response.StatusCode, body)
	}
}

func TestAttachSurfacesPersistentBackendFailure(t *testing.T) {
	durable := &fakeDurable{probe: DurableProbe{State: DurableUnavailable, Message: "tmux broken"}}
	_, server := newTestHandler(t, durable)
	response, body := postJSON(t, server, "/attach", map[string]any{"sessionKey": "k"})
	if response.StatusCode != http.StatusServiceUnavailable || body["error"] != "persistent_terminal_unavailable" {
		t.Fatalf("attach = %d %#v", response.StatusCode, body)
	}
}

func TestCloseRejectsIdentityMismatch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	_, server := newTestHandler(t, nil)
	response, opened := postJSON(t, server, "/launch", map[string]any{
		"sessionKey": "identity-key", "file": "/bin/sh", "args": []string{"-c", "exec /bin/sh"},
	})
	if response.StatusCode != http.StatusOK {
		t.Fatalf("launch = %d %#v", response.StatusCode, opened)
	}
	termID, _ := opened["termId"].(string)
	mismatch, body := postJSON(t, server, "/close", map[string]any{"termId": termID, "sessionKey": "other-key"})
	if mismatch.StatusCode != http.StatusConflict || body["error"] != "terminal_identity_mismatch" {
		t.Fatalf("close mismatch = %d %#v", mismatch.StatusCode, body)
	}
	_, _ = postJSON(t, server, "/close", map[string]any{"termId": termID, "sessionKey": "identity-key"})
}

func TestClipboardImageWritesProjectFile(t *testing.T) {
	_, server := newTestHandler(t, nil)
	project := t.TempDir()
	png := mustDecodeBase64(t, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)

	response, body := postJSON(t, server, "/clipboard-image", map[string]any{
		"cwd": project, "dataUrl": dataURL,
	})
	if response.StatusCode != http.StatusCreated || body["ok"] != true {
		t.Fatalf("clipboard = %d %#v", response.StatusCode, body)
	}
	path, _ := body["path"].(string)
	if !strings.HasPrefix(path, filepath.Join(project, ".aih", "chat-images")) {
		t.Fatalf("图片应落在项目目录: %s", path)
	}
	content, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(content, png) {
		t.Fatalf("图片内容不一致: %v", err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("图片权限 = %o, want 600", info.Mode().Perm())
	}
	if body["pasteText"] != "'"+path+"'" && body["pasteText"] != path {
		t.Fatalf("pasteText = %#v", body["pasteText"])
	}
}

func TestClipboardImageRejectsMismatchedMime(t *testing.T) {
	_, server := newTestHandler(t, nil)
	png := mustDecodeBase64(t, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
	response, body := postJSON(t, server, "/clipboard-image", map[string]any{
		"dataUrl": "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(png),
	})
	if response.StatusCode != http.StatusBadRequest || body["error"] != "terminal_image_invalid" {
		t.Fatalf("clipboard mismatch = %d %#v", response.StatusCode, body)
	}
}

func TestProbeReportsDurableState(t *testing.T) {
	durable := &fakeDurable{probe: DurableProbe{State: DurableAlive}}
	_, server := newTestHandler(t, durable)
	response, body := getJSON(t, server, "/probe?sessionKey=abc")
	if response.StatusCode != http.StatusOK || body["state"] != "alive" {
		t.Fatalf("probe = %d %#v", response.StatusCode, body)
	}
}

func TestOpenReusesKeyedSession(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 /bin/sh")
	}
	durable := &fakeDurable{probe: DurableProbe{State: DurableMissing}}
	_, server := newTestHandler(t, durable)
	first, opened := postJSON(t, server, "/launch", map[string]any{
		"sessionKey": "reuse-key", "file": "/bin/sh", "args": []string{"-c", "exec /bin/sh"},
	})
	if first.StatusCode != http.StatusOK {
		t.Fatalf("launch = %d %#v", first.StatusCode, opened)
	}
	second, again := postJSON(t, server, "/launch", map[string]any{
		"sessionKey": "reuse-key", "file": "/bin/sh", "args": []string{"-c", "exec /bin/sh"},
	})
	if second.StatusCode != http.StatusOK || again["reused"] != true || again["termId"] != opened["termId"] {
		t.Fatalf("第二次 launch 应复用: %#v", again)
	}
	_, _ = postJSON(t, server, "/close", map[string]any{"sessionKey": "reuse-key"})
}

func TestTmuxSocketIsStableAndKeyed(t *testing.T) {
	first := tmuxSocketForKey("session-a")
	second := tmuxSocketForKey("session-a")
	if first != second {
		t.Fatalf("同一 key 的 socket 必须稳定: %s != %s", first, second)
	}
	if !strings.HasPrefix(first, "aih-web-") || len(first) != len("aih-web-")+32 {
		t.Fatalf("socket 命名 = %s", first)
	}
	if first == tmuxSocketForKey("session-b") {
		t.Fatal("不同 key 不能共用 tmux server")
	}
}

func TestDetachedLauncherFollowsSystemdEnvironment(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}
	if detachedLauncher("darwin", env(map[string]string{"INVOCATION_ID": "x"}), func() int { return 501 }) != nil {
		t.Fatal("非 Linux 不应走 systemd-run")
	}
	if detachedLauncher("linux", env(nil), func() int { return 501 }) != nil {
		t.Fatal("没有 INVOCATION_ID 不应走 systemd-run")
	}
	launcher := detachedLauncher("linux", env(map[string]string{"INVOCATION_ID": "x"}), func() int { return 501 })
	if launcher == nil || launcher.File != "systemd-run" || launcher.RuntimeDir != "/run/user/501" {
		t.Fatalf("launcher = %#v", launcher)
	}
	explicit := detachedLauncher("linux", env(map[string]string{"INVOCATION_ID": "x", "XDG_RUNTIME_DIR": "/tmp/runtime"}), func() int { return 501 })
	if explicit == nil || explicit.RuntimeDir != "/tmp/runtime" {
		t.Fatalf("XDG_RUNTIME_DIR 必须优先: %#v", explicit)
	}
}

func TestTmuxStoreLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 没有 tmux")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skip("tmux 未安装")
	}
	store := NewTmuxStore()
	key := "go-tmux-test-" + time.Now().Format("150405.000000")
	dir := t.TempDir()
	created, err := store.Create(key, DurableSpec{
		File: "/bin/sh", Args: []string{"-c", "printf 'TMUX_OK\\n'; exec /bin/sh"},
		Dir: dir, Env: os.Environ(), Cols: 80, Rows: 24,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if !created.Durable {
		t.Fatalf("Create() = %#v, want durable", created)
	}
	t.Cleanup(func() { _ = store.Close(key) })
	deadline := time.Now().Add(5 * time.Second)
	for store.Probe(key).State != DurableAlive {
		if time.Now().After(deadline) {
			t.Fatalf("tmux 会话没有进入 alive: %#v", store.Probe(key))
		}
		time.Sleep(50 * time.Millisecond)
	}
	file, args := store.AttachCommand(key)
	if file != "tmux" || !containsString(args, "attach-session") {
		t.Fatalf("AttachCommand() = %s %v", file, args)
	}
	if err := store.Close(key); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if store.Probe(key).State != DurableMissing {
		t.Fatalf("Close() 后状态 = %#v", store.Probe(key))
	}
}

func mustDecodeBase64(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	return decoded
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
