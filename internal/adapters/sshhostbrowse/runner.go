// Package sshhostbrowse 把 sshremote 的远端执行能力接到 WebUI 目录浏览的 Runner 端口。
//
// 支持 POSIX 与 Windows PowerShell 远端浏览（含空路径 / ~ / 相对路径解析远端家目录），
// 也支持已配置 reverseTunnel 或 egressConnectionId 跳板链的连接。
package sshhostbrowse

import (
	"context"
	"errors"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
)

const detectAndHomeCommand = `uname -s 2>/dev/null && printf 'AIH_POSIX\n%s\n' "$HOME" || powershell -NoProfile -NonInteractive -Command "Write-Output AIH_WINDOWS; Write-Output ([Environment]::GetFolderPath(UserProfile))"`

// Runner 实现 webuisshhostbrowseapi.Runner 与 webuisshhostbrowseapi.DirectoryBrowser。
type Runner struct {
	HomeDir string
}

// Run 在指定连接上执行 argv，返回远端 stdout。
func (runner Runner) Run(ctx context.Context, connection webuisshhostbrowseapi.Conn, argv []string) ([]byte, error) {
	if strings.TrimSpace(connection.EgressConnectionID) != "" && connection.Jump == nil {
		return nil, &webuisshhostbrowseapi.RemoteFailure{
			Code:    "ssh_egress_unresolved",
			Message: "该连接的出口连接不存在或跳板链无效。",
		}
	}
	client, err := sshremote.Dial(ctx, configFor(connection, runner.HomeDir), 0)
	if err != nil {
		return nil, translate(err)
	}
	defer func() { _ = client.Close() }()
	result, err := client.RunArgv(ctx, argv, 0)
	if err != nil {
		return nil, translate(err)
	}
	if result.Code != 0 {
		cause := sshhost.ClassifyBrowseFailure(result.Code, string(result.Stderr))
		return nil, &webuisshhostbrowseapi.RemoteFailure{Code: cause.Code, Message: cause.Message}
	}
	return result.Stdout, nil
}

// BrowseDirectory 在单次 SSH 会话中解析远端家目录/方言并列出目标目录。
func (runner Runner) BrowseDirectory(
	ctx context.Context,
	connection webuisshhostbrowseapi.Conn,
	subDir string,
	maxOutputBytes int,
) (webuisshhostbrowseapi.DirectoryResult, error) {
	if strings.TrimSpace(connection.EgressConnectionID) != "" && connection.Jump == nil {
		return webuisshhostbrowseapi.DirectoryResult{}, &webuisshhostbrowseapi.RemoteFailure{
			Code:    "ssh_egress_unresolved",
			Message: "该连接的出口连接不存在或跳板链无效。",
		}
	}
	client, err := sshremote.Dial(ctx, configFor(connection, runner.HomeDir), 0)
	if err != nil {
		return webuisshhostbrowseapi.DirectoryResult{}, translate(err)
	}
	defer func() { _ = client.Close() }()

	if strings.HasPrefix(subDir, "/") && !sshhost.IsWindowsPath(subDir) {
		cleanDir := path.Clean(subDir)
		return runPOSIXListing(ctx, client, cleanDir, maxOutputBytes)
	}

	probe, err := client.Run(ctx, detectAndHomeCommand, 64*1024)
	if err != nil {
		return webuisshhostbrowseapi.DirectoryResult{}, translate(err)
	}
	dialect, home, ok := parseDetectAndHome(string(probe.Stdout))
	if !ok {
		return webuisshhostbrowseapi.DirectoryResult{}, &webuisshhostbrowseapi.RemoteFailure{
			Code:    "remote_io_error",
			Message: "无法识别远端操作系统或读取用户家目录。",
		}
	}
	if dialect == sshhost.DialectPOSIX && strings.TrimSpace(home) == "" {
		home = "/"
	}
	currentDir := sshhost.ResolveBrowsePath(subDir, home, dialect)
	if dialect == sshhost.DialectPowerShell {
		return runPowerShellListing(ctx, client, currentDir, maxOutputBytes)
	}
	cleanDir := path.Clean(currentDir)
	if !strings.HasPrefix(cleanDir, "/") {
		cleanDir = "/"
	}
	return runPOSIXListing(ctx, client, cleanDir, maxOutputBytes)
}

func runPOSIXListing(
	ctx context.Context,
	client *sshremote.Client,
	directory string,
	maxOutputBytes int,
) (webuisshhostbrowseapi.DirectoryResult, error) {
	result, err := client.RunArgv(ctx, webuisshhostbrowseapi.ListArgv(directory), maxOutputBytes+1)
	if err != nil {
		return webuisshhostbrowseapi.DirectoryResult{}, translate(err)
	}
	if result.Code != 0 {
		cause := sshhost.ClassifyBrowseFailure(result.Code, string(result.Stderr))
		return webuisshhostbrowseapi.DirectoryResult{}, &webuisshhostbrowseapi.RemoteFailure{Code: cause.Code, Message: cause.Message}
	}
	stdout := result.Stdout
	truncated := false
	if maxOutputBytes > 0 && len(stdout) > maxOutputBytes {
		stdout = webuisshhostbrowseapi.TruncateAtLine(stdout, maxOutputBytes)
		truncated = true
	}
	entries := webuisshhostbrowseapi.ParseListing(string(stdout), directory)
	directories := make([]webuisshhostbrowseapi.Directory, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDirectory {
			directories = append(directories, webuisshhostbrowseapi.Directory{Name: entry.Name, Path: entry.Path})
		}
	}
	return webuisshhostbrowseapi.DirectoryResult{
		CurrentDir:  directory,
		ParentDir:   webuisshhostbrowseapi.ParentRemotePath(directory),
		Entries:     entries,
		Directories: directories,
		Truncated:   truncated,
	}, nil
}

func runPowerShellListing(
	ctx context.Context,
	client *sshremote.Client,
	directory string,
	maxOutputBytes int,
) (webuisshhostbrowseapi.DirectoryResult, error) {
	result, err := client.Run(ctx, sshhost.ListDirCommand(sshhost.DialectPowerShell, directory), maxOutputBytes+1)
	if err != nil {
		return webuisshhostbrowseapi.DirectoryResult{}, translate(err)
	}
	if result.Code != 0 {
		cause := sshhost.ClassifyBrowseFailure(result.Code, string(result.Stderr))
		return webuisshhostbrowseapi.DirectoryResult{}, &webuisshhostbrowseapi.RemoteFailure{Code: cause.Code, Message: cause.Message}
	}
	stdout := result.Stdout
	truncated := false
	if maxOutputBytes > 0 && len(stdout) > maxOutputBytes {
		stdout = webuisshhostbrowseapi.TruncateAtLine(stdout, maxOutputBytes)
		truncated = true
	}
	rawEntries := sshhost.ParseListDirOutput(string(stdout))
	entries := make([]webuisshhostbrowseapi.Entry, 0, len(rawEntries))
	directories := make([]webuisshhostbrowseapi.Directory, 0, len(rawEntries))
	for _, raw := range rawEntries {
		fullPath := sshhost.JoinRemotePath(directory, raw.Name, sshhost.DialectPowerShell)
		isDir := raw.Type == "d"
		entryType := raw.Type
		if entryType == "f" {
			entryType = "-"
		}
		var modified string
		if raw.Mtime > 0 {
			modified = strconv.FormatInt(raw.Mtime, 10)
		}
		entries = append(entries, webuisshhostbrowseapi.Entry{
			Name:        raw.Name,
			Path:        fullPath,
			Type:        entryType,
			IsDirectory: isDir,
			Size:        raw.Size,
			Modified:    modified,
		})
		if isDir {
			directories = append(directories, webuisshhostbrowseapi.Directory{Name: raw.Name, Path: fullPath})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	sort.SliceStable(directories, func(i, j int) bool { return directories[i].Name < directories[j].Name })
	return webuisshhostbrowseapi.DirectoryResult{
		CurrentDir:  directory,
		ParentDir:   sshhost.ParentRemotePath(directory, sshhost.DialectPowerShell),
		Entries:     entries,
		Directories: directories,
		Truncated:   truncated,
	}, nil
}

func parseDetectAndHome(stdout string) (dialect string, home string, ok bool) {
	lines := strings.Split(strings.ReplaceAll(stdout, "\r\n", "\n"), "\n")
	for idx, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "AIH_POSIX" {
			homeDir := ""
			if idx+1 < len(lines) {
				homeDir = strings.TrimSpace(lines[idx+1])
			}
			return sshhost.DialectPOSIX, homeDir, true
		}
		if line == "AIH_WINDOWS" {
			homeDir := ""
			if idx+1 < len(lines) {
				homeDir = strings.TrimSpace(lines[idx+1])
			}
			return sshhost.DialectPowerShell, homeDir, true
		}
	}
	return "", "", false
}

func configFor(connection webuisshhostbrowseapi.Conn, homeDir string) sshremote.Config {
	config := sshremote.Config{
		Host:         connection.Host,
		Port:         connection.Port,
		User:         connection.User,
		AuthType:     connection.AuthType,
		Password:     connection.Password,
		PrivateKey:   connection.PrivateKey,
		IdentityFile: connection.IdentityFile,
		HomeDir:      homeDir,
	}
	if connection.Jump != nil {
		jump := configFor(*connection.Jump, homeDir)
		config.Jump = &jump
	}
	return config
}

var identityMessages = map[string]string{
	sshhost.IdentityFileRequired:           "SSH identity file path is required.",
	sshhost.IdentityFileMustBeAbsolute:     "SSH identity file path must be absolute or start with ~/.",
	sshhost.IdentityFileOutsideSSHDir:      "SSH identity file must be inside the current server user SSH directory.",
	sshhost.IdentityFileNotFound:           "SSH identity file was not found.",
	sshhost.IdentityFileNotRegularFile:     "SSH identity file must be a regular file.",
	sshhost.IdentityFilePermissionsTooOpen: "SSH identity file permissions must not allow group or other access.",
}

func translate(err error) error {
	var remoteError *sshremote.Error
	if errors.As(err, &remoteError) && remoteError != nil {
		var idErr *sshhost.IdentityFileError
		if errors.As(remoteError.Err, &idErr) && idErr != nil {
			msg := identityMessages[idErr.Code]
			if msg == "" {
				msg = remoteError.Message
			}
			return &webuisshhostbrowseapi.RemoteFailure{
				Code:    "invalid_identity_file",
				Reason:  idErr.Code,
				Message: msg,
			}
		}
		return &webuisshhostbrowseapi.RemoteFailure{Code: remoteError.Code, Message: remoteError.Message}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return &webuisshhostbrowseapi.RemoteFailure{Code: "ssh_timeout", Message: "读取远端目录超时。"}
	}
	return &webuisshhostbrowseapi.RemoteFailure{Code: "remote_execution_failed", Message: err.Error()}
}
