package sshremote

import (
	"context"
	"io"
	"net"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProbeReachable(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(command string, stdout, _ io.Writer) uint32 {
			if !strings.Contains(command, "platform=") {
				return 127
			}
			_, _ = io.WriteString(stdout, strings.Join([]string{
				"platform=Linux",
				"arch=x86_64",
				"node=present",
				"npm=present",
				"git=missing",
				"aih=present",
				"",
			}, "\n"))
			return 0
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"

	result, err := Prober{}.Probe(context.Background(), config, testTimeout)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if result.Status != "reachable" || result.Platform != "Linux" || result.Arch != "x86_64" {
		t.Fatalf("结果 = %#v", result)
	}
	if !result.Commands["node"] || result.Commands["git"] {
		t.Fatalf("commands = %#v", result.Commands)
	}
	if !strings.Contains(result.Recommendation, "git") {
		t.Fatalf("建议未提到缺失命令: %q", result.Recommendation)
	}
	if result.Kind != "ssh" || result.Host != config.Host || result.Port != config.Port {
		t.Fatalf("身份字段 = %#v", result)
	}
}

func TestProbeAuthRequired(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{Password: "secret"})
	config := testConfig(t, server, AuthPassword)
	config.Password = "wrong"

	result, err := Prober{}.Probe(context.Background(), config, testTimeout)
	if err != nil {
		t.Fatalf("认证失败应体现在结果里而不是 error: %v", err)
	}
	if result.Status != "auth-required" {
		t.Fatalf("status = %q, want auth-required (%#v)", result.Status, result)
	}
	if result.TimedOut {
		t.Fatal("认证失败不应标记超时")
	}
	if strings.TrimSpace(result.Stderr) == "" {
		t.Fatal("auth-required 应带错误说明")
	}
}

func TestProbeUnreachable(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	address := listener.Addr().(*net.TCPAddr)
	_ = listener.Close()

	config := Config{
		Host:           "127.0.0.1",
		Port:           address.Port,
		User:           "tester",
		AuthType:       AuthPassword,
		Password:       "secret",
		KnownHostsPath: filepath.Join(t.TempDir(), "known_hosts"),
		HomeDir:        t.TempDir(),
	}
	result, err := Prober{}.Probe(context.Background(), config, 2*time.Second)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if result.Status != "unreachable" {
		t.Fatalf("status = %q, want unreachable (%#v)", result.Status, result)
	}
}

func TestProbeWindowsFallback(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(command string, stdout, _ io.Writer) uint32 {
			if strings.Contains(command, "powershell") {
				_, _ = io.WriteString(stdout, "platform=Windows\narch=AMD64\nnode=present\n")
				return 0
			}
			return 1
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"

	result, err := Prober{}.Probe(context.Background(), config, testTimeout)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if result.Status != "reachable" || result.Platform != "Windows" {
		t.Fatalf("结果 = %#v", result)
	}
}

func TestProbeTimeoutMarksTimedOut(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer func() { _ = listener.Close() }()
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func(conn net.Conn) {
				time.Sleep(2 * time.Second)
				_ = conn.Close()
			}(connection)
		}
	}()
	address := listener.Addr().(*net.TCPAddr)
	config := Config{
		Host:           "127.0.0.1",
		Port:           address.Port,
		User:           "tester",
		AuthType:       AuthPassword,
		Password:       "secret",
		KnownHostsPath: filepath.Join(t.TempDir(), "known_hosts"),
		HomeDir:        t.TempDir(),
	}
	started := time.Now()
	result, err := Prober{}.Probe(context.Background(), config, 300*time.Millisecond)
	if err != nil {
		t.Fatalf("探测失败: %v", err)
	}
	if result.Status != "unreachable" || !result.TimedOut {
		t.Fatalf("结果 = %#v", result)
	}
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("超时未生效: %v", elapsed)
	}
}
