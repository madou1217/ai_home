package aihserver

import (
	"context"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// moveAccountEgressBinding 把账号级出口绑定从旧引用搬到新引用。
//
// 出口键按 AccountRef 命名（Node 的 account:egress:<ref>）；re-key 后旧键
// 变成孤儿、新引用失去出口设置。键是 Node 写的格式，这里只做整值搬家，
// 不改内容。键不存在视为未绑定。
func moveAccountEgressBinding(
	aiHomeDir string,
	previous accountcore.AccountRef,
	current accountcore.AccountRef,
) error {
	if aiHomeDir == "" || !previous.IsValid() || !current.IsValid() ||
		previous == current {
		return nil
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	ctx := context.Background()
	previousKey := "account:egress:" + previous.String()
	raw, found, err := appstate.ReadKV(ctx, databasePath, previousKey)
	if err != nil || !found {
		return err
	}
	if err := appstate.WriteKV(
		ctx,
		databasePath,
		"account:egress:"+current.String(),
		raw,
		time.Now().UnixMilli(),
	); err != nil {
		return err
	}
	return appstate.DeleteKV(ctx, databasePath, previousKey)
}
