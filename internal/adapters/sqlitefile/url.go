// Package sqlitefile 统一构造 SQLite 的 file: DSN。
//
// Windows 盘符路径（C:\dir\x.db）必须先转成 /C:/dir/x.db 再放进 URL，
// 否则 url.URL 会把 "C:" 当成 host，驱动收到非法文件地址（表现为
// "out of memory (1)" 之类的误导错误）。
package sqlitefile

import (
	"net/url"
	"path/filepath"
	"strings"
)

// Path 返回适合拼进 file: DSN 的路径（Windows 盘符前补 /）。
func Path(databasePath string) string {
	slash := filepath.ToSlash(strings.TrimSpace(databasePath))
	if len(slash) >= 2 && slash[1] == ':' && slash[0] != '/' {
		slash = "/" + slash
	}
	return slash
}

// URL 返回 SQLite 驱动可用的 file: 地址。
func URL(databasePath string) *url.URL {
	return &url.URL{Scheme: "file", Path: Path(databasePath)}
}
