package aihserver

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/webuialiaspoolapi"
)

// accountAliasPoolWriter 把 OAuth 新增账号的别名选号偏好写到 aih.db 的 app_kv。
//
// 写入口径与 WebUI 的 alias-pool 路由一致（account:alias-pool:<ref>）；
// 只有显式「不参与」才会写记录，默认参与由读取端缺省值表达。
type accountAliasPoolWriter struct {
	source *webuialiaspoolapi.Source
}

func newAccountAliasPoolWriter(aiHomeDir string) accountauth.AliasPoolWriter {
	source, err := webuialiaspoolapi.OpenSource(aiHomeDir)
	if err != nil || source == nil {
		return nil
	}
	return accountAliasPoolWriter{source: source}
}

func (writer accountAliasPoolWriter) SetAliasPoolParticipation(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	participates bool,
	updatedAt time.Time,
) error {
	if writer.source == nil {
		return nil
	}
	return writer.source.WriteParticipation(
		ctx,
		string(accountRef),
		participates,
		updatedAt.UnixMilli(),
	)
}
