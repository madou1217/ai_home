// Package cliproxyapi 把账号应用快照编码为 CLIProxyAPI 官方单 auth JSON 文件。
//
// 该包不生成批量 envelope，不输出 AIH 本地身份，也不把 API Key 配置伪装成 auth 文件。
package cliproxyapi

import (
	"context"
	"encoding/json"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ErrInvalidDependencies 表示导出器缺少账号快照读取端口。
var ErrInvalidDependencies = errors.New("CLIProxyAPI 导出依赖无效")

// SnapshotReader 是外部编码器读取单账号一致快照的应用端口。
type SnapshotReader interface {
	// ReadAccountExport 返回不含模型、usage 和运行态的账号导出快照。
	ReadAccountExport(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.ExportSnapshot, error)
}

// credentialStrategy 把一个 Provider 的领域凭据映射为官方 auth 文件。
type credentialStrategy interface {
	encode(snapshot accountapp.ExportSnapshot) (any, error)
}

// Exporter 通过封闭 Provider 策略生成一个 CLIProxyAPI auth JSON 文件。
type Exporter struct {
	reader     SnapshotReader
	strategies map[string]credentialStrategy
}

// NewExporter 创建只支持 Codex 与 Claude 可刷新 OAuth 的导出器。
func NewExporter(reader SnapshotReader) (*Exporter, error) {
	if reader == nil {
		return nil, ErrInvalidDependencies
	}
	return &Exporter{
		reader: reader,
		strategies: map[string]credentialStrategy{
			"codex":  codexStrategy{},
			"claude": claudeStrategy{},
		},
	}, nil
}

// ExportAccount 输出可直接放入 CLIProxyAPI auth-dir 的单账号 JSON。
func (exporter *Exporter) ExportAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]byte, error) {
	if exporter == nil || exporter.reader == nil {
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
	document, err := strategy.encode(snapshot)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, accountapp.ErrInvalidAccountExport
	}
	return encoded, nil
}
