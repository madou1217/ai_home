package sshremote

import (
	"context"
	"path"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
)

const (
	// maxListOutputBytes 与 Node 浏览接口的 2MB 上限一致。
	maxListOutputBytes = 2 << 20
	maxRemotePathBytes = 4096
)

// Entry 是远端目录里的一项；Path 已拼成 POSIX 绝对路径。
type Entry struct {
	Name string
	Path string
	// Type 是 d / f / l。
	Type string
	Size int64
	// Modified 是远端 mtime；远端没有提供时为 time.Time{}。
	Modified time.Time
}

// DirectoryList 是一次列目录的结果。
type DirectoryList struct {
	Entries   []Entry
	Truncated bool
}

// ListDirectory 列出一个 POSIX 远端目录（含普通文件与符号链接）。
//
// 命令与解析复用 sshhost：远端产出 type/size/mtime/name 四列，避免解析
// ls -l 的本地化文本；路径始终作为独立统计目标传入。
func (client *Client) ListDirectory(ctx context.Context, directory string) (DirectoryList, error) {
	normalized, err := normalizeRemoteDirectory(directory)
	if err != nil {
		return DirectoryList{}, err
	}
	result, err := client.Run(ctx, sshhost.ListDirCommand(sshhost.DialectPOSIX, normalized), maxListOutputBytes)
	if err != nil {
		return DirectoryList{}, err
	}
	if result.Code != 0 {
		cause := sshhost.ClassifyBrowseFailure(result.Code, string(result.Stderr))
		return DirectoryList{}, newError(cause.Code, cause.Message, nil)
	}
	entries := make([]Entry, 0)
	for _, item := range sshhost.ParseListDirOutput(string(result.Stdout)) {
		entry := Entry{
			Name: item.Name,
			Path: sshhost.JoinRemotePath(normalized, item.Name, sshhost.DialectPOSIX),
			Type: item.Type,
			Size: item.Size,
		}
		if item.Mtime > 0 {
			entry.Modified = time.Unix(item.Mtime, 0)
		}
		entries = append(entries, entry)
	}
	return DirectoryList{Entries: entries, Truncated: result.Truncated}, nil
}

// normalizeRemoteDirectory 校验并归一路径：必须是绝对路径，不含 NUL / 换行 / .. 段。
func normalizeRemoteDirectory(raw string) (string, error) {
	if strings.ContainsAny(raw, "\x00\n\r") {
		return "", newError(CodeInvalidPath, "远端路径不能包含 NUL 或换行字符", nil)
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", newError(CodeInvalidPath, "远端路径不能为空", nil)
	}
	if len(trimmed) > maxRemotePathBytes {
		return "", newError(CodeInvalidPath, "远端路径过长", nil)
	}
	if !strings.HasPrefix(trimmed, "/") {
		return "", newError(CodeInvalidPath, "远端路径必须是绝对路径", nil)
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." {
			return "", newError(CodeInvalidPath, "远端路径不能包含 .. 段", nil)
		}
	}
	return path.Clean(trimmed), nil
}
