// Package credentialregister 把已解码的原生凭据写入账号库。
//
// 家族登录（internal/host/aihlogin）与通用 CLI 登录（internal/host/clilogin）
// 共用这一条注册路径：同一身份走原子凭据替换，新身份注册并分配 CLI 序号。
// notice 只输出「登录成功」提示，不包含任何凭据内容。
package credentialregister

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// ErrInvalidInput 表示注册缺少账号库、Provider 合同或凭据。
var ErrInvalidInput = errors.New("账号注册参数无效")

// Register 把一次登录得到的凭据落进账号库并返回账号。
//
// 已存在同一身份（DeriveAccountRef 相同）时不新增行：只做凭据原子替换，
// 保留原有 CLI 序号与用户设置。notice 为空时静默。
func Register(
	ctx context.Context,
	store *sqliteaccount.Store,
	catalog *providers.Catalog,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
	notice io.Writer,
) (accountcore.Account, error) {
	if store == nil || catalog == nil || credential == nil {
		return accountcore.Account{}, ErrInvalidInput
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("派生登录账号身份失败: %w", err)
	}
	// 已存在同一身份时走原子凭据替换；只有新身份才注册。
	if overview, overviewErr := store.GetAccountOverview(ctx, accountRef); overviewErr == nil {
		if err := replaceExisting(ctx, store, catalog, accountRef, credential, profile); err != nil {
			return accountcore.Account{}, err
		}
		account := overview.Account()
		writeNotice(notice, account)
		return account, nil
	} else if !errors.Is(overviewErr, accountapp.ErrAccountNotFound) {
		return accountcore.Account{}, fmt.Errorf("检查登录账号是否存在失败: %w", overviewErr)
	}
	request, err := accountapp.NewRegistrationRequest(catalog, credential, profile, time.Now())
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("构造账号注册请求失败: %w", err)
	}
	account, err := store.RegisterNew(ctx, request)
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("注册登录账号失败: %w", err)
	}
	writeNotice(notice, account)
	return account, nil
}

func writeNotice(notice io.Writer, account accountcore.Account) {
	if notice == nil {
		return
	}
	_, _ = fmt.Fprintf(notice, "登录成功: %s #%d (%s)\n",
		account.ProviderID(), account.CLIAccountID().Int64(), account.Ref())
}

func replaceExisting(
	ctx context.Context,
	store *sqliteaccount.Store,
	catalog *providers.Catalog,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) error {
	snapshot, err := store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return fmt.Errorf("读取现有登录凭据失败: %w", err)
	}
	now := time.Now()
	if !now.After(snapshot.UpdatedAt()) {
		now = snapshot.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(snapshot, credential, now)
	if err != nil {
		return fmt.Errorf("构造登录凭据替换失败: %w", err)
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		return fmt.Errorf("更新登录凭据失败: %w", err)
	}
	if profile != nil {
		profileSnapshot, snapshotErr := accountapp.NewProfileSnapshot(catalog, profile, now)
		if snapshotErr != nil {
			return fmt.Errorf("构造登录资料失败: %w", snapshotErr)
		}
		if err := store.UpsertProfile(ctx, profileSnapshot); err != nil {
			return fmt.Errorf("更新登录资料失败: %w", err)
		}
	}
	return nil
}
