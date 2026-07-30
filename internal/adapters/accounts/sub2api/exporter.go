// Package sub2api 把账号应用快照编码为现行 sub2api-data 外部合同。
//
// 该包不读取数据库、不刷新凭据、不访问 Provider，也不兼容历史 AIH 私有格式。
package sub2api

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidDependencies 表示导出器缺少快照读取器或业务时钟。
var ErrInvalidDependencies = errors.New("sub2api 导出依赖无效")

// SnapshotReader 是外部编码器读取单账号一致快照的应用端口。
type SnapshotReader interface {
	// ReadAccountExport 返回不含模型、usage 和运行态的账号导出快照。
	ReadAccountExport(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.ExportSnapshot, error)
}

// Clock 返回导出文档的生成时间。
type Clock func() time.Time

// credentialStrategy 把一个 Provider 的领域凭据映射为账号文档。
type credentialStrategy interface {
	encode(snapshot accountapp.ExportSnapshot) (accountDocument, error)
}

// Exporter 选择固定 Provider 策略并生成单账号 JSON 文档。
type Exporter struct {
	reader     SnapshotReader
	clock      Clock
	strategies map[string]credentialStrategy
}

// NewExporter 创建只支持 Codex 和 Claude 的标准导出器。
func NewExporter(reader SnapshotReader, clock Clock) (*Exporter, error) {
	if reader == nil || clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Exporter{
		reader: reader,
		clock:  clock,
		strategies: map[string]credentialStrategy{
			"codex":  codexStrategy{},
			"claude": claudeStrategy{},
		},
	}, nil
}

// ExportAccount 读取一个账号并输出无本地身份、无格式版本的 sub2api-data JSON。
func (exporter *Exporter) ExportAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	if exporter == nil ||
		exporter.reader == nil ||
		exporter.clock == nil {
		return nil, ErrInvalidDependencies
	}
	snapshot, err := exporter.reader.ReadAccountExport(ctx, accountRef)
	if err != nil {
		return nil, err
	}
	strategy, supported := exporter.strategies[snapshot.Account().ProviderID()]
	if !supported {
		return nil, accountapp.ErrUnsupportedAccountExport
	}
	account, err := strategy.encode(snapshot)
	if err != nil {
		return nil, err
	}
	exportedAt := exporter.clock().UTC()
	if exportedAt.IsZero() {
		return nil, accountapp.ErrInvalidAccountExport
	}
	document := exportDocument{
		Type:       dataType,
		ExportedAt: exportedAt.Format(time.RFC3339Nano),
		Proxies:    []proxyDocument{},
		Accounts:   []accountDocument{account},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, accountapp.ErrInvalidAccountExport
	}
	return encoded, nil
}
