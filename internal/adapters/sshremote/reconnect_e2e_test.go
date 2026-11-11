package sshremote

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestReconnectingPTYAgainstLocalSSHD 是唯一会连接真实 sshd 的用例。
// 默认跳过；本机验证时显式 AIH_SSH_E2E=1，并且要求 127.0.0.1:22 可登录、
// ~/.ssh 下存在私钥。它不会修改 authorized_keys 或系统 known_hosts。
func TestReconnectingPTYAgainstLocalSSHD(t *testing.T) {
	if os.Getenv("AIH_SSH_E2E") != "1" {
		t.Skip("设置 AIH_SSH_E2E=1 才跑真实 sshd")
	}
	connection, err := net.DialTimeout("tcp", "127.0.0.1:22", time.Second)
	if err != nil {
		t.Skipf("本机 22 端口没有 sshd: %v", err)
	}
	_ = connection.Close()
	home := os.Getenv("AIH_SSH_E2E_HOME")
	if home == "" {
		home, err = os.UserHomeDir()
		if err != nil {
			t.Skipf("无法定位 home: %v", err)
		}
	}
	keyPath := ""
	for _, name := range []string{"id_rsa", "id_ed25519", "id_ecdsa"} {
		candidate := filepath.Join(home, ".ssh", name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			keyPath = candidate
			break
		}
	}
	if keyPath == "" {
		t.Skip("~/.ssh 下没有可用于本机 sshd 的私钥")
	}
	user := os.Getenv("USER")
	if user == "" {
		t.Skip("USER 为空")
	}
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	flag := fmt.Sprintf("/tmp/aih-ssh-reconnect-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = os.Remove(flag) })
	command := fmt.Sprintf("if [ ! -f %s ]; then touch %s; exit 255; fi; echo RECONNECTED; sleep 30", flag, flag)
	session, err := OpenReconnectingPTY(context.Background(), Config{
		Host: "127.0.0.1", Port: 22, User: user,
		AuthType: AuthKeyFile, IdentityFile: keyPath,
		KnownHostsPath: knownHosts, HomeDir: home,
	}, command, PTYOptions{Cols: 100, Rows: 30})
	if err != nil {
		t.Fatalf("OpenReconnectingPTY: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	reader := bufio.NewReader(session)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		line, readErr := reader.ReadString('\n')
		if line != "" && containsText(line, "RECONNECTED") {
			return
		}
		if readErr != nil {
			t.Fatalf("读取重连输出失败: %v", readErr)
		}
	}
	t.Fatal("15s 内没有看到第二次连接输出 RECONNECTED")
}

func containsText(haystack string, needle string) bool {
	return len(needle) == 0 || (len(haystack) >= len(needle) && indexOf(haystack, needle) >= 0)
}

func indexOf(haystack string, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if haystack[index:index+len(needle)] == needle {
			return index
		}
	}
	return -1
}
