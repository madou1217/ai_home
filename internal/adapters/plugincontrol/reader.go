// Package plugincontrol 是 Node 插件控制状态的只读适配器。
//
// 插件安装、实例启停与 revision CAS 的唯一 owner 仍是 Node：状态存在
// app-state.db 的 app_kv/plugins.control.v1 里，启用还要经过宿主 prepare 与
// 代次激活。Go 只能读这份事实，用于管理面列表与投影一致性诊断——本适配器
// 以 SQLite 只读模式打开数据库，绝不建库、建表或写回。
package plugincontrol

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
)

const (
	// AppStateDatabaseFileName 是 Node 运行态数据库的固定文件名。
	AppStateDatabaseFileName = "app-state.db"
	databaseBusyTimeoutMS    = 5000
)

var (
	// ErrInvalidOptions 表示缺少 AIH 数据根目录。
	ErrInvalidOptions = errors.New("插件控制状态读取配置无效")
)

// Reader 从 Node 的 app-state.db 读取插件控制状态。
type Reader struct {
	databasePath string
}

// NewReader 创建只读读取器；不要求数据库已存在（全新数据根返回空列表）。
func NewReader(aiHomeDir string) (*Reader, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, ErrInvalidOptions
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, ErrInvalidOptions
	}
	return &Reader{databasePath: filepath.Join(absolute, AppStateDatabaseFileName)}, nil
}

// DatabasePath 返回目标数据库的绝对路径（只用于诊断，不用于写入）。
func (reader *Reader) DatabasePath() string {
	if reader == nil {
		return ""
	}
	return reader.databasePath
}

// ReadControlState 读取 plugins.control.v1。
//
// 数据库或表不存在按空状态处理：这与 Node 在全新数据根上的表现一致；
// 只有“数据库存在但读不出来”才返回 ErrControlStateUnavailable。
func (reader *Reader) ReadControlState(ctx context.Context) (pluginruntime.ControlState, error) {
	if reader == nil || reader.databasePath == "" || ctx == nil {
		return pluginruntime.ControlState{}, pluginruntime.ErrControlStateUnavailable
	}
	info, err := os.Stat(reader.databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return emptyControlState(), nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return pluginruntime.ControlState{}, fmt.Errorf("%w: 无法确认数据库文件", pluginruntime.ErrControlStateUnavailable)
	}

	db, err := openReadOnly(ctx, reader.databasePath)
	if err != nil {
		return pluginruntime.ControlState{}, fmt.Errorf("%w: %v", pluginruntime.ErrControlStateUnavailable, err)
	}
	defer func() { _ = db.Close() }()

	present, err := hasAppKVTable(ctx, db)
	if err != nil {
		return pluginruntime.ControlState{}, fmt.Errorf("%w: %v", pluginruntime.ErrControlStateUnavailable, err)
	}
	if !present {
		return emptyControlState(), nil
	}

	var value string
	err = db.QueryRowContext(ctx,
		`SELECT value FROM app_kv WHERE key = ?`, pluginruntime.ControlStateKey,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return emptyControlState(), nil
	}
	if err != nil {
		return pluginruntime.ControlState{}, fmt.Errorf("%w: %v", pluginruntime.ErrControlStateUnavailable, err)
	}
	if len(value) > pluginruntime.MaxControlStateBytes {
		return pluginruntime.ControlState{}, pluginruntime.ErrControlStateInvalid
	}
	state, err := pluginruntime.DecodeControlState([]byte(value))
	if err != nil {
		return pluginruntime.ControlState{}, err
	}
	return state, nil
}

func emptyControlState() pluginruntime.ControlState {
	return pluginruntime.ControlState{SchemaVersion: 1}.Normalize()
}

func hasAppKVTable(ctx context.Context, db *sql.DB) (bool, error) {
	var count int
	if err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_kv'`,
	).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// openReadOnly 打开普通只读连接（mode=ro），绝不使用 immutable=1。
//
// immutable 会忽略 WAL：只要 Node 或 Go 的写者还持有未合并的 WAL，读到的就是
// 过期快照。列表必须看到刚提交的 revision，因此宁可让这次读取失败（上层 503），
// 也不返回旧状态。
func openReadOnly(ctx context.Context, databasePath string) (*sql.DB, error) {
	return openAndPing(ctx, databasePath)
}

func openAndPing(ctx context.Context, databasePath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", buildReadOnlyDSN(databasePath))
	if err != nil {
		return nil, err
	}
	// 单连接：只读快照不跨语句变化，省掉连接池的额外句柄。
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

func buildReadOnlyDSN(databasePath string) string {
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", databaseBusyTimeoutMS))
	// query_only 是第二道保险：即使驱动忽略 mode=ro，也不允许本连接写入。
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
