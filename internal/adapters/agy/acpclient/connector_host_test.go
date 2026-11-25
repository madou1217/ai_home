package acpclient

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fakeToolClient struct {
	mu       sync.Mutex
	calls    []toolCall
	watchSeq int
}

type toolCall struct {
	name string
	args map[string]any
}

func (fake *fakeToolClient) Call(_ context.Context, name string, args map[string]any) (ToolResult, error) {
	fake.mu.Lock()
	fake.calls = append(fake.calls, toolCall{name: name, args: args})
	fake.mu.Unlock()
	switch name {
	case "read_file":
		return ToolResult{Text: "version: v1\nlines: 1-2 / 2\n1|hello\n2|world"}, nil
	case "write_file":
		return ToolResult{Text: "已写入 a.txt（version: v2）"}, nil
	case "start_job":
		return ToolResult{Text: "job: job-1\nstate: running\ncwd: .\ncursor: 0:0\n"}, nil
	case "watch_job":
		fake.mu.Lock()
		fake.watchSeq++
		sequence := fake.watchSeq
		fake.mu.Unlock()
		if sequence == 1 {
			return ToolResult{Text: "job: job-1\nstate: running\ncursor: 6:0\nstdout:\nhello\n"}, nil
		}
		return ToolResult{Text: "job: job-1\nstate: exited\ncursor: 6:0\nexit code: 0\n"}, nil
	case "interrupt_job":
		return ToolResult{Text: "job: job-1\nstate: interrupted"}, nil
	default:
		return ToolResult{Text: "unknown tool", IsError: true}, nil
	}
}

func (fake *fakeToolClient) lastCall() toolCall {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return fake.calls[len(fake.calls)-1]
}

func TestConnectorHostReadWriteMapsRelativePaths(t *testing.T) {
	root := t.TempDir()
	client := &fakeToolClient{}
	host, err := NewConnectorHost(root, client)
	if err != nil {
		t.Fatalf("NewConnectorHost() error = %v", err)
	}
	content, err := host.ReadTextFile(context.Background(), filepath.Join(root, "a.txt"), nil, nil)
	if err != nil || content != "hello\nworld" {
		t.Fatalf("ReadTextFile() = %q, %v", content, err)
	}
	if call := client.lastCall(); call.name != "read_file" || call.args["path"] != "a.txt" {
		t.Fatalf("read call = %+v", call)
	}
	if err := host.WriteTextFile(context.Background(), filepath.Join(root, "a.txt"), "next"); err != nil {
		t.Fatalf("WriteTextFile() error = %v", err)
	}
	if call := client.lastCall(); call.name != "write_file" || call.args["expected_version"] != "v1" {
		t.Fatalf("write call = %+v", call)
	}
	if err := host.WriteTextFile(context.Background(), filepath.Join(root, "..", "escape.txt"), "x"); err == nil {
		t.Fatalf("outside write should fail")
	}
}

func TestConnectorHostTerminalMapsJobs(t *testing.T) {
	root := t.TempDir()
	client := &fakeToolClient{}
	host, err := NewConnectorHost(root, client)
	if err != nil {
		t.Fatalf("NewConnectorHost() error = %v", err)
	}
	id, err := host.Create(context.Background(), TerminalSpec{
		Command: "/bin/sh",
		Args:    []string{"-c", "echo hello"},
		Cwd:     root,
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if call := client.lastCall(); call.name != "start_job" || !strings.Contains(call.args["command"].(string), "echo hello") {
		t.Fatalf("start call = %+v", call)
	}
	output, err := host.Output(context.Background(), id)
	if err != nil || !strings.Contains(output.Output, "hello") {
		t.Fatalf("Output() = %+v, %v", output, err)
	}
	exit, err := host.Wait(context.Background(), id)
	if err != nil {
		t.Fatalf("Wait() error = %v", err)
	}
	if exit.ExitCode == nil || *exit.ExitCode != 0 {
		t.Fatalf("exit = %+v", exit)
	}
	if err := host.Release(context.Background(), id); err != nil {
		t.Fatalf("Release() error = %v", err)
	}
}
