package sshremote

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestReverseTunnelAgainstAWS 是真实跨网络反向隧道验收（gated）。
// 需要 AIH_SSH_AWS_E2E=1 与 HOST/USER/KEY；使用临时远端端口 22023，不碰生产 22022。
func TestReverseTunnelAgainstAWS(t *testing.T) {
	if os.Getenv("AIH_SSH_AWS_E2E") != "1" {
		t.Skip("设置 AIH_SSH_AWS_E2E=1 才跑真实跨网络反向隧道")
	}
	host := os.Getenv("AIH_SSH_AWS_HOST")
	user := os.Getenv("AIH_SSH_AWS_USER")
	key := os.Getenv("AIH_SSH_AWS_KEY")
	if host == "" || user == "" || key == "" {
		t.Skip("缺少 AIH_SSH_AWS_HOST/USER/KEY")
	}
	remotePort := 22023
	config := Config{
		Host: host, Port: 22, User: user,
		AuthType: AuthKeyFile, IdentityFile: key,
		HomeDir: "/Users/model", KnownHostsPath: t.TempDir() + "/known_hosts",
	}
	tunnel, err := OpenReverseTunnel(context.Background(), config, remotePort, 22)
	if err != nil {
		t.Fatalf("OpenReverseTunnel: %v", err)
	}
	t.Cleanup(func() { _ = tunnel.Close() })
	client, err := Dial(context.Background(), config, 0)
	if err != nil {
		t.Fatalf("Dial AWS: %v", err)
	}
	defer func() { _ = client.Close() }()
	command := "timeout 5 bash -c 'exec 3<>/dev/tcp/127.0.0.1/" + strconv.Itoa(remotePort) + "; head -c 4 <&3'"
	result, err := client.RunArgv(context.Background(), []string{"bash", "-lc", command}, 0)
	if err != nil {
		t.Fatalf("remote probe: %v", err)
	}
	if result.Code != 0 || !strings.Contains(string(result.Stdout), "SSH-") {
		t.Fatalf("code=%d stdout=%q stderr=%q", result.Code, result.Stdout, result.Stderr)
	}
	time.Sleep(100 * time.Millisecond)
	if tunnel.Stats().Connections < 1 {
		t.Fatalf("stats = %+v", tunnel.Stats())
	}
}
