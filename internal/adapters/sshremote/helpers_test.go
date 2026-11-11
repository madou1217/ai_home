package sshremote

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// testTimeout 是测试拨号的统一上限；比默认值短，失败时用例不会拖太久。
const testTimeout = 5 * time.Second

// errTestAuthentication 是测试 server 拒绝认证时返回的错误。
var errTestAuthentication = errors.New("test: authentication rejected")

// newTestKeyPair 生成一次性的 ed25519 密钥，同时返回 signer 与 OpenSSH PEM 私钥。
func newTestKeyPair(t *testing.T) (ssh.Signer, string) {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("生成测试密钥失败: %v", err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatalf("创建测试 signer 失败: %v", err)
	}
	block, err := ssh.MarshalPrivateKey(privateKey, "")
	if err != nil {
		t.Fatalf("编码测试私钥失败: %v", err)
	}
	return signer, string(pem.EncodeToMemory(block))
}

// newTestSigner 只要 signer 的场景（主机密钥、授权公钥）。
func newTestSigner(t *testing.T) ssh.Signer {
	t.Helper()
	signer, _ := newTestKeyPair(t)
	return signer
}

// testConfig 返回指向测试 server、known_hosts 落在临时目录的连接配置。
func testConfig(t *testing.T, server *testServer, authType string) Config {
	t.Helper()
	host, port := server.hostPort(t)
	home := t.TempDir()
	return Config{
		Host:           host,
		Port:           port,
		User:           "tester",
		AuthType:       authType,
		KnownHostsPath: filepath.Join(home, ".ssh", "known_hosts"),
		HomeDir:        home,
	}
}

// dialTest 用测试配置建立连接，失败时直接终止用例。
func dialTest(t *testing.T, config Config) *Client {
	t.Helper()
	client, err := Dial(context.Background(), config, testTimeout)
	if err != nil {
		t.Fatalf("拨号失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}
