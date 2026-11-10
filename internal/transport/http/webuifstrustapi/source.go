package webuifstrustapi

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/webuifile"
)

// trustedRootsKey 与 Node 的 WEBUI_FILE_TRUSTED_ROOTS_KEY 完全一致。
const trustedRootsKey = "webui-file-trusted-roots"

// storedTrustedRoot 是 app-state 里的元素形状，字段名与 Node 的
// { path, trustedAt } 逐字一致；不能直接序列化 webuifile.TrustedRoot。
type storedTrustedRoot struct {
	Path      string `json:"path"`
	TrustedAt int64  `json:"trustedAt"`
}

// Source 通过 app-state.db 读写可信目录。
type Source struct {
	databasePath string
}

// OpenSource 创建可信目录数据源。
func OpenSource(aiHomeDir string) (*Source, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Source{databasePath: path}, nil
}

// ReadTrustedRoots 读取并归一化可信目录。
//
// 与 Node readJsonValue 的默认语义一致：库/行/JSON 读取失败都当作没有配置，
// 单条坏记录跳过而不是让整个列表失效。
func (source *Source) ReadTrustedRoots(ctx context.Context) ([]webuifile.TrustedRoot, error) {
	if source == nil {
		return nil, nil
	}
	raw, found, err := appstate.ReadKV(ctx, source.databasePath, trustedRootsKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var entries []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &entries); err != nil {
		return nil, nil
	}
	roots := make([]webuifile.TrustedRoot, 0, len(entries))
	for _, entry := range entries {
		var stored storedTrustedRoot
		if err := json.Unmarshal(entry, &stored); err != nil {
			continue
		}
		roots = append(roots, webuifile.TrustedRoot{Path: stored.Path, TrustedAt: stored.TrustedAt})
	}
	return webuifile.NormalizeTrustedRoots(roots), nil
}

// WriteTrustedRoots 以 Node 的数组形状整份覆盖 webui-file-trusted-roots。
func (source *Source) WriteTrustedRoots(ctx context.Context, roots []webuifile.TrustedRoot) error {
	if source == nil {
		return nil
	}
	normalized := webuifile.NormalizeTrustedRoots(roots)
	stored := make([]storedTrustedRoot, 0, len(normalized))
	for _, entry := range normalized {
		stored = append(stored, storedTrustedRoot{Path: entry.Path, TrustedAt: entry.TrustedAt})
	}
	payload, err := json.Marshal(stored)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, source.databasePath, trustedRootsKey, string(payload), time.Now().UnixMilli())
}
