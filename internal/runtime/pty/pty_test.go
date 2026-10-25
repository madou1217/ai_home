package pty

import (
	"context"
	"io"
	"strings"
	"testing"
	"time"
)

func TestUnixStarterRunsInteractiveCommandAndSupportsResize(t *testing.T) {
	if !Available() {
		t.Skip("PTY unavailable on this platform")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	session, err := NewStarter().Start(ctx, Spec{
		Path: "/bin/sh",
		Args: []string{"-c", "printf ready; read value; printf '\\nreceived:%s\\n' \"$value\""},
		Size: Size{Rows: 24, Cols: 80},
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer session.Close()
	if err := session.Resize(Size{Rows: 30, Cols: 100}); err != nil {
		t.Fatalf("Resize() error = %v", err)
	}
	if _, err := session.Write([]byte("hello\n")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	payload, err := io.ReadAll(session)
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "input/output error") {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if !strings.Contains(string(payload), "ready") || !strings.Contains(string(payload), "received:hello") {
		t.Fatalf("payload = %q", payload)
	}
	if err := session.Wait(); err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
}
