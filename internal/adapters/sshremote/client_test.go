package sshremote

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestQuoteArgv(t *testing.T) {
	t.Parallel()
	quoted, err := QuoteArgv([]string{"echo", "a b", "it's", ""})
	if err != nil {
		t.Fatalf("QuoteArgv 失败: %v", err)
	}
	want := "'echo' 'a b' 'it'\\''s' ''"
	if quoted != want {
		t.Fatalf("QuoteArgv = %q, want %q", quoted, want)
	}
	if _, err := QuoteArgv(nil); err == nil {
		t.Fatal("空 argv 应当报错")
	}
}

func TestPasswordAuthentication(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	var commands []string
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(command string, stdout, _ io.Writer) uint32 {
			mutex.Lock()
			commands = append(commands, command)
			mutex.Unlock()
			_, _ = io.WriteString(stdout, "hello\n")
			return 0
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)
	result, err := client.RunArgv(context.Background(), []string{"echo", "a b"}, 0)
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if result.Code != 0 || string(result.Stdout) != "hello\n" {
		t.Fatalf("result = %#v", result)
	}
	mutex.Lock()
	defer mutex.Unlock()
	want := "'echo' 'a b'"
	if len(commands) != 1 || commands[0] != want {
		t.Fatalf("远端命令 = %#v, want %q", commands, want)
	}
}

func TestPasswordAuthenticationFailure(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec:     func(string, io.Writer, io.Writer) uint32 { return 0 },
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "wrong"
	_, err := Dial(context.Background(), config, testTimeout)
	if ErrorCode(err) != CodeAuthFailed {
		t.Fatalf("错误码 = %q, want %q (%v)", ErrorCode(err), CodeAuthFailed, err)
	}
}

func TestPrivateKeyAuthentication(t *testing.T) {
	t.Parallel()
	signer, privateKeyPEM := newTestKeyPair(t)
	server := startTestServer(t, testServerOptions{
		AuthorizedKey: signer.PublicKey(),
		Exec: func(_ string, stdout, _ io.Writer) uint32 {
			_, _ = io.WriteString(stdout, "ok")
			return 0
		},
	})
	config := testConfig(t, server, AuthKey)
	config.PrivateKey = privateKeyPEM
	client := dialTest(t, config)
	result, err := client.Run(context.Background(), "true", 0)
	if err != nil || result.Code != 0 || string(result.Stdout) != "ok" {
		t.Fatalf("私钥认证执行失败: result=%#v err=%v", result, err)
	}
}

func TestPrivateKeyRejected(t *testing.T) {
	t.Parallel()
	authorizedSigner, _ := newTestKeyPair(t)
	_, unknownPrivateKey := newTestKeyPair(t)
	server := startTestServer(t, testServerOptions{
		AuthorizedKey: authorizedSigner.PublicKey(),
		Exec:          func(string, io.Writer, io.Writer) uint32 { return 0 },
	})
	config := testConfig(t, server, AuthKey)
	config.PrivateKey = unknownPrivateKey
	_, err := Dial(context.Background(), config, testTimeout)
	if ErrorCode(err) != CodeAuthFailed {
		t.Fatalf("未知私钥应认证失败，实际错误码 %q (%v)", ErrorCode(err), err)
	}
}

func TestStreamDeliversOutputBeforeExit(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(_ string, stdout, _ io.Writer) uint32 {
			_, _ = io.WriteString(stdout, "first\n")
			time.Sleep(250 * time.Millisecond)
			_, _ = io.WriteString(stdout, "second\n")
			return 0
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)

	firstChunk := make(chan time.Time, 1)
	var once sync.Once
	writer := writerFunc(func(data []byte) (int, error) {
		once.Do(func() { firstChunk <- time.Now() })
		return len(data), nil
	})
	started := time.Now()
	done := make(chan error, 1)
	go func() {
		_, err := client.Stream(context.Background(), "stream", writer, io.Discard)
		done <- err
	}()
	select {
	case at := <-firstChunk:
		if at.Sub(started) > 150*time.Millisecond {
			t.Fatalf("第一块输出到达太晚: %v", at.Sub(started))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("等待第一块输出超时")
	}
	if err := <-done; err != nil {
		t.Fatalf("Stream 失败: %v", err)
	}
}

func TestRunReportsExitCodeAndStderr(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(_ string, _, stderr io.Writer) uint32 {
			_, _ = io.WriteString(stderr, "boom-detail")
			return 7
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)
	result, err := client.Run(context.Background(), "boom", 0)
	if err != nil {
		t.Fatalf("非零退出码不应当返回 error: %v", err)
	}
	if result.Code != 7 || string(result.Stderr) != "boom-detail" {
		t.Fatalf("result = %#v", result)
	}
}

func TestRunTruncatesOutput(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec: func(_ string, stdout, _ io.Writer) uint32 {
			_, _ = io.WriteString(stdout, strings.Repeat("x", 100))
			return 0
		},
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	client := dialTest(t, config)
	result, err := client.Run(context.Background(), "big", 10)
	if err != nil {
		t.Fatalf("执行失败: %v", err)
	}
	if len(result.Stdout) != 10 || !result.Truncated {
		t.Fatalf("截断结果 = %#v (len=%d)", result, len(result.Stdout))
	}
}

func TestDialTimeoutWhenPeerSilent(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			// 接受后保持沉默，模拟握手阶段卡住的对端。
			go func() {
				time.Sleep(3 * time.Second)
				_ = connection.Close()
			}()
		}
	}()
	address := listener.Addr().(*net.TCPAddr)
	started := time.Now()
	_, err = Dial(context.Background(), Config{
		Host: "127.0.0.1", Port: address.Port, User: "tester",
		AuthType: AuthPassword, Password: "x",
		KnownHostsPath: t.TempDir() + "/known_hosts",
	}, 250*time.Millisecond)
	if ErrorCode(err) != CodeTimeout {
		t.Fatalf("错误码 = %q, want %q (%v)", ErrorCode(err), CodeTimeout, err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("超时耗时过长: %v", elapsed)
	}
}

func TestDialCancellation(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				time.Sleep(3 * time.Second)
				_ = connection.Close()
			}()
		}
	}()
	address := listener.Addr().(*net.TCPAddr)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	_, err = Dial(ctx, Config{
		Host: "127.0.0.1", Port: address.Port, User: "tester",
		AuthType: AuthPassword, Password: "x",
		KnownHostsPath: t.TempDir() + "/known_hosts",
	}, 5*time.Second)
	if ErrorCode(err) != CodeTimeout {
		t.Fatalf("取消应归为超时，实际错误码 %q (%v)", ErrorCode(err), err)
	}
	if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		t.Logf("取消原因未被保留为 ctx 错误: %v", err)
	}
}

func TestConfigValidation(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		config Config
	}{
		{name: "缺少主机", config: Config{AuthType: AuthPassword, Password: "x"}},
		{name: "端口越界", config: Config{Host: "127.0.0.1", Port: 70000, AuthType: AuthPassword, Password: "x"}},
		{name: "密码缺失", config: Config{Host: "127.0.0.1", AuthType: AuthPassword}},
		{name: "私钥缺失", config: Config{Host: "127.0.0.1", AuthType: AuthKey}},
		{name: "未知认证", config: Config{Host: "127.0.0.1", AuthType: "kerberos"}},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if err := testCase.config.Validate(); ErrorCode(err) != CodeInvalidConfig {
				t.Fatalf("Validate(%s) = %v, want %s", testCase.name, err, CodeInvalidConfig)
			}
		})
	}
}

// writerFunc 让普通函数满足 io.Writer。
type writerFunc func([]byte) (int, error)

func (write writerFunc) Write(data []byte) (int, error) { return write(data) }

func TestKeyFileAuthentication(t *testing.T) {
	t.Parallel()
	signer, privateKeyPEM := newTestKeyPair(t)
	server := startTestServer(t, testServerOptions{
		AuthorizedKey: signer.PublicKey(),
		Exec: func(_ string, stdout, _ io.Writer) uint32 {
			_, _ = io.WriteString(stdout, "ok")
			return 0
		},
	})
	home := t.TempDir()
	sshDir := filepath.Join(home, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatalf("创建 .ssh 失败: %v", err)
	}
	keyPath := filepath.Join(sshDir, "id_ed25519")
	if err := os.WriteFile(keyPath, []byte(privateKeyPEM), 0o600); err != nil {
		t.Fatalf("写身份文件失败: %v", err)
	}
	host, port := server.hostPort(t)
	config := Config{
		Host: host, Port: port, User: "tester",
		AuthType: AuthKeyFile, IdentityFile: "~/.ssh/id_ed25519",
		HomeDir: home, KnownHostsPath: filepath.Join(home, "known_hosts"),
	}
	client := dialTest(t, config)
	result, err := client.Run(context.Background(), "true", 0)
	if err != nil || result.Code != 0 || string(result.Stdout) != "ok" {
		t.Fatalf("key-file 认证执行失败: result=%#v err=%v", result, err)
	}
}

func TestAgentUnavailable(t *testing.T) {
	t.Setenv("SSH_AUTH_SOCK", "")
	_, err := Dial(context.Background(), Config{
		Host: "127.0.0.1", User: "tester", AuthType: AuthAgent,
		KnownHostsPath: filepath.Join(t.TempDir(), "known_hosts"),
	}, time.Second)
	if ErrorCode(err) != CodeAgentUnavailable {
		t.Fatalf("错误码 = %q, want %q (%v)", ErrorCode(err), CodeAgentUnavailable, err)
	}
}
