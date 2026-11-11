package sshremote

import (
	"context"
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestReverseTunnelAgainstLocalSSHD 验证真实反向隧道：
// Go 连上临时远端 sshd，请求远端 127.0.0.1:P 反向转发到本机 sshd:22；
// 再作为“远端客户端”连 P，必须落到本机 sshd 并执行命令。
func TestReverseTunnelAgainstLocalSSHD(t *testing.T) {
	if os.Getenv("AIH_SSH_E2E") != "1" {
		t.Skip("设置 AIH_SSH_E2E=1 才跑真实 sshd")
	}
	hostHome := os.Getenv("AIH_SSH_E2E_HOME")
	if hostHome == "" {
		hostHome = "/Users/model"
	}
	user := os.Getenv("USER")
	if user == "" {
		t.Skip("USER 为空")
	}
	localKey := firstKey(t, hostHome)
	targetPort, targetHome, stop := startUserSSHD(t)
	t.Cleanup(stop)
	remotePort := reservePort(t)
	known := t.TempDir()
	targetConfig := Config{
		Host: "127.0.0.1", Port: targetPort, User: user,
		AuthType: AuthKeyFile, IdentityFile: "~/.ssh/id_ed25519",
		HomeDir: targetHome, KnownHostsPath: known + "/target_known_hosts",
	}
	tunnel, err := OpenReverseTunnel(context.Background(), targetConfig, remotePort, 22)
	if err != nil {
		t.Fatalf("OpenReverseTunnel: %v", err)
	}
	t.Cleanup(func() { _ = tunnel.Close() })

	// 从“远端”连反向端口；目标 sshd 把它转发到本机 sshd。
	clientConfig := Config{
		Host: "127.0.0.1", Port: remotePort, User: user,
		AuthType: AuthKeyFile, IdentityFile: localKey,
		HomeDir: hostHome, KnownHostsPath: known + "/local_known_hosts",
	}
	client, err := Dial(context.Background(), clientConfig, 0)
	if err != nil {
		t.Fatalf("dial reverse port: %v", err)
	}
	defer func() { _ = client.Close() }()
	result, err := client.RunArgv(context.Background(), []string{"sh", "-c", "echo REVERSE_TUNNEL_OK"}, 0)
	if err != nil {
		t.Fatalf("run through reverse tunnel: %v", err)
	}
	if result.Code != 0 || !strings.Contains(string(result.Stdout), "REVERSE_TUNNEL_OK") {
		t.Fatalf("code=%d stdout=%s stderr=%s", result.Code, result.Stdout, result.Stderr)
	}
	stats := tunnel.Stats()
	if stats.Connections != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	if err := tunnel.Probe(context.Background()); err != nil {
		t.Fatalf("probe healthy tunnel: %v", err)
	}
}

func reservePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	if port < 1024 {
		port = 22222
	}
	return port
}

var _ = strconv.Itoa
var _ = time.Second
