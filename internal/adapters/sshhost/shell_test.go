package sshhost

import (
	"bytes"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestShellQuote(t *testing.T) {
	t.Parallel()
	cases := []struct {
		input string
		want  string
	}{
		{input: "", want: "''"},
		{input: "abc", want: "'abc'"},
		{input: "a b", want: "'a b'"},
		{input: "it's", want: "'it'\\''s'"},
		{input: "a'b'c", want: "'a'\\''b'\\''c'"},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.input, func(t *testing.T) {
			t.Parallel()
			if got := ShellQuote(testCase.input); got != testCase.want {
				t.Fatalf("ShellQuote(%q) = %q, want %q", testCase.input, got, testCase.want)
			}
		})
	}
}

func TestRemoteSessionKey(t *testing.T) {
	t.Parallel()
	if got := RemoteSessionKey("ws-1", ""); got != "remote-ws:ws-1" {
		t.Fatalf("无后缀 = %q", got)
	}
	if got := RemoteSessionKey(" ws-1 ", "tab"); got != "remote-ws:ws-1:tab" {
		t.Fatalf("带后缀 = %q", got)
	}
}

func TestBuildRemoteCommand(t *testing.T) {
	t.Parallel()
	bare := BuildRemoteCommand("", "workspace-1")
	wantBare := "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s 'aih-workspace-1'; fi; exec \"${SHELL:-/bin/sh}\" -l"
	if bare != wantBare {
		t.Fatalf("无根目录命令 = %q, want %q", bare, wantBare)
	}
	withRoot := BuildRemoteCommand("/srv/app", "workspace-1")
	if !strings.HasPrefix(withRoot, "cd '/srv/app' 2>/dev/null || echo ") {
		t.Fatalf("未先进入工作区目录: %q", withRoot)
	}
	if !strings.Contains(withRoot, "[aih] 远程目录不存在：/srv/app，已进入 $HOME") {
		t.Fatalf("缺少目录不存在提示: %q", withRoot)
	}
	quoted := BuildRemoteCommand("/srv/it's", "ws")
	if !strings.Contains(quoted, "cd '/srv/it'\\''s'") {
		t.Fatalf("根目录单引号未转义: %q", quoted)
	}
	emptyKey := BuildRemoteCommand("", "")
	if !strings.Contains(emptyKey, "'aih-ws'") {
		t.Fatalf("空会话键未回退成 ws: %q", emptyKey)
	}
	sanitized := BuildRemoteCommand("", "a b/c:d")
	if !strings.Contains(sanitized, "'aih-a-b-c-d'") {
		t.Fatalf("会话名未收敛: %q", sanitized)
	}
	longName := BuildRemoteCommand("", strings.Repeat("x", 200))
	tmuxPart := longName[strings.Index(longName, "new-session -A -s '")+len("new-session -A -s '"):]
	name := tmuxPart[:strings.Index(tmuxPart, "'")]
	if len(name) != 60 {
		t.Fatalf("会话名长度 = %d, want 60 (%q)", len(name), name)
	}
}

func TestBuildRemoteShellCommandAgent(t *testing.T) {
	t.Parallel()
	filesystem := newFakeCredentialFS()
	command, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", User: "me", Port: 2222},
		RemoteRoot: "/srv/app",
		SessionKey: "ws-1",
		AIHomeDir:  "/home/aih",
		FS:         filesystem,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if command.File != "ssh" {
		t.Fatalf("File = %q", command.File)
	}
	wantArgs := []string{
		"-tt",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=10",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=4",
		"-o", "BatchMode=yes",
		"-p", "2222",
		"me@example.com",
		BuildRemoteCommand("/srv/app", "ws-1"),
	}
	if !reflect.DeepEqual(command.Args, wantArgs) {
		t.Fatalf("Args = %#v, want %#v", command.Args, wantArgs)
	}
	if len(command.Env) != 0 || len(command.TempFiles) != 0 {
		t.Fatalf("agent 不应产生环境或临时文件: %#v %#v", command.Env, command.TempFiles)
	}
}

func TestBuildRemoteShellCommandKey(t *testing.T) {
	t.Parallel()
	filesystem := newFakeCredentialFS()
	command, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "key", PrivateKey: "PRIVATE"},
		RemoteRoot: "/srv",
		SessionKey: "ws:1",
		AIHomeDir:  "/home/aih",
		FS:         filesystem,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	keyFile := filepath.Join("/home/aih", "run", "ssh-remote", "ws_1.key")
	if len(command.TempFiles) != 1 || command.TempFiles[0] != keyFile {
		t.Fatalf("TempFiles = %#v, want %q", command.TempFiles, keyFile)
	}
	file, found := filesystem.files[keyFile]
	if !found {
		t.Fatalf("私钥文件未写入: %#v", filesystem.files)
	}
	if string(file.data) != "PRIVATE\n" {
		t.Fatalf("私钥内容 = %q", string(file.data))
	}
	if file.perm != 0o600 {
		t.Fatalf("私钥权限 = %o, want 600", file.perm)
	}
	if filesystem.dirs[filepath.Join("/home/aih", "run", "ssh-remote")] != 0o700 {
		t.Fatalf("凭据目录权限 = %o", filesystem.dirs[filepath.Join("/home/aih", "run", "ssh-remote")])
	}
	if !containsSequence(command.Args, "-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes") {
		t.Fatalf("Args = %#v", command.Args)
	}

	withNewline, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "key", PrivateKey: "PRIVATE\n"},
		SessionKey: "ws:1",
		AIHomeDir:  "/home/aih",
		FS:         newFakeCredentialFS(),
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if len(withNewline.TempFiles) != 1 {
		t.Fatalf("TempFiles = %#v", withNewline.TempFiles)
	}
}

func TestBuildRemoteShellCommandPassword(t *testing.T) {
	t.Parallel()
	filesystem := newFakeCredentialFS()
	command, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "password", Password: "s3cret"},
		SessionKey: "ws-1",
		AIHomeDir:  "/home/aih",
		FS:         filesystem,
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	askPass := filepath.Join("/home/aih", "run", "ssh-remote", "ws-1.askpass")
	file, found := filesystem.files[askPass]
	if !found {
		t.Fatalf("askpass 未写入: %#v", filesystem.files)
	}
	wantScript := "#!/bin/sh\nprintf \"%s\\n\" \"$AIH_SSH_PASSWORD\"\n"
	if string(file.data) != wantScript {
		t.Fatalf("askpass 内容 = %q, want %q", string(file.data), wantScript)
	}
	if file.perm != 0o700 {
		t.Fatalf("askpass 权限 = %o, want 700", file.perm)
	}
	wantEnv := map[string]string{
		"AIH_SSH_PASSWORD":    "s3cret",
		"SSH_ASKPASS":         askPass,
		"SSH_ASKPASS_REQUIRE": "force",
		"DISPLAY":             ":0",
	}
	if !reflect.DeepEqual(command.Env, wantEnv) {
		t.Fatalf("Env = %#v, want %#v", command.Env, wantEnv)
	}
	if !containsSequence(command.Args, "-o", "NumberOfPasswordPrompts=1") {
		t.Fatalf("Args = %#v", command.Args)
	}
	for _, argument := range command.Args {
		if strings.Contains(argument, "s3cret") {
			t.Fatalf("密码不得出现在命令行参数: %q", argument)
		}
	}
}

func TestBuildRemoteShellCommandKeyFile(t *testing.T) {
	t.Parallel()
	home := newIdentityHome(t)
	keyPath := filepath.Join(home, ".ssh", "id_ed25519")
	writeIdentityFile(t, keyPath, 0o600)
	realKeyPath, err := filepath.EvalSymlinks(keyPath)
	if err != nil {
		t.Fatalf("解析真实路径失败: %v", err)
	}
	command, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: KeyFileAuthType, IdentityFile: "~/.ssh/id_ed25519"},
		SessionKey: "ws-1",
		HomeDir:    home,
		AIHomeDir:  "/home/aih",
		FS:         osCredentialFS{},
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if !containsSequence(command.Args, "-i", realKeyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes") {
		t.Fatalf("Args = %#v", command.Args)
	}
	if len(command.TempFiles) != 0 {
		t.Fatalf("key-file 不应产生临时文件: %#v", command.TempFiles)
	}
}

func TestBuildRemoteShellCommandErrors(t *testing.T) {
	t.Parallel()
	_, err := BuildRemoteShellCommand(RemoteShellOptions{})
	var configErr *ConfigError
	if !errors.As(err, &configErr) || configErr.Code != "ssh_connection_invalid" {
		t.Fatalf("error = %v, want ssh_connection_invalid", err)
	}

	home := newIdentityHome(t)
	_, err = BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: KeyFileAuthType, IdentityFile: "~/.ssh/missing"},
		SessionKey: "ws-1",
		HomeDir:    home,
	})
	var identityErr *IdentityFileError
	if !errors.As(err, &identityErr) || identityErr.Code != IdentityFileNotFound {
		t.Fatalf("error = %v, want identity_file_not_found", err)
	}

	failing := newFakeCredentialFS()
	failing.mkdirErr = errors.New("read-only")
	_, err = BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "key", PrivateKey: "KEY"},
		SessionKey: "ws-1",
		AIHomeDir:  "/home/aih",
		FS:         failing,
	})
	if err == nil {
		t.Fatal("mkdir 失败必须返回错误")
	}

	failingWrite := newFakeCredentialFS()
	failingWrite.writeErr = errors.New("disk full")
	_, err = BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "password", Password: "x"},
		SessionKey: "ws-1",
		AIHomeDir:  "/home/aih",
		FS:         failingWrite,
	})
	if err == nil {
		t.Fatal("写文件失败必须返回错误")
	}
}

func TestBuildRemoteShellCommandGeneratedSessionKey(t *testing.T) {
	t.Parallel()
	command, err := BuildRemoteShellCommand(RemoteShellOptions{
		Connection: Connection{Host: "example.com", AuthType: "key", PrivateKey: "KEY"},
		AIHomeDir:  "/home/aih",
		FS:         newFakeCredentialFS(),
		RandomHex:  func(int) (string, error) { return "abc123", nil },
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if len(command.TempFiles) != 1 || !strings.HasSuffix(command.TempFiles[0], "abc123.key") {
		t.Fatalf("TempFiles = %#v", command.TempFiles)
	}
	if !strings.Contains(command.Args[len(command.Args)-1], "aih-abc123") {
		t.Fatalf("远端命令未使用生成的会话键: %q", command.Args[len(command.Args)-1])
	}
}

func TestRemoveCredentialFiles(t *testing.T) {
	t.Parallel()
	filesystem := newFakeCredentialFS()
	path := "/home/aih/run/ssh-remote/ws.key"
	if err := filesystem.WriteFile(path, []byte("SECRET"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	filesystem.writes = nil
	RemoveCredentialFiles([]string{path, "/missing"}, filesystem)
	if len(filesystem.writes) != 1 {
		t.Fatalf("覆写次数 = %d, want 1", len(filesystem.writes))
	}
	if filesystem.writes[0].path != path || !bytes.Equal(filesystem.writes[0].data, make([]byte, 6)) {
		t.Fatalf("覆写内容 = %#v", filesystem.writes[0])
	}
	if len(filesystem.removed) != 1 || filesystem.removed[0] != path {
		t.Fatalf("删除记录 = %#v", filesystem.removed)
	}
	if _, found := filesystem.files[path]; found {
		t.Fatal("文件未被删除")
	}
}

func containsSequence(values []string, sequence ...string) bool {
	if len(sequence) == 0 || len(values) < len(sequence) {
		return false
	}
	for start := 0; start+len(sequence) <= len(values); start++ {
		matched := true
		for index := range sequence {
			if values[start+index] != sequence[index] {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}
