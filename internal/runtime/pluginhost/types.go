package pluginhost

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/internal/adapters/accountmaintenance"
	"github.com/madou1217/ai_home/internal/adapters/pluginstatestore"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

// PluginSpec 描述一次候选代次里待加载的单个插件实例规格。
type PluginSpec struct {
	InstanceID    string         `json:"instanceId"`
	PluginID      string         `json:"-"`
	Version       string         `json:"-"`
	EntryPath     string         `json:"entryPath"`
	Manifest      map[string]any `json:"manifest"`
	Configuration map[string]any `json:"configuration"`
}

// PrepareDiagnostic 描述依赖规划或宿主准备阶段的失败诊断项。
type PrepareDiagnostic struct {
	Code           string   `json:"code"`
	Detail         string   `json:"detail"`
	InstanceID     string   `json:"instanceId,omitempty"`
	PluginID       string   `json:"pluginId,omitempty"`
	ContributionID string   `json:"contributionId,omitempty"`
	Service        string   `json:"service,omitempty"`
	Cycle          []string `json:"cycle,omitempty"`
	Services       []string `json:"services,omitempty"`
}

// HostPrepareResult 对应 Plugin Host `prepare` RPC 的返回。
type HostPrepareResult struct {
	Generation    int64               `json:"generation"`
	State         string              `json:"state"`
	Order         []string            `json:"order,omitempty"`
	Contributions []string            `json:"contributions,omitempty"`
	Diagnostics   []PrepareDiagnostic `json:"diagnostics,omitempty"`
	Errors        []HostErrorRecord   `json:"errors,omitempty"`
}

// HostActivateResult 对应 Plugin Host `activate` RPC 的返回。
type HostActivateResult struct {
	Generation int64  `json:"generation"`
	State      string `json:"state"`
	Previous   int64  `json:"previous"`
}

// HostDisposeResult 对应 Plugin Host `dispose` RPC 的返回。
type HostDisposeResult struct {
	Generation int64             `json:"generation"`
	State      string            `json:"state"`
	Errors     []HostErrorRecord `json:"errors,omitempty"`
}

// HostMemory 描述 Plugin Host 进程的内存读数。
type HostMemory struct {
	RSS      int64 `json:"rss"`
	HeapUsed int64 `json:"heapUsed"`
}

// HostErrorRecord 记录宿主内部在加载或运行中捕获的错误。
type HostErrorRecord struct {
	At         string `json:"at,omitempty"`
	InstanceID string `json:"instanceId,omitempty"`
	Phase      string `json:"phase,omitempty"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
}

// HostStatusResult 对应 Plugin Host `status` RPC 的返回。
type HostStatusResult struct {
	Memory           HostMemory        `json:"memory"`
	ActiveGeneration int64             `json:"activeGeneration"`
	Generations      []int64           `json:"generations"`
	Errors           []HostErrorRecord `json:"errors"`
}

// RuntimeState 是插件运行时服务的状态机枚举。
type RuntimeState string

const (
	StateIdle     RuntimeState = "idle"
	StateStarting RuntimeState = "starting"
	StateActive   RuntimeState = "active"
	StateDegraded RuntimeState = "degraded"
	StateStopping RuntimeState = "stopping"
	StateStopped  RuntimeState = "stopped"
)

// FailureRecord 记录宿主启动、崩溃或恢复过程中的故障（保留最近 20 条）。
type FailureRecord struct {
	At       string `json:"at"`
	Code     string `json:"code"`
	Message  string `json:"message,omitempty"`
	Detail   string `json:"detail,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Signal   string `json:"signal,omitempty"`
}

// RuntimeStatus 汇总插件运行时当前代次、租约与恢复状态。
type RuntimeStatus struct {
	State               RuntimeState        `json:"state"`
	Generation          int64               `json:"generation"`
	ActiveGeneration    int64               `json:"activeGeneration"`
	DesiredPlugins      int                 `json:"desiredPlugins"`
	HostPID             int                 `json:"hostPid,omitempty"`
	GenerationsOnHost   int                 `json:"generationsOnHost"`
	RetiringCount       int                 `json:"retiringCount"`
	ActiveLeases        int                 `json:"activeLeases"`
	ConsecutiveFailures int                 `json:"consecutiveFailures"`
	LastError           *FailureRecord      `json:"lastError,omitempty"`
	RecentFailures      []FailureRecord     `json:"recentFailures"`
	Diagnostics         []PrepareDiagnostic `json:"diagnostics,omitempty"`
	DescriptorErrors    []DescriptorError   `json:"providerDescriptorErrors,omitempty"`
	HostStatus          *HostStatusResult   `json:"host,omitempty"`
}

// DoctorIssue 描述插件控制面或运行时诊断出的问题或警告。
type DoctorIssue struct {
	Code        string              `json:"code"`
	PluginID    string              `json:"pluginId,omitempty"`
	InstanceID  string              `json:"instanceId,omitempty"`
	Detail      string              `json:"detail,omitempty"`
	Diagnostics []PrepareDiagnostic `json:"diagnostics,omitempty"`
}

// DoctorInstalledSummary 给出已安装插件摘要（不含敏感信息）。
type DoctorInstalledSummary struct {
	PluginID    string `json:"pluginId"`
	Version     string `json:"version"`
	Digest      string `json:"digest,omitempty"`
	Signature   any    `json:"signature"`
	Permissions any    `json:"permissions,omitempty"`
}

// DoctorReport 汇总插件控制面与运行时的静态和动态诊断。
type DoctorReport struct {
	OK                bool                     `json:"ok"`
	Revision          int64                    `json:"revision"`
	ControlStateError string                   `json:"controlStateError,omitempty"`
	Issues            []DoctorIssue            `json:"issues"`
	Warnings          []DoctorIssue            `json:"warnings"`
	Capabilities      map[string]int           `json:"capabilities"`
	Installed         []DoctorInstalledSummary `json:"installed"`
	Runtime           RuntimeStatus            `json:"runtime"`
}

// ControlStateReader 只读读取 app-state.db 中的 plugins.control.v1 原始 JSON。
type ControlStateReader interface {
	ReadRawControlState(ctx context.Context) ([]byte, error)
}

// SQLiteControlStateReader 从 <aiHomeDir>/app-state.db 只读获取控制状态原文。
type SQLiteControlStateReader struct {
	aiHomeDir    string
	databasePath string
}

// NewSQLiteControlStateReader 构造只读控制状态读取器。
func NewSQLiteControlStateReader(aiHomeDir string) (*SQLiteControlStateReader, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, pluginerr.New(CodeStateUnavailable, "缺少 aiHomeDir")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, pluginerr.New(CodeStateUnavailable, "")
	}
	return &SQLiteControlStateReader{
		aiHomeDir:    abs,
		databasePath: filepath.Join(abs, pluginstatestore.DatabaseFileName),
	}, nil
}

// ReadRawControlState 在维护读租约下读取 app_kv/plugins.control.v1 原文；
// 若数据库、app_kv 表或键尚不存在，返回 (nil, nil)，由调用方视场景按空状态或缺失处理。
func (reader *SQLiteControlStateReader) ReadRawControlState(ctx context.Context) ([]byte, error) {
	if reader == nil {
		return nil, pluginerr.New(CodeStateUnavailable, "")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	lease, err := accountmaintenance.Acquire(ctx, reader.aiHomeDir)
	if err != nil {
		return nil, err
	}
	defer lease.Close()
	if _, statErr := os.Stat(reader.databasePath); statErr != nil {
		if errors.Is(statErr, os.ErrNotExist) {
			return nil, nil
		}
		return nil, pluginerr.New(CodeStateUnavailable, statErr.Error())
	}
	dsn := fmt.Sprintf("file:%s?mode=ro", reader.databasePath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, pluginerr.New(CodeStateUnavailable, err.Error())
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	defer func() { _ = db.Close() }()

	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, pluginerr.New(CodeStateUnavailable, err.Error())
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout = 5000"); err != nil {
		return nil, pluginerr.New(CodeStateUnavailable, err.Error())
	}
	_, _ = conn.ExecContext(ctx, "PRAGMA query_only = ON")

	var tables int
	if err := conn.QueryRowContext(
		ctx,
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'app_kv'",
	).Scan(&tables); err != nil {
		return nil, pluginerr.New(CodeStateUnavailable, err.Error())
	}
	if tables == 0 {
		return nil, nil
	}

	var encoded string
	err = conn.QueryRowContext(
		ctx,
		"SELECT value FROM app_kv WHERE key = ?",
		pluginstatestore.ControlStateKey,
	).Scan(&encoded)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, pluginerr.New(CodeStateUnavailable, err.Error())
	default:
		return []byte(encoded), nil
	}
}
