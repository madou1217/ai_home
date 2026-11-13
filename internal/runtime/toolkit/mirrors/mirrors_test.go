package mirrors

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

type fakeExecutor struct {
	mu    sync.Mutex
	calls []string
	fn    func(command string, args []string) environment.RunResult
}

func (fake *fakeExecutor) Run(_ context.Context, command string, args []string, _ environment.ExecOptions) environment.RunResult {
	fake.mu.Lock()
	fake.calls = append(fake.calls, command+" "+strings.Join(args, " "))
	fake.mu.Unlock()
	return fake.fn(command, args)
}

func intPtr(v int) *int { return &v }

func TestGetStatusAndCacheSWR(t *testing.T) {
	var npmReads atomic.Int32
	var nowSec atomic.Int64
	nowSec.Store(1000)
	exec := &fakeExecutor{
		fn: func(command string, args []string) environment.RunResult {
			switch command {
			case "npm":
				npmReads.Add(1)
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "https://registry.npmmirror.com/\n"}
			case "pip":
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "https://pypi.tuna.tsinghua.edu.cn/simple\n"}
			default:
				return environment.RunResult{OK: false}
			}
		},
	}

	mgr := NewManager(Options{
		Platform: "darwin",
		Exec:     exec,
		Now:      func() time.Time { return time.Unix(nowSec.Load(), 0) },
	})

	first := mgr.GetStatus(context.Background(), false)
	if !first.OK || first.Platform != "macos" {
		t.Fatalf("unexpected status: %+v", first)
	}
	if first.NPM == nil || first.NPM.Current != "https://registry.npmmirror.com" {
		t.Fatalf("expected trimmed npm registry, got %+v", first.NPM)
	}
	if !first.NPM.Presets[0].Active || first.NPM.Presets[0].Guides == nil {
		t.Fatalf("expected active npmmirror preset with materialized guides")
	}
	if first.PIP == nil || !first.PIP.Presets[0].Active {
		t.Fatalf("expected tuna pip preset active, got %+v", first.PIP)
	}

	second := mgr.GetStatus(context.Background(), false)
	if second.Stale || npmReads.Load() != 1 {
		t.Fatalf("expected fresh cache hit, stale=%v reads=%d", second.Stale, npmReads.Load())
	}

	nowSec.Add(16)
	staleResp := mgr.GetStatus(context.Background(), false)
	if !staleResp.Stale {
		t.Fatalf("expected stale=true after TTL expiry")
	}
}

func TestSetMirrorValidationAndPip3Fallback(t *testing.T) {
	exec := &fakeExecutor{
		fn: func(command string, args []string) environment.RunResult {
			if command == "pip" && len(args) > 0 && args[0] == "config" && args[1] == "set" {
				return environment.RunResult{OK: false, ExitCode: intPtr(127), Stderr: "pip: command not found"}
			}
			if command == "pip3" && len(args) > 1 && args[1] == "set" {
				return environment.RunResult{OK: true, ExitCode: intPtr(0)}
			}
			if command == "pip3" && len(args) > 1 && args[1] == "get" {
				return environment.RunResult{OK: true, ExitCode: intPtr(0), Stdout: "https://pypi.org/simple\n"}
			}
			return environment.RunResult{OK: false, ExitCode: intPtr(1), Stderr: "unexpected command"}
		},
	}

	mgr := NewManager(Options{Platform: "linux", Exec: exec})

	badType := mgr.SetMirror(context.Background(), "cargo", "https://example.com")
	if badType.Error != "unsupported_mirror_type" {
		t.Fatalf("expected unsupported_mirror_type, got %+v", badType)
	}

	badURL := mgr.SetMirror(context.Background(), "npm", "ftp://registry.npmjs.org")
	if badURL.Error != "invalid_url" {
		t.Fatalf("expected invalid_url, got %+v", badURL)
	}

	pipRes := mgr.SetMirror(context.Background(), "pip", "https://pypi.org/simple")
	if !pipRes.OK || pipRes.IndexURL != "https://pypi.org/simple" {
		t.Fatalf("expected pip3 fallback success, got %+v", pipRes)
	}
}

func TestPingInvalidURLAndSSRFBlocking(t *testing.T) {
	mgr := NewManager(Options{
		ResolveHost: func(_ context.Context, host string) ([]string, error) {
			if host == "internal.test" {
				return []string{"127.0.0.1"}, nil
			}
			return []string{"93.184.216.34"}, nil
		},
	})

	invalid := mgr.Ping(context.Background(), "javascript:alert(1)")
	if invalid.Error == nil || *invalid.Error != "invalid_url" || invalid.LatencyMs != -1 {
		t.Fatalf("expected invalid_url, got %+v", invalid)
	}

	blocked := mgr.Ping(context.Background(), "https://internal.test/")
	if blocked.OK || blocked.Error == nil || !strings.Contains(*blocked.Error, "blocked") {
		t.Fatalf("expected SSRF block, got %+v", blocked)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			t.Fatalf("expected HEAD, got %s", r.Method)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	mgrDirect := NewManager(Options{
		RequestAdapter: func(ctx context.Context, targetURL string, _ time.Duration) (int, error) {
			req, _ := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return 0, err
			}
			_ = resp.Body.Close()
			return resp.StatusCode, nil
		},
	})
	okRes := mgrDirect.Ping(context.Background(), srv.URL)
	if !okRes.OK || okRes.StatusCode == nil || *okRes.StatusCode != 200 || okRes.Error != nil {
		t.Fatalf("expected ping 200 OK, got %+v", okRes)
	}
}
