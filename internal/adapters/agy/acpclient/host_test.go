package acpclient

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLocalWorkspaceHostFileConfinement(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalWorkspaceHost(root)
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	target := filepath.Join(root, "notes", "a.txt")
	if err := host.WriteTextFile(context.Background(), target, "hello\nworld"); err != nil {
		t.Fatalf("WriteTextFile() error = %v", err)
	}
	got, err := host.ReadTextFile(context.Background(), target, nil, nil)
	if err != nil || got != "hello\nworld" {
		t.Fatalf("ReadTextFile() = %q, %v", got, err)
	}
	line := int64(2)
	got, err = host.ReadTextFile(context.Background(), target, &line, nil)
	if err != nil || got != "world" {
		t.Fatalf("ReadTextFile(line) = %q, %v", got, err)
	}
	if err := host.WriteTextFile(context.Background(), filepath.Join(root, "..", "escape.txt"), "x"); !errors.Is(err, ErrPathOutsideWorkspace) {
		t.Fatalf("outside write error = %v, want ErrPathOutsideWorkspace", err)
	}
}

func TestLocalWorkspaceHostRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	host, err := NewLocalWorkspaceHost(root)
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	link := filepath.Join(root, "outside")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink not supported: %v", err)
	}
	if err := host.WriteTextFile(context.Background(), filepath.Join(link, "x.txt"), "x"); !errors.Is(err, ErrPathOutsideWorkspace) {
		t.Fatalf("symlink write error = %v, want ErrPathOutsideWorkspace", err)
	}
}

func TestLocalWorkspaceHostTerminal(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalWorkspaceHost(root)
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	id, err := host.Create(context.Background(), TerminalSpec{
		Command: "/bin/sh",
		Args:    []string{"-c", "printf 'hello'"},
		Cwd:     root,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exit, err := host.Wait(waitCtx, id)
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Fatalf("exit = %+v, want code 0", exit)
	}
	output, err := host.Output(context.Background(), id)
	if err != nil {
		t.Fatalf("Output() error = %v", err)
	}
	if !strings.Contains(output.Output, "hello") {
		t.Fatalf("output = %q, want hello", output.Output)
	}
	if err := host.Release(context.Background(), id); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
}

func TestLocalWorkspaceHostKill(t *testing.T) {
	root := t.TempDir()
	host, err := NewLocalWorkspaceHost(root)
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	id, err := host.Create(context.Background(), TerminalSpec{
		Command: "/bin/sh",
		Args:    []string{"-c", "sleep 30"},
		Cwd:     root,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if err := host.Kill(context.Background(), id); err != nil {
		t.Fatalf("Kill() error = %v", err)
	}
	waitCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exit, err := host.Wait(waitCtx, id)
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if exit.Signal == "" && exit.ExitCode != nil && *exit.ExitCode == 0 {
		t.Fatalf("killed terminal reported success: %+v", exit)
	}
}
