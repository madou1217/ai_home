// Package sqlitex 收敛进程内 SQLite 连接的统一打开策略。
//
// 历史包袱是每个包各自拼 DSN：同样的 mode=ro / query_only / busy_timeout
// 至少有四份副本，页缓存大小也没有约束（SQLite 默认每连接 2MB）。
// 这里只做一件事：给出**唯一**的 DSN 构造口径，读侧用更小的页缓存，
// 让「几十个连接各自 2MB 缓存」这种隐性开销降到可控。
package sqlitex

import (
	"net/url"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

const (
	// DefaultBusyTimeoutMS 是缺省忙等窗口；写侧与扫描侧都用它。
	DefaultBusyTimeoutMS = 5000
	// readOnlyCacheKiB 是只读连接的页缓存上限（负值表示 KiB）。
	// 读侧都是点查/索引扫描，不需要默认的 2MB 全页缓存。
	readOnlyCacheKiB = 512
	// writableCacheKiB 给写侧留足缓存，避免热点页反复回读。
	writableCacheKiB = 4096
)

// ReadOnlyDSN 返回只读库的 DSN：mode=ro + query_only + 小页缓存。
func ReadOnlyDSN(databasePath string) string {
	return ReadOnlyDSNWithBusyTimeout(databasePath, DefaultBusyTimeoutMS)
}

// ReadOnlyDSNWithBusyTimeout 允许调用方指定忙等窗口（保留各子系统既有超时语义）。
func ReadOnlyDSNWithBusyTimeout(databasePath string, busyTimeoutMS int) string {
	if busyTimeoutMS <= 0 {
		busyTimeoutMS = DefaultBusyTimeoutMS
	}
	fileURL := sqlitefile.URL(filepath.Clean(databasePath))
	query := url.Values{}
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout("+itoa(busyTimeoutMS)+")")
	query.Add("_pragma", "cache_size(-"+itoa(readOnlyCacheKiB)+")")
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

// WritableDSN 返回读写库的 DSN：默认忙等 + 较大的页缓存。
func WritableDSN(databasePath string) string {
	fileURL := sqlitefile.URL(filepath.Clean(databasePath))
	query := fileURL.Query()
	query.Add("_pragma", "busy_timeout("+itoa(DefaultBusyTimeoutMS)+")")
	query.Add("_pragma", "cache_size(-"+itoa(writableCacheKiB)+")")
	query.Add("_pragma", "journal_mode(WAL)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	if negative {
		index--
		digits[index] = '-'
	}
	return string(digits[index:])
}
