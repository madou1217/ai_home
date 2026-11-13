package aihloginjob

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/host/aihlogin"
)

func waitStatus(t *testing.T, manager *Manager, id string, want Status) Snapshot {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, ok := manager.Get(id)
		if ok && snapshot.Status == want {
			return snapshot
		}
		time.Sleep(5 * time.Millisecond)
	}
	snapshot, _ := manager.Get(id)
	t.Fatalf("status = %s, want %s (snapshot=%#v)", snapshot.Status, want, snapshot)
	return Snapshot{}
}

// TestJobSucceedsAndExtractsURL 日志里的授权链接被提取，成功后带回账号。
func TestJobSucceedsAndExtractsURL(t *testing.T) {
	manager := NewManager(Options{
		Run: func(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
			_, _ = io.WriteString(options.Stdout, "open https://www.codebuddy.ai/login?platform=CLI&state=abc\n")
			return accountcore.Account{}, nil
		},
	})
	snapshot, err := manager.Start(context.Background(), "codebuddycn")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	done := waitStatus(t, manager, snapshot.ID, StatusSucceeded)
	if done.AuthURL != "https://www.codebuddy.ai/login?platform=CLI&state=abc" {
		t.Fatalf("authURL = %q", done.AuthURL)
	}
	if !strings.Contains(done.Logs, "state=abc") {
		t.Fatalf("logs = %q", done.Logs)
	}
}

// TestSiteMenuAnsweredByProvider 国内站直接回车，国际站下移 + 回车。
func TestSiteMenuAnsweredByProvider(t *testing.T) {
	cases := map[string]string{
		"codebuddycn": "\r",
		"codebuddy":   "\x1b[B\r",
	}
	for provider, want := range cases {
		received := make(chan string, 1)
		manager := NewManager(Options{
			SiteMenuDownDelay: 10 * time.Millisecond,
			Run: func(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
				_, _ = io.WriteString(options.Stdout, "Select login method:\n1) Chinese\n2) International\n")
				buffer := make([]byte, 0, 8)
				deadline := time.Now().Add(time.Second)
				for time.Now().Before(deadline) {
					one := make([]byte, 1)
					if _, err := options.Stdin.Read(one); err != nil {
						break
					}
					buffer = append(buffer, one...)
					if one[0] == '\r' {
						break
					}
				}
				received <- string(buffer)
				return accountcore.Account{}, nil
			},
		})
		snapshot, err := manager.Start(context.Background(), provider)
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		waitStatus(t, manager, snapshot.ID, StatusSucceeded)
		select {
		case got := <-received:
			if got != want {
				t.Fatalf("%s menu keys = %q, want %q", provider, got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s 没有收到菜单按键", provider)
		}
	}
}

// TestCancelMarksCancelled 取消运行中的作业后状态为 cancelled。
func TestCancelMarksCancelled(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	manager := NewManager(Options{
		Run: func(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
			once.Do(func() { close(started) })
			<-ctx.Done()
			return accountcore.Account{}, ctx.Err()
		},
	})
	snapshot, err := manager.Start(context.Background(), "codebuddycn")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	<-started
	if !manager.Cancel(snapshot.ID) {
		t.Fatal("cancel 失败")
	}
	waitStatus(t, manager, snapshot.ID, StatusCancelled)
}

// TestFailureCarriesError 运行失败时保留错误文本。
func TestFailureCarriesError(t *testing.T) {
	manager := NewManager(Options{
		Run: func(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
			return accountcore.Account{}, ErrInvalidRequest
		},
	})
	snapshot, _ := manager.Start(context.Background(), "codebuddycn")
	done := waitStatus(t, manager, snapshot.ID, StatusFailed)
	if !strings.Contains(done.Error, "invalid login job request") {
		t.Fatalf("error = %q", done.Error)
	}
}

// TestJobOutlivesRequestContext 请求上下文取消不应终止作业，只有 Cancel 能终止。
func TestJobOutlivesRequestContext(t *testing.T) {
	started := make(chan struct{})
	var once sync.Once
	manager := NewManager(Options{
		Run: func(ctx context.Context, options aihlogin.Options) (accountcore.Account, error) {
			once.Do(func() { close(started) })
			<-ctx.Done()
			return accountcore.Account{}, ctx.Err()
		},
	})
	requestCtx, cancelRequest := context.WithCancel(context.Background())
	snapshot, err := manager.Start(requestCtx, "codebuddycn")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	<-started
	cancelRequest()
	time.Sleep(100 * time.Millisecond)
	if current, _ := manager.Get(snapshot.ID); current.Status != StatusRunning {
		t.Fatalf("请求取消后作业状态 = %s", current.Status)
	}
	manager.Cancel(snapshot.ID)
	waitStatus(t, manager, snapshot.ID, StatusCancelled)
}
