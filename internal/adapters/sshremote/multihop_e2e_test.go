package sshremote

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMultiHopReconnectAgainstLocalSSHD 用两个真实 sshd 进程验证「跳板 → 目标 → 断线重连」：
//   - 第一跳：系统 sshd 127.0.0.1:22，使用宿主 ~/.ssh/id_rsa；
//   - 第二跳：本测试启动的独立 sshd（随机端口 + 临时 host/client key）；
//   - 远端命令第一次 exit 255，重连后输出 MULTIHOP_RECONNECTED。
//
// 默认跳过；本机验证时 AIH_SSH_E2E=1 AIH_SSH_E2E_HOME=/Users/model。
func TestMultiHopReconnectAgainstLocalSSHD(t *testing.T) {
	if os.Getenv("AIH_SSH_E2E") != "1" {
		t.Skip("设置 AIH_SSH_E2E=1 才跑真实 sshd")
	}
	if _, err := os.Stat("/usr/sbin/sshd"); err != nil {
		t.Skip("本机没有 /usr/sbin/sshd")
	}
	hostHome := os.Getenv("AIH_SSH_E2E_HOME")
	if hostHome == "" {
		hostHome = "/Users/model"
	}
	jumpKey := firstKey(t, hostHome)
	user := os.Getenv("USER")
	if user == "" {
		t.Skip("USER 为空")
	}
	targetPort, targetHome, stopSSHD := startUserSSHD(t)
	t.Cleanup(stopSSHD)

	known := t.TempDir()
	jump := Config{
		Host: "127.0.0.1", Port: 22, User: user,
		AuthType: AuthKeyFile, IdentityFile: jumpKey,
		KnownHostsPath: filepath.Join(known, "jump_known_hosts"),
		HomeDir:        hostHome,
	}
	target := Config{
		Host: "127.0.0.1", Port: targetPort, User: user,
		AuthType: AuthKeyFile, IdentityFile: "~/.ssh/id_ed25519",
		KnownHostsPath: filepath.Join(known, "target_known_hosts"),
		HomeDir:        targetHome,
		Jump:           &jump,
	}

	flag := filepath.Join(t.TempDir(), "reconnected")
	command := fmt.Sprintf("if [ ! -f %s ]; then touch %s; exit 255; fi; echo MULTIHOP_RECONNECTED; sleep 30", flag, flag)
	session, err := OpenReconnectingPTY(context.Background(), target, command, PTYOptions{Cols: 90, Rows: 24})
	if err != nil {
		t.Fatalf("OpenReconnectingPTY: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	reader := bufio.NewReader(session)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		line, readErr := reader.ReadString('\n')
		if strings.Contains(line, "MULTIHOP_RECONNECTED") {
			return
		}
		if readErr != nil {
			t.Fatalf("读取多跳输出失败: %v", readErr)
		}
	}
	t.Fatal("20s 内没有看到多跳重连输出")
}

func firstKey(t *testing.T, home string) string {
	t.Helper()
	for _, name := range []string{"id_rsa", "id_ed25519", "id_ecdsa"} {
		path := filepath.Join(home, ".ssh", name)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			return path
		}
	}
	t.Skip("宿主 ~/.ssh 下没有可用私钥")
	return ""
}

// startUserSSHD 启动一个只监听 127.0.0.1 随机端口的独立 sshd，返回端口与清理函数。
func startUserSSHD(t *testing.T) (int, string, func()) {
	t.Helper()
	directory := t.TempDir()
	if err := os.Chmod(directory, 0o700); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	run := func(args ...string) {
		command := exec.Command("ssh-keygen", args...)
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("ssh-keygen %v: %v %s", args, err, output)
		}
	}
	hostKey := filepath.Join(directory, "host_key")
	clientKey := filepath.Join(directory, ".ssh", "id_ed25519")
	if err := os.MkdirAll(filepath.Dir(clientKey), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	run("-q", "-t", "ed25519", "-N", "", "-f", hostKey)
	run("-q", "-t", "ed25519", "-N", "", "-f", clientKey)
	authorized := filepath.Join(directory, "authorized_keys")
	public, err := os.ReadFile(clientKey + ".pub")
	if err != nil {
		t.Fatalf("read client pub: %v", err)
	}
	if err := os.WriteFile(authorized, public, 0o600); err != nil {
		t.Fatalf("write authorized_keys: %v", err)
	}
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve port: %v", err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	configPath := filepath.Join(directory, "sshd_config")
	config := strings.Join([]string{
		"Port " + strconv.Itoa(port),
		"ListenAddress 127.0.0.1",
		"HostKey " + hostKey,
		"AuthorizedKeysFile " + authorized,
		"PasswordAuthentication no",
		"KbdInteractiveAuthentication no",
		"PubkeyAuthentication yes",
		"UsePAM no",
		"StrictModes no",
		"PidFile " + filepath.Join(directory, "sshd.pid"),
		"LogLevel ERROR",
	}, "\n") + "\n"
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatalf("write sshd config: %v", err)
	}
	logPath := filepath.Join(directory, "sshd.log")
	command := exec.Command("/usr/sbin/sshd", "-D", "-f", configPath, "-E", logPath)
	command.Stdout = ioDiscard{}
	command.Stderr = ioDiscard{}
	if err := command.Start(); err != nil {
		t.Fatalf("start sshd: %v", err)
	}
	stop := func() {
		if command.Process != nil {
			_ = command.Process.Kill()
			_, _ = command.Process.Wait()
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		connection, dialErr := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), 200*time.Millisecond)
		if dialErr == nil {
			_ = connection.Close()
			return port, directory, stop
		}
		time.Sleep(50 * time.Millisecond)
	}
	stop()
	output, _ := os.ReadFile(logPath)
	t.Fatalf("目标 sshd 未监听 %d: %s", port, output)
	return 0, directory, stop
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) { return len(p), nil }
