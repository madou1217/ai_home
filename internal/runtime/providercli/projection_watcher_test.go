package providercli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codebuddyfamilystorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codebuddyfamily"
)

type recordingProjection struct {
	mu        sync.Mutex
	paths     []string
	captures  int
	failFirst int
	mismatch  bool
}

func (projection *recordingProjection) Prepare(context.Context, appprojection.Request) (appprojection.Result, error) {
	return appprojection.Result{}, nil
}

func (projection *recordingProjection) Capture(context.Context, appprojection.Request, appprojection.Result) error {
	projection.mu.Lock()
	projection.captures++
	attempt := projection.captures
	fail := attempt <= projection.failFirst
	mismatch := projection.mismatch
	projection.mu.Unlock()
	if mismatch {
		return codebuddyfamilystorage.ErrIdentityMismatch
	}
	if fail {
		return errors.New("transient capture failure")
	}
	return nil
}

func (projection *recordingProjection) Remove(context.Context, string, accountcore.AccountRef) error {
	return nil
}

func (projection *recordingProjection) CredentialPaths(context.Context, appprojection.Request, appprojection.Result) []string {
	return projection.paths
}

func (projection *recordingProjection) count() int {
	projection.mu.Lock()
	defer projection.mu.Unlock()
	return projection.captures
}

func TestProjectionWatcherCapturesCodeBuddyLiveChange(t *testing.T) {
	root := t.TempDir()
	path := familyCredentialPath(root, "Tencent-Cloud.coding-copilot.info")
	writeCredentialAt(t, path, "one")
	projection := &recordingProjection{paths: []string{path}}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "codebuddycn"),
		appprojection.Result{Root: root},
	)
	defer stop()

	// 启动时已存在的文件是基线，不能被当成新变化回写。
	time.Sleep(60 * time.Millisecond)
	if got := projection.count(); got != 0 {
		t.Fatalf("baseline capture = %d, want 0", got)
	}
	writeCredentialAt(t, path, "two-new-token")
	waitForCaptures(t, projection, 1)

	// stop 之后不能再有任何采集。
	stop()
	settled := projection.count()
	writeCredentialAt(t, path, "three-after-stop")
	time.Sleep(80 * time.Millisecond)
	if got := projection.count(); got != settled {
		t.Fatalf("capture after stop: %d -> %d", settled, got)
	}
}

func TestProjectionWatcherCapturesCodexLiveChange(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".codex", "auth.json")
	writeCredentialAt(t, path, `{"tokens":{"access_token":"one"}}`)
	projection := &recordingProjection{paths: []string{path}}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "codex"),
		appprojection.Result{Root: root},
	)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	writeCredentialAt(t, path, `{"tokens":{"access_token":"two-rotated"}}`)
	waitForCaptures(t, projection, 1)
}

func TestProjectionWatcherCapturesMultipleArtifacts(t *testing.T) {
	root := t.TempDir()
	pathA := filepath.Join(root, ".gemini", "oauth_creds.json")
	pathB := filepath.Join(root, ".gemini", "google_accounts.json")
	writeCredentialAt(t, pathA, "a1")
	writeCredentialAt(t, pathB, "b1")
	projection := &recordingProjection{paths: []string{pathA, pathB}}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "gemini"),
		appprojection.Result{Root: root},
	)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	writeCredentialAt(t, pathB, "b2-rotated")
	waitForCaptures(t, projection, 1)
}

func TestProjectionWatcherRetriesTransientCaptureFailure(t *testing.T) {
	root := t.TempDir()
	path := familyCredentialPath(root, "Tencent-Cloud.coding-copilot.info")
	writeCredentialAt(t, path, "one")
	projection := &recordingProjection{paths: []string{path}, failFirst: 1}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "codebuddycn"),
		appprojection.Result{Root: root},
	)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	writeCredentialAt(t, path, "two")
	waitForCaptures(t, projection, 2)
}

func TestProjectionWatcherStopsAfterIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	path := familyCredentialPath(root, "Tencent-Cloud.coding-copilot.info")
	writeCredentialAt(t, path, "one")
	projection := &recordingProjection{paths: []string{path}, mismatch: true}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "codebuddycn"),
		appprojection.Result{Root: root},
	)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	writeCredentialAt(t, path, "two")
	waitForCaptures(t, projection, 1)
	// 文件系统时间戳可能在边界上多触发一次；关键是身份不匹配后不能持续重试。
	time.Sleep(80 * time.Millisecond)
	settled := projection.count()
	time.Sleep(120 * time.Millisecond)
	if got := projection.count(); got != settled {
		t.Fatalf("identity mismatch kept retrying: %d -> %d", settled, got)
	}
	if settled > 2 {
		t.Fatalf("identity mismatch capture = %d, want <= 2", settled)
	}
}

func TestProjectionWatcherSkipsProviderWithoutCredentialPaths(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".codex", "auth.json")
	writeCredentialAt(t, path, "one")
	projection := &recordingProjection{}
	runner := watcherRunner(projection)
	stop := runner.startProjectionCaptureWatcher(
		context.Background(),
		projectionRequest(t, "codex"),
		appprojection.Result{Root: root},
	)
	defer stop()

	time.Sleep(60 * time.Millisecond)
	writeCredentialAt(t, path, "two")
	time.Sleep(120 * time.Millisecond)
	if got := projection.count(); got != 0 {
		t.Fatalf("capture without paths = %d, want 0", got)
	}
}

func watcherRunner(projection *recordingProjection) *Runner {
	return &Runner{
		projection:                projection,
		projectionCaptureInterval: 20 * time.Millisecond,
	}
}

func projectionRequest(t *testing.T, providerID string) appprojection.Request {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	return appprojection.Request{
		ProviderID:         providerID,
		AccountRef:         accountRef,
		Purpose:            appprojection.PurposeLaunch,
		ProjectionRequired: true,
	}
}

func familyCredentialPath(root string, name string) string {
	directory := filepath.Join(append([]string{root}, codebuddyfamilystorage.AuthDirSegments(runtime.GOOS)...)...)
	return filepath.Join(directory, name)
}

func writeCredentialAt(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func waitForCaptures(t *testing.T, projection *recordingProjection, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if projection.count() >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("captures = %d, want >= %d", projection.count(), want)
}
