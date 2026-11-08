//go:build !windows

package terminalsession

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pty"
)

// TestServiceRealPTYLifecycle 用真实 PTY 走一遍创建、resize、写入、自然退出与退出后回放。
func TestServiceRealPTYLifecycle(t *testing.T) {
	if !pty.Available() {
		t.Skip("当前平台没有可用 PTY")
	}
	service := NewService(pty.NewStarter(), Options{IdleTimeout: time.Minute})
	defer service.Shutdown()

	created, err := service.Create(context.Background(), Spec{
		Key:  "real-pty",
		Path: "/bin/sh",
		Args: []string{"-c", "printf 'ready\\n'; read line; printf 'got:%s\\n' \"$line\""},
		Dir:  t.TempDir(),
		Size: pty.Size{Rows: 24, Cols: 80},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if created.Status != StatusRunning || created.Cols != 80 || created.Rows != 24 {
		t.Fatalf("created = %#v", created)
	}

	resized, err := service.Resize(created.ID, pty.Size{Rows: 30, Cols: 100})
	if err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	if resized.Cols != 100 || resized.Rows != 30 {
		t.Fatalf("resized = %#v", resized)
	}

	subscription, err := service.Subscribe(created.ID, 64)
	if err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}
	defer subscription.Close()

	if output := readUntil(t, subscription, "ready"); !strings.Contains(output, "ready") {
		t.Fatalf("初始输出 = %q", output)
	}
	if err := service.Write(created.ID, []byte("hello\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	readUntil(t, subscription, "got:hello")

	frames := collectFrames(t, subscription)
	if !containsExit(frames, 0) {
		t.Fatalf("缺少退出帧: %#v", frames)
	}

	// 退出后仍保留回放窗口：重连应先拿到完整缓冲，再拿到退出帧。
	reconnected, err := service.Subscribe(created.Key, 64)
	if err != nil {
		t.Fatalf("退出后 Subscribe() error = %v", err)
	}
	defer reconnected.Close()
	replayFrames := collectFrames(t, reconnected)
	output := joinOutput(replayFrames)
	if !strings.Contains(output, "ready") || !strings.Contains(output, "got:hello") {
		t.Fatalf("回放输出 = %q", output)
	}
	if !containsExit(replayFrames, 0) {
		t.Fatalf("回放缺少退出帧: %#v", replayFrames)
	}
}

// TestServiceRealPTYKill 验证服务 Kill 真的结束宿主进程并移除会话。
func TestServiceRealPTYKill(t *testing.T) {
	if !pty.Available() {
		t.Skip("当前平台没有可用 PTY")
	}
	service := NewService(pty.NewStarter(), Options{})
	defer service.Shutdown()

	created, err := service.Create(context.Background(), Spec{
		Path: "/bin/cat",
		Dir:  t.TempDir(),
		Size: pty.Size{Rows: 24, Cols: 80},
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := service.Kill(created.ID); err != nil {
		t.Fatalf("Kill() error = %v", err)
	}
	if _, err := service.Attach(created.ID); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("Kill 后 Attach() error = %v", err)
	}
}

func joinOutput(frames []Frame) string {
	var output strings.Builder
	for _, frame := range frames {
		if frame.Type == FrameOutput {
			output.Write(frame.Data)
		}
	}
	return output.String()
}
