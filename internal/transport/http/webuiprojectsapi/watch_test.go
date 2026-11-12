package webuiprojectsapi

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProjectWatchSource 是可控事件源：测试自己决定何时「文件变了」。
type fakeProjectWatchSource struct {
	mu     sync.Mutex
	events chan projectWatchEvent
	added  map[string]projectWatchKind
	closed bool
}

func newFakeProjectWatchSource() *fakeProjectWatchSource {
	return &fakeProjectWatchSource{
		events: make(chan projectWatchEvent, 64),
		added:  make(map[string]projectWatchKind),
	}
}

func (source *fakeProjectWatchSource) Add(kind projectWatchKind, path string) error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return fmt.Errorf("source closed")
	}
	source.added[path] = kind
	return nil
}

func (source *fakeProjectWatchSource) Remove(path string) {
	source.mu.Lock()
	defer source.mu.Unlock()
	delete(source.added, path)
}

func (source *fakeProjectWatchSource) Events() <-chan projectWatchEvent {
	return source.events
}

func (source *fakeProjectWatchSource) Close() error {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return nil
	}
	source.closed = true
	close(source.events)
	return nil
}

func (source *fakeProjectWatchSource) emit(kind projectWatchKind, path string) bool {
	source.mu.Lock()
	defer source.mu.Unlock()
	if source.closed {
		return false
	}
	select {
	case source.events <- projectWatchEvent{kind: kind, path: path}:
		return true
	default:
		return false
	}
}

func (source *fakeProjectWatchSource) isClosed() bool {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.closed
}

func (source *fakeProjectWatchSource) watched(path string) (projectWatchKind, bool) {
	source.mu.Lock()
	defer source.mu.Unlock()
	kind, exists := source.added[path]
	return kind, exists
}

// newWatchTestHandler 装配一个使用假事件源的 Handler。
func newWatchTestHandler(t *testing.T, hostHome string) (*Handler, *fakeProjectWatchSource) {
	t.Helper()
	source := newFakeProjectWatchSource()
	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.AiHomeDir = filepath.Join(hostHome, ".ai_home")
	})
	handler.watchSourceFactory = func() (projectWatchSource, error) { return source, nil }
	handler.watchCoalesce = 20 * time.Millisecond
	t.Cleanup(handler.shutdownWatch)
	return handler, source
}

// openProjectWatch 发起 SSE 连接，并把每个 data 帧送进 channel。
func openProjectWatch(t *testing.T, baseURL string) (*http.Response, <-chan string) {
	t.Helper()
	response, err := http.Get(baseURL + WatchPath)
	if err != nil {
		t.Fatalf("打开 watch 失败: %v", err)
	}
	if response.StatusCode != http.StatusOK {
		_ = response.Body.Close()
		t.Fatalf("watch 状态码 = %d, 期望 200", response.StatusCode)
	}
	frames := make(chan string, 32)
	go func() {
		defer close(frames)
		reader := bufio.NewReader(response.Body)
		for {
			line, readErr := reader.ReadString('\n')
			if readErr != nil {
				return
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			select {
			case frames <- strings.TrimPrefix(line, "data: "):
			default:
			}
		}
	}()
	t.Cleanup(func() { _ = response.Body.Close() })
	return response, frames
}

func waitForWatchFrame(t *testing.T, frames <-chan string, timeout time.Duration, match func(string) bool) string {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatalf("SSE 流提前结束，等不到匹配帧")
			}
			if match(frame) {
				return frame
			}
		case <-deadline:
			t.Fatalf("%s 内没有等到匹配的 SSE 帧", timeout)
		}
	}
}

type snapshotFrameView struct {
	Type      string        `json:"type"`
	Revision  int64         `json:"revision"`
	UpdatedAt int64         `json:"updatedAt"`
	Projects  []projectView `json:"projects"`
}

type runtimeFrameView struct {
	Type               string   `json:"type"`
	RunningSessionKeys []string `json:"runningSessionKeys"`
}

func decodeWatchFrame[T any](t *testing.T, frame string) T {
	t.Helper()
	var value T
	if err := json.Unmarshal([]byte(frame), &value); err != nil {
		t.Fatalf("SSE 帧不是合法 JSON: %v, frame=%s", err, frame)
	}
	return value
}

func writeRuntimeState(t *testing.T, aiHome, name, provider, sessionID, dirName, turnState string, at time.Time, eventType string) {
	t.Helper()
	stateDir := filepath.Join(aiHome, "run", "provider-session-state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("创建运行态目录失败: %v", err)
	}
	payload := map[string]any{
		"version": 1,
		"session": map[string]any{
			"provider":       provider,
			"sessionId":      sessionID,
			"projectPath":    "/tmp/project",
			"projectDirName": dirName,
		},
		"revision":    0,
		"lastEventAt": at.UnixMilli(),
		"turnState":   turnState,
		"lastEvent": map[string]any{
			"type": eventType,
			"at":   at.UnixMilli(),
		},
	}
	content, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化运行态失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, name+".json"), append(content, '\n'), 0o600); err != nil {
		t.Fatalf("写入运行态失败: %v", err)
	}
}

// TestProjectWatchStreamsSnapshotAndRuntime 覆盖真实 SSE 语义：
// connected → runtime → snapshot，文件事件后 revision 递增。
func TestProjectWatchStreamsSnapshotAndRuntime(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	projectDir := filepath.Join(hostHome, "work", "alpha")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	base := time.Now().Add(-time.Minute)
	writeClaudeSession(t, hostHome, "claude-watch", "session-1", projectDir, "第一个会话", base)
	writeRuntimeState(t, aiHome, "state-1", "claude", "session-1", "claude-watch", "working", time.Now(), "turn-started")

	handler, source := newWatchTestHandler(t, hostHome)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	streamResponse, frames := openProjectWatch(t, server.URL)

	connected := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"connected"`)
	})
	if connected != `{"type":"connected"}` {
		t.Fatalf("connected 帧 = %q", connected)
	}

	runtimeFrame := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"runtime"`) && strings.Contains(frame, `"claude:session-1:claude-watch"`)
	})
	runtimeEvent := decodeWatchFrame[runtimeFrameView](t, runtimeFrame)
	if len(runtimeEvent.RunningSessionKeys) != 1 || runtimeEvent.RunningSessionKeys[0] != "claude:session-1:claude-watch" {
		t.Fatalf("运行态 key = %#v", runtimeEvent.RunningSessionKeys)
	}

	snapshotFrame := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"snapshot"`)
	})
	snapshot := decodeWatchFrame[snapshotFrameView](t, snapshotFrame)
	if snapshot.Revision != 1 {
		t.Fatalf("首帧 revision = %d, 期望 1", snapshot.Revision)
	}
	if len(snapshot.Projects) != 1 || snapshot.Projects[0].Path != projectDir {
		t.Fatalf("快照项目 = %#v", snapshot.Projects)
	}
	if snapshot.Projects[0].SessionTotal != 1 || len(snapshot.Projects[0].Sessions) != 1 {
		t.Fatalf("首帧会话数 = %d/%d", snapshot.Projects[0].SessionTotal, len(snapshot.Projects[0].Sessions))
	}

	// 新会话文件出现 → 事件源发通知 → 新快照 revision 必须递增。
	writeClaudeSession(t, hostHome, "claude-watch", "session-2", projectDir, "第二个会话", base.Add(30*time.Second))
	if !source.emit(projectWatchKindProjects, filepath.Join(hostHome, ".claude", "projects", "claude-watch")) {
		t.Fatalf("事件源已关闭，无法模拟文件变化")
	}
	updatedFrame := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		if !strings.Contains(frame, `"type":"snapshot"`) {
			return false
		}
		value := decodeWatchFrame[snapshotFrameView](t, frame)
		return value.Revision >= 2 && len(value.Projects) == 1 && value.Projects[0].SessionTotal == 2
	})
	updated := decodeWatchFrame[snapshotFrameView](t, updatedFrame)
	if updated.Revision < 2 {
		t.Fatalf("事件后 revision = %d, 期望 >= 2", updated.Revision)
	}

	// 显式 snapshot：即使内容没变也必须广播当前快照。
	response, err := http.Post(server.URL+SnapshotPath, "application/json", nil)
	if err != nil {
		t.Fatalf("POST snapshot 失败: %v", err)
	}
	var accepted struct {
		OK          bool  `json:"ok"`
		Accepted    bool  `json:"accepted"`
		Broadcasted bool  `json:"broadcasted"`
		RequestedAt int64 `json:"requestedAt"`
	}
	if err := json.NewDecoder(response.Body).Decode(&accepted); err != nil {
		t.Fatalf("snapshot 响应不是 JSON: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusAccepted || !accepted.OK || !accepted.Accepted || !accepted.Broadcasted || accepted.RequestedAt <= 0 {
		t.Fatalf("snapshot 响应 = %d %#v", response.StatusCode, accepted)
	}
	waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"snapshot"`)
	})

	// 最后一路订阅断开后 watcher 必须释放，不能在后台空转。
	_ = streamResponse.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for !source.isClosed() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !source.isClosed() {
		t.Fatalf("最后一路 SSE 断开后事件源没有关闭")
	}
}

// TestProjectWatchRealFilesystemEventUpdatesSnapshot 不使用假事件源：
// 真机创建会话文件后，fsnotify 事件必须驱动出新 revision 的快照。
func TestProjectWatchRealFilesystemEventUpdatesSnapshot(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, "work", "real")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	base := time.Now().Add(-time.Minute)
	writeClaudeSession(t, hostHome, "claude-real", "session-1", projectDir, "真实会话一", base)

	handler := newTestHandler(t, hostHome, true)
	handler.watchCoalesce = 20 * time.Millisecond
	t.Cleanup(handler.shutdownWatch)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	_, frames := openProjectWatch(t, server.URL)
	first := decodeWatchFrame[snapshotFrameView](t, waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"snapshot"`)
	}))
	if first.Revision != 1 || first.Projects[0].SessionTotal != 1 {
		t.Fatalf("首帧 = rev %d total %d", first.Revision, first.Projects[0].SessionTotal)
	}

	writeClaudeSession(t, hostHome, "claude-real", "session-2", projectDir, "真实会话二", base.Add(30*time.Second))
	waitForWatchFrame(t, frames, 10*time.Second, func(frame string) bool {
		if !strings.Contains(frame, `"type":"snapshot"`) {
			return false
		}
		value := decodeWatchFrame[snapshotFrameView](t, frame)
		return value.Revision >= 2 && len(value.Projects) == 1 && value.Projects[0].SessionTotal == 2
	})
}

// TestProjectWatchFrameShapeMatchesNode 固定 Node 的帧形状与键序。
func TestProjectWatchFrameShapeMatchesNode(t *testing.T) {
	hostHome := t.TempDir()
	projectDir := filepath.Join(hostHome, "work", "shape")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("创建项目目录失败: %v", err)
	}
	writeClaudeSession(t, hostHome, "claude-shape", "session-shape", projectDir, "形状会话", time.Now())

	handler, _ := newWatchTestHandler(t, hostHome)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	_, frames := openProjectWatch(t, server.URL)
	// 先等 runtime 再等 snapshot：waitForWatchFrame 会丢弃不匹配的帧。
	runtimeFrame := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"runtime"`)
	})
	snapshotFrame := waitForWatchFrame(t, frames, 5*time.Second, func(frame string) bool {
		return strings.Contains(frame, `"type":"snapshot"`)
	})

	if keys := topLevelJSONKeys(t, snapshotFrame); strings.Join(keys, ",") != "type,revision,updatedAt,projects" {
		t.Fatalf("snapshot 键序 = %v", keys)
	}
	var envelope struct {
		Projects []json.RawMessage `json:"projects"`
	}
	if err := json.Unmarshal([]byte(snapshotFrame), &envelope); err != nil || len(envelope.Projects) != 1 {
		t.Fatalf("snapshot projects 解析失败: %v", err)
	}
	if keys := topLevelJSONKeys(t, string(envelope.Projects[0])); strings.Join(keys, ",") != "id,name,path,providers,sessions,sessionTotal" {
		t.Fatalf("project 键序 = %v", keys)
	}
	var project struct {
		Sessions []json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal(envelope.Projects[0], &project); err != nil || len(project.Sessions) != 1 {
		t.Fatalf("project sessions 解析失败: %v", err)
	}
	if keys := topLevelJSONKeys(t, string(project.Sessions[0])); strings.Join(keys, ",") != "id,title,updatedAt,provider,projectDirName,projectPath" {
		t.Fatalf("session 键序 = %v", keys)
	}

	// runtime 帧即使没有运行中会话也必须下发 []（不能是 null）。
	runtime := decodeWatchFrame[runtimeFrameView](t, runtimeFrame)
	if runtime.RunningSessionKeys == nil {
		t.Fatalf("runningSessionKeys 不能是 null")
	}
	if keys := topLevelJSONKeys(t, runtimeFrame); strings.Join(keys, ",") != "type,runningSessionKeys" {
		t.Fatalf("runtime 键序 = %v", keys)
	}
}

func topLevelJSONKeys(t *testing.T, raw string) []string {
	t.Helper()
	decoder := json.NewDecoder(strings.NewReader(raw))
	keys := make([]string, 0, 6)
	depth := 0
	expectKey := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("解析 JSON 键序失败: %v, raw=%s", err, raw)
		}
		switch value := token.(type) {
		case json.Delim:
			switch value {
			case '{':
				depth++
				if depth == 1 {
					expectKey = true
				}
			case '[':
				depth++
				if depth == 1 {
					expectKey = false
				}
			case '}', ']':
				depth--
				if depth == 1 {
					expectKey = true
				}
			}
		case string:
			if depth == 1 {
				if expectKey {
					keys = append(keys, value)
					expectKey = false
				} else {
					expectKey = true
				}
			}
		default:
			if depth == 1 {
				expectKey = true
			}
		}
	}
	return keys
}

func TestReadProjectRuntimeStateFiltersStaleAndFinished(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	writeRuntimeState(t, dir, "working", "Claude", "s-working", "dir-a", "working", now, "turn-started")
	writeRuntimeState(t, dir, "waiting", "codex", "s-waiting", "", "waiting", now.Add(-time.Minute), "question-opened")
	writeRuntimeState(t, dir, "stale", "claude", "s-stale", "dir-b", "working", now.Add(-watchRuntimeStaleAfter-time.Minute), "turn-started")
	writeRuntimeState(t, dir, "finished", "claude", "s-finished", "dir-c", "completed", now, "turn-completed")
	writeRuntimeState(t, dir, "failed", "claude", "s-failed", "dir-d", "failed", now, "turn-failed")
	writeRuntimeState(t, dir, "idle", "claude", "s-idle", "dir-e", "idle", now, "turn-completed")

	keys, latestLifecycleAt := readProjectRuntimeState(filepath.Join(dir, "run", "provider-session-state"), now)
	want := []string{"claude:s-working:dir-a", "codex:s-waiting:"}
	if strings.Join(keys, ",") != strings.Join(want, ",") {
		t.Fatalf("运行态 keys = %#v, 期望 %#v", keys, want)
	}
	if latestLifecycleAt <= 0 {
		t.Fatalf("生命周期时间戳 = %d, 期望 > 0", latestLifecycleAt)
	}
}

func TestCollectWatchTargetsCoversProvidersAndRuntimeState(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := filepath.Join(hostHome, ".ai_home")
	paths := []string{
		filepath.Join(hostHome, ".claude", "projects", "p1"),
		filepath.Join(hostHome, ".codex", "sessions", "2026", "11", "12"),
		filepath.Join(hostHome, ".gemini", "tmp", "g1"),
		filepath.Join(hostHome, ".gemini", "history", "g1"),
		filepath.Join(hostHome, ".local", "share", "opencode"),
		filepath.Join(hostHome, ".cline", "data", "db"),
		filepath.Join(hostHome, ".codebuddy", "projects", "c1"),
		filepath.Join(aiHome, "run", "provider-session-state"),
		filepath.Join(aiHome, "run", "auth-projections", "cline", "acct_test", ".cline", "data", "db"),
	}
	for _, path := range paths {
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatalf("创建目录失败 %s: %v", path, err)
		}
	}
	files := []string{
		filepath.Join(hostHome, ".codex", "state_5.sqlite"),
		filepath.Join(hostHome, ".codex", "state_5.sqlite-wal"),
		filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db"),
		filepath.Join(hostHome, ".cline", "data", "db", "sessions.db"),
		filepath.Join(hostHome, ".codebuddy", "workbuddy.db"),
		filepath.Join(aiHome, "run", "auth-projections", "cline", "acct_test", ".cline", "data", "db", "sessions.db"),
	}
	for _, path := range files {
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatalf("创建文件失败 %s: %v", path, err)
		}
	}
	shm := filepath.Join(hostHome, ".local", "share", "opencode", "opencode.db-shm")
	if err := os.WriteFile(shm, []byte("x"), 0o644); err != nil {
		t.Fatalf("创建 -shm 失败: %v", err)
	}

	handler := newTestHandler(t, hostHome, true, func(dependencies *Dependencies) {
		dependencies.AiHomeDir = aiHome
	})
	targets := handler.collectWatchTargets()

	mustContain := append(append([]string{}, paths...), files...)
	for _, path := range mustContain {
		if _, exists := targets[path]; !exists {
			t.Fatalf("监听目标缺少 %s", path)
		}
	}
	if kind := targets[filepath.Join(aiHome, "run", "provider-session-state")]; kind != projectWatchKindRuntime {
		t.Fatalf("运行态目录 kind = %d", kind)
	}
	if _, exists := targets[shm]; exists {
		t.Fatalf("-shm 不应成为监听目标")
	}
}

func TestFsnotifyProjectWatchSourceEmitsChange(t *testing.T) {
	source, err := newFsnotifyProjectWatchSource()
	if err != nil {
		t.Skipf("当前环境不支持 fsnotify: %v", err)
	}
	defer func() { _ = source.Close() }()
	dir := t.TempDir()
	if err := source.Add(projectWatchKindProjects, dir); err != nil {
		t.Skipf("当前环境无法监听目录: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session.jsonl"), []byte("{}\n"), 0o644); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
	select {
	case event := <-source.Events():
		if event.kind != projectWatchKindProjects {
			t.Fatalf("事件 kind = %d", event.kind)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("fsnotify 5s 内没有送出目录变化事件")
	}
}

func TestProjectWatchRequiresAuthorizationAndMethod(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), false)
	for _, testCase := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, WatchPath},
		{http.MethodPost, SnapshotPath},
	} {
		request := httptest.NewRequest(testCase.method, testCase.path, nil)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s 状态码 = %d, 期望 401", testCase.method, testCase.path, recorder.Code)
		}
	}

	allowed := newTestHandler(t, t.TempDir(), true)
	request := httptest.NewRequest(http.MethodPost, WatchPath, nil)
	recorder := httptest.NewRecorder()
	allowed.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST watch 状态码 = %d, 期望 405", recorder.Code)
	}
}

func TestIsSQLiteSharedMemoryPath(t *testing.T) {
	if !isSQLiteSharedMemoryPath("/tmp/x.db-shm") || !isSQLiteSharedMemoryPath("/tmp/x.DB-SHM") {
		t.Fatalf("-shm 识别失败")
	}
	if isSQLiteSharedMemoryPath("/tmp/x.db-wal") || isSQLiteSharedMemoryPath("/tmp/x.db") {
		t.Fatalf("非 -shm 被误判")
	}
}
