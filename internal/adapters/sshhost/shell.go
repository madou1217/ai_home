package sshhost

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Connection 是 Server 里保存的一条 SSH 连接（app_kv: ssh_connections 的元素）。
type Connection struct {
	ID           string `json:"id"`
	Host         string `json:"host"`
	User         string `json:"user"`
	Port         int    `json:"port"`
	AuthType     string `json:"authType"`
	PrivateKey   string `json:"privateKey"`
	Password     string `json:"password"`
	IdentityFile string `json:"identityFile"`
}

// Command 是一条待启动的外部命令；Env 由调用方与进程环境合并。
type Command struct {
	File      string
	Args      []string
	Env       map[string]string
	TempFiles []string
}

// CredentialFS 是远程 shell 需要的文件系统子集；测试用内存实现。
type CredentialFS interface {
	MkdirAll(path string, perm os.FileMode) error
	WriteFile(path string, data []byte, perm os.FileMode) error
	EvalSymlinks(path string) (string, error)
	Stat(name string) (os.FileInfo, error)
	Remove(name string) error
}

type osCredentialFS struct{}

func (osCredentialFS) MkdirAll(path string, perm os.FileMode) error {
	return os.MkdirAll(path, perm)
}

func (osCredentialFS) WriteFile(path string, data []byte, perm os.FileMode) error {
	return os.WriteFile(path, data, perm)
}

func (osCredentialFS) EvalSymlinks(path string) (string, error) { return filepath.EvalSymlinks(path) }

func (osCredentialFS) Stat(name string) (os.FileInfo, error) { return os.Stat(name) }

func (osCredentialFS) Remove(name string) error { return os.Remove(name) }

// ShellQuote 是 POSIX 单引号引用；与 Node 的 shellQuote 一致。
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// RemoteSessionKey 是工作区终端在托管 PTY / 凭据文件名里的稳定标识。
func RemoteSessionKey(workspaceID, suffix string) string {
	base := "remote-ws:" + strings.TrimSpace(workspaceID)
	if suffix != "" {
		return base + ":" + suffix
	}
	return base
}

// CredentialDir 是临时凭据文件目录：<aiHomeDir>/run/ssh-remote。
func CredentialDir(aiHomeDir string) string {
	return filepath.Join(aiHomeDir, "run", "ssh-remote")
}

// BuildRemoteCommand 构造远端命令：
//   - 有工作区根目录时先 cd 进去，失败给出明确提示但继续；
//   - 远端有 tmux 就进入（或接回）同名会话，否则 exec 登录 shell。
func BuildRemoteCommand(remoteRoot, sessionKey string) string {
	root := strings.TrimSpace(remoteRoot)
	rawName := strings.TrimSpace(sessionKey)
	if rawName == "" {
		rawName = "ws"
	}
	name := truncateRunes("aih-"+sanitizeSessionName(rawName), 60)
	enter := ""
	if root != "" {
		enter = "cd " + ShellQuote(root) + " 2>/dev/null || echo " +
			ShellQuote("[aih] 远程目录不存在："+root+"，已进入 $HOME") + "; "
	}
	return enter + "if command -v tmux >/dev/null 2>&1; then exec tmux new-session -A -s " +
		ShellQuote(name) + "; fi; exec \"${SHELL:-/bin/sh}\" -l"
}

// RemoteShellOptions 构造远程 shell 命令的参数。
type RemoteShellOptions struct {
	Connection Connection
	RemoteRoot string
	SessionKey string
	AIHomeDir  string
	HomeDir    string
	Platform   string
	FS         CredentialFS
	// RandomHex 可注入随机源以便测试；返回偶数长度的十六进制串。
	RandomHex func(bytes int) (string, error)
}

// BuildRemoteShellCommand 构造 ssh 命令与临时凭据文件。
//
// 认证材料只在建连时落临时文件：私钥写 <aiHomeDir>/run/ssh-remote/<key>.key（0600），
// 密码写 askpass 脚本（0700）且密码本身只走环境变量；agent / key-file 不落任何文件。
func BuildRemoteShellCommand(options RemoteShellOptions) (Command, error) {
	connection := options.Connection
	if strings.TrimSpace(connection.Host) == "" {
		return Command{}, &ConfigError{Code: "ssh_connection_invalid"}
	}
	fsImpl := options.FS
	if fsImpl == nil {
		fsImpl = osCredentialFS{}
	}
	args := []string{
		"-tt",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=10",
		// 断线判定：30s 一次心跳，连续 4 次无响应才断（长时间空闲不掉线）。
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=4",
	}
	env := make(map[string]string)
	tempFiles := make([]string, 0, 1)
	authType := strings.TrimSpace(connection.AuthType)
	if authType == "" {
		authType = "agent"
	}
	sessionKey := strings.TrimSpace(options.SessionKey)
	if sessionKey == "" {
		generated, err := randomHex(options.RandomHex, 6)
		if err != nil {
			return Command{}, err
		}
		sessionKey = generated
	}
	safeName := truncateRunes(sanitizeFileToken(sessionKey), 120)
	dir := CredentialDir(options.AIHomeDir)

	switch {
	case authType == "key" && connection.PrivateKey != "":
		if err := fsImpl.MkdirAll(dir, 0o700); err != nil {
			return Command{}, err
		}
		keyFile := filepath.Join(dir, safeName+".key")
		body := connection.PrivateKey
		if !strings.HasSuffix(body, "\n") {
			body += "\n"
		}
		if err := fsImpl.WriteFile(keyFile, []byte(body), 0o600); err != nil {
			return Command{}, err
		}
		tempFiles = append(tempFiles, keyFile)
		args = append(args, "-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes")
	case authType == KeyFileAuthType:
		identityFile, err := ResolveIdentityFilePath(connection.IdentityFile, IdentityOptions{
			HomeDir:  options.HomeDir,
			Platform: options.Platform,
			FS:       credentialIdentityFS{fs: fsImpl},
		})
		if err != nil {
			return Command{}, err
		}
		args = append(args, "-i", identityFile, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes")
	case authType == "password" && connection.Password != "":
		if err := fsImpl.MkdirAll(dir, 0o700); err != nil {
			return Command{}, err
		}
		askPass := filepath.Join(dir, safeName+".askpass")
		// 密码通过 env 传给 askpass，不进脚本内容、不进命令行参数。
		if err := fsImpl.WriteFile(askPass, []byte("#!/bin/sh\nprintf \"%s\\n\" \"$AIH_SSH_PASSWORD\"\n"), 0o700); err != nil {
			return Command{}, err
		}
		tempFiles = append(tempFiles, askPass)
		env["AIH_SSH_PASSWORD"] = connection.Password
		env["SSH_ASKPASS"] = askPass
		env["SSH_ASKPASS_REQUIRE"] = "force"
		env["DISPLAY"] = ":0"
		args = append(args, "-o", "NumberOfPasswordPrompts=1")
	default:
		// agent：交给 Server 进程的 SSH_AUTH_SOCK；失败时 ssh 会在终端里提示。
		args = append(args, "-o", "BatchMode=yes")
	}
	if connection.Port != 0 {
		port := connection.Port
		if port <= 0 {
			port = 22
		}
		args = append(args, "-p", fmt.Sprintf("%d", port))
	}
	destination := connection.Host
	if connection.User != "" {
		destination = connection.User + "@" + connection.Host
	}
	args = append(args, destination, BuildRemoteCommand(options.RemoteRoot, sessionKey))
	return Command{File: "ssh", Args: args, Env: env, TempFiles: tempFiles}, nil
}

// RemoveCredentialFiles 覆写后删除临时凭据；文件已不存在或不可写时忽略。
func RemoveCredentialFiles(files []string, fsImpl CredentialFS) {
	if fsImpl == nil {
		fsImpl = osCredentialFS{}
	}
	for _, file := range files {
		info, err := fsImpl.Stat(file)
		if err != nil {
			continue
		}
		size := info.Size()
		if size < 0 {
			size = 0
		}
		if err := fsImpl.WriteFile(file, make([]byte, size), 0o600); err != nil {
			continue
		}
		_ = fsImpl.Remove(file)
	}
}

type credentialIdentityFS struct {
	fs CredentialFS
}

func (adapter credentialIdentityFS) EvalSymlinks(path string) (string, error) {
	return adapter.fs.EvalSymlinks(path)
}

func (adapter credentialIdentityFS) Stat(name string) (os.FileInfo, error) {
	return adapter.fs.Stat(name)
}

// sanitizeFileToken 把会话键收敛成安全文件名（对应 Node 的 SAFE_KEY 全局替换）。
func sanitizeFileToken(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || char == '.' || char == '_' || char == '-' {
			builder.WriteRune(char)
			continue
		}
		builder.WriteByte('_')
	}
	return builder.String()
}

// sanitizeSessionName 把会话键收敛成 tmux 会话名允许的字符。
func sanitizeSessionName(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || char == '_' || char == '-' {
			builder.WriteRune(char)
			continue
		}
		builder.WriteByte('-')
	}
	return builder.String()
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func randomHex(randomHexFunc func(int) (string, error), size int) (string, error) {
	if randomHexFunc != nil {
		return randomHexFunc(size)
	}
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}
