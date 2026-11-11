package sshremote

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// writeKnownHosts 往测试配置的 known_hosts 里写一行主机公钥。
func writeKnownHosts(t *testing.T, path, host string, port int, key ssh.PublicKey, marker string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("创建 known_hosts 目录失败: %v", err)
	}
	line := knownhosts.Line([]string{knownhosts.Normalize(net.JoinHostPort(host, strconv.Itoa(port)))}, key)
	if marker != "" {
		line = marker + " " + line
	}
	if err := os.WriteFile(path, []byte(line+"\n"), 0o600); err != nil {
		t.Fatalf("写 known_hosts 失败: %v", err)
	}
}

func TestKnownHostsAcceptNewRecordsHost(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec:     func(string, io.Writer, io.Writer) uint32 { return 0 },
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	dialTest(t, config).Close()

	body, err := os.ReadFile(config.KnownHostsPath)
	if err != nil {
		t.Fatalf("读取 known_hosts 失败: %v", err)
	}
	address := knownhosts.Normalize(net.JoinHostPort(config.Host, strconv.Itoa(config.Port)))
	if !strings.Contains(string(body), address) {
		t.Fatalf("known_hosts 未记录 %q: %q", address, string(body))
	}

	// 第二次连接命中已有记录，不应重复追加。
	before := len(body)
	dialTest(t, config).Close()
	after, err := os.ReadFile(config.KnownHostsPath)
	if err != nil {
		t.Fatalf("再次读取 known_hosts 失败: %v", err)
	}
	if len(after) != before {
		t.Fatalf("已知主机被重复记录: %d -> %d", before, len(after))
	}
}

func TestKnownHostsRejectsChangedKey(t *testing.T) {
	t.Parallel()
	server := startTestServer(t, testServerOptions{
		Password: "secret",
		Exec:     func(string, io.Writer, io.Writer) uint32 { return 0 },
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	// 预先写入一个不同的主机公钥，模拟中间人。
	otherSigner := newTestSigner(t)
	writeKnownHosts(t, config.KnownHostsPath, config.Host, config.Port, otherSigner.PublicKey(), "")

	_, err := Dial(context.Background(), config, testTimeout)
	if ErrorCode(err) != CodeHostKeyMismatch {
		t.Fatalf("错误码 = %q, want %q (%v)", ErrorCode(err), CodeHostKeyMismatch, err)
	}
}

func TestKnownHostsRejectsRevokedKey(t *testing.T) {
	t.Parallel()
	serverKey := newTestSigner(t)
	server := startTestServer(t, testServerOptions{
		HostKey:  serverKey,
		Password: "secret",
		Exec:     func(string, io.Writer, io.Writer) uint32 { return 0 },
	})
	config := testConfig(t, server, AuthPassword)
	config.Password = "secret"
	writeKnownHosts(t, config.KnownHostsPath, config.Host, config.Port, serverKey.PublicKey(), "@revoked")

	_, err := Dial(context.Background(), config, testTimeout)
	if ErrorCode(err) != CodeHostKeyRevoked {
		t.Fatalf("错误码 = %q, want %q (%v)", ErrorCode(err), CodeHostKeyRevoked, err)
	}
}
