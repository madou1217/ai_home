package sshhost

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// KeyFileAuthType 是「用服务器本机已有的私钥文件认证」的认证方式标识。
const KeyFileAuthType = "key-file"

// 身份文件错误码，与 Node 的 SshIdentityFileError.code 一一对应。
const (
	IdentityFileRequired           = "identity_file_required"
	IdentityFileMustBeAbsolute     = "identity_file_must_be_absolute"
	IdentityFileOutsideSSHDir      = "identity_file_outside_ssh_dir"
	IdentityFileNotFound           = "identity_file_not_found"
	IdentityFileNotRegularFile     = "identity_file_not_regular_file"
	IdentityFilePermissionsTooOpen = "identity_file_permissions_too_open"
)

// IdentityFileError 是身份文件校验失败的结构化错误。
type IdentityFileError struct {
	Code string
}

func (err *IdentityFileError) Error() string {
	if err == nil {
		return ""
	}
	return err.Code
}

// IdentityFS 是身份文件校验所需的文件系统子集。
type IdentityFS interface {
	EvalSymlinks(path string) (string, error)
	Stat(name string) (os.FileInfo, error)
}

// IdentityOptions 收拢可注入的宿主依赖；零值使用当前用户家目录与当前平台。
type IdentityOptions struct {
	HomeDir  string
	Platform string
	FS       IdentityFS
}

type osIdentityFS struct{}

func (osIdentityFS) EvalSymlinks(path string) (string, error) { return filepath.EvalSymlinks(path) }

func (osIdentityFS) Stat(name string) (os.FileInfo, error) { return os.Stat(name) }

// ResolveIdentityFilePath 校验并返回私钥文件的真实路径。
//
// 规则与 Node 实现一致：路径必须绝对（支持 ~ 与 ~/ 展开）、必须位于当前用户的 ~/.ssh 内
// （软链接按真实路径再判一次）、必须是普通文件，Unix 上权限不得对组或其他用户开放。
func ResolveIdentityFilePath(value string, options IdentityOptions) (string, error) {
	homeDir := strings.TrimSpace(options.HomeDir)
	if homeDir == "" {
		resolved, err := os.UserHomeDir()
		if err != nil {
			return "", &IdentityFileError{Code: IdentityFileNotFound}
		}
		homeDir = resolved
	}
	absoluteHome, err := filepath.Abs(homeDir)
	if err != nil {
		return "", &IdentityFileError{Code: IdentityFileNotFound}
	}

	input := strings.TrimSpace(value)
	if input == "" {
		return "", &IdentityFileError{Code: IdentityFileRequired}
	}
	expanded := input
	switch {
	case input == "~":
		expanded = absoluteHome
	case strings.HasPrefix(input, "~/"):
		expanded = filepath.Join(absoluteHome, input[2:])
	}
	if !filepath.IsAbs(expanded) {
		return "", &IdentityFileError{Code: IdentityFileMustBeAbsolute}
	}

	sshDir := filepath.Join(absoluteHome, ".ssh")
	candidate, err := filepath.Abs(expanded)
	if err != nil {
		return "", &IdentityFileError{Code: IdentityFileMustBeAbsolute}
	}
	if !isPathInside(sshDir, candidate) {
		return "", &IdentityFileError{Code: IdentityFileOutsideSSHDir}
	}

	fsImpl := options.FS
	if fsImpl == nil {
		fsImpl = osIdentityFS{}
	}
	realSSHDir, err := fsImpl.EvalSymlinks(sshDir)
	if err != nil {
		return "", &IdentityFileError{Code: IdentityFileNotFound}
	}
	realIdentityFile, err := fsImpl.EvalSymlinks(candidate)
	if err != nil {
		return "", &IdentityFileError{Code: IdentityFileNotFound}
	}
	if !isPathInside(realSSHDir, realIdentityFile) {
		return "", &IdentityFileError{Code: IdentityFileOutsideSSHDir}
	}

	info, err := fsImpl.Stat(realIdentityFile)
	if err != nil {
		return "", &IdentityFileError{Code: IdentityFileNotFound}
	}
	if !info.Mode().IsRegular() {
		return "", &IdentityFileError{Code: IdentityFileNotRegularFile}
	}
	platform := options.Platform
	if platform == "" {
		platform = runtime.GOOS
	}
	if platform != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", &IdentityFileError{Code: IdentityFilePermissionsTooOpen}
	}
	return realIdentityFile, nil
}

// AsIdentityFileError 便于调用方用 errors.As 取出错误码。
func AsIdentityFileError(err error) (*IdentityFileError, bool) {
	var identityErr *IdentityFileError
	if errors.As(err, &identityErr) {
		return identityErr, true
	}
	return nil, false
}

// isPathInside 判断 candidate 是否等于 parent 或位于其下（不跟随软链接，调用方先求真实路径）。
func isPathInside(parentDir, candidate string) bool {
	relative, err := filepath.Rel(parentDir, candidate)
	if err != nil {
		return false
	}
	if relative == "." {
		return true
	}
	return !strings.HasPrefix(relative, "..") && !filepath.IsAbs(relative)
}
