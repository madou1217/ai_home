package webuisshhostbrowseapi

import (
	"bytes"
	"path"
	"sort"
	"strconv"
	"strings"
)

// Entry 是远端目录里的一项。
type Entry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	// Type 是 ls 首列的类型字符：d 目录、f 普通文件、l 符号链接，其余原样保留。
	Type string `json:"type"`
	// Permissions 是 9 位权限位，例如 rwxr-xr-x。
	Permissions string `json:"permissions"`
	Size        int64  `json:"size"`
	// Modified 是远端 ls 的时间文本（例如 "Nov 10 12:34"），不猜测时区与年份。
	Modified string `json:"modified"`
}

// Directory 是 Node 契约里的目录项，只含目录。
type Directory struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// pathError 是路径校验失败，消息直接作为 400 的 message。
type pathError struct {
	message string
}

// Error 实现 error。
func (err *pathError) Error() string {
	if err == nil {
		return ""
	}
	return err.message
}

// normalizeRemotePath 校验并规范化远端路径：必须是绝对路径，不含 NUL / 换行，且没有 .. 段。
//
// 先拒绝 .. 再交给 path.Clean，避免 Clean 把 "/a/../b" 悄悄折成 "/b"。
func normalizeRemotePath(raw string) (string, error) {
	// 先查控制字符再裁剪：TrimSpace 会把末尾换行吞掉，正好绕过这条校验。
	if strings.ContainsAny(raw, "\x00\n\r") {
		return "", &pathError{message: "远端路径不能包含 NUL 或换行字符。"}
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", &pathError{message: "远端路径不能为空。"}
	}
	if len(trimmed) > maxRemotePathBytes {
		return "", &pathError{message: "远端路径过长。"}
	}
	if !strings.HasPrefix(trimmed, "/") {
		return "", &pathError{message: "远端路径必须是绝对路径。"}
	}
	for _, segment := range strings.Split(trimmed, "/") {
		if segment == ".." {
			return "", &pathError{message: "远端路径不能包含 .. 段。"}
		}
	}
	return path.Clean(trimmed), nil
}

// parentRemotePath 返回 POSIX 路径的上一级；根目录的上一级仍是根。
func parentRemotePath(directory string) string {
	if directory == "" || directory == "/" {
		return "/"
	}
	trimmed := strings.TrimRight(directory, "/")
	index := strings.LastIndex(trimmed, "/")
	if index <= 0 {
		return "/"
	}
	return trimmed[:index]
}

// joinRemotePath 拼接 POSIX 远端路径。
func joinRemotePath(base, name string) string {
	root := strings.TrimRight(base, "/")
	if root == "" {
		return "/" + name
	}
	return root + "/" + name
}

// listArgv 构造列目录命令。路径是独立的 argv 元素，不参与任何字符串拼接。
//
// 末尾补 / 让 ls 只接受目录：路径指向普通文件时远端会报错，而不是把文件自身列出来。
func listArgv(directory string) []string {
	target := directory
	if !strings.HasSuffix(target, "/") {
		target += "/"
	}
	return []string{"ls", "-lA", "--", target}
}

// truncateAtLine 在 limit 处截断，并丢掉末尾不完整的行，避免解析出半个条目。
func truncateAtLine(output []byte, limit int) []byte {
	if len(output) <= limit {
		return output
	}
	output = output[:limit]
	index := bytes.LastIndexByte(output, '\n')
	if index < 0 {
		return nil
	}
	return output[:index+1]
}

// parseListing 解析 `ls -lA` 的输出。
//
// 每行固定 8 列（权限、链接数、属主、属组、大小、月、日、时间/年份）之后才是名字；
// 设备文件的「大小」占两列（如 "1, 3"），此时名字从第 10 列开始。
func parseListing(stdout string, directory string) []Entry {
	entries := make([]Entry, 0)
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line == "" || strings.HasPrefix(line, "total ") {
			continue
		}
		entry, ok := parseListingLine(line)
		if !ok {
			continue
		}
		entry.Path = joinRemotePath(directory, entry.Name)
		entries = append(entries, entry)
	}
	sort.SliceStable(entries, func(left, right int) bool {
		return entries[left].Name < entries[right].Name
	})
	return entries
}

// parseListingLine 解析一行 ls -l 输出；列数不足或类型位异常的行走丢弃。
func parseListingLine(line string) (Entry, bool) {
	fields := strings.Fields(line)
	if len(fields) < 9 {
		return Entry{}, false
	}
	mode := fields[0]
	if len(mode) < 10 {
		return Entry{}, false
	}
	nameIndex := 8
	if strings.HasSuffix(fields[4], ",") {
		nameIndex = 9
	}
	if len(fields) <= nameIndex {
		return Entry{}, false
	}
	name := strings.Join(fields[nameIndex:], " ")
	if index := strings.Index(name, " -> "); index >= 0 {
		name = name[:index]
	}
	if name == "" || name == "." || name == ".." {
		return Entry{}, false
	}
	entry := Entry{
		Name:        name,
		Type:        string(mode[0]),
		Permissions: mode[1:10],
		Modified:    strings.Join(fields[nameIndex-3:nameIndex], " "),
	}
	if nameIndex == 8 {
		entry.Size = parseSize(fields[4])
	}
	entry.IsDirectory = entry.Type == "d"
	return entry, true
}

func parseSize(value string) int64 {
	size, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return 0
	}
	return size
}
