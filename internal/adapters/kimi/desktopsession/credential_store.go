package desktopsession

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// maxWriteAttempts 限制凭据 CAS 冲突重试次数。
//
// desktopSession 与 OAuth 刷新写同一条凭据；并发刷新时后到的一次必须重新读最新
// 对话，不能拿旧快照覆盖别人的轮换结果。
const maxWriteAttempts = 3

// CredentialVersionStore 是版本化凭据端口（由 *sqliteaccount.Store 实现）。
type CredentialVersionStore interface {
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.CredentialSnapshot, error)
	ReplaceCredential(ctx context.Context, replacement accountapp.CredentialReplacement) error
}

// CredentialStore 把托管会话持久化进账号凭据的 nativeAuth.desktopSession。
//
// 为什么不另建一张表：桌面启动（Node kimi-strategy）与套餐统计读的是同一份
// nativeAuth；换存储会让两侧看到不同的登录态。合并时保留原生凭据的其它字段，
// 并通过 Provider decoder 重新校验，避免把账号身份改坏。
type CredentialStore struct {
	store CredentialVersionStore
	now   func() time.Time
}

// NewCredentialStore 创建凭据存储适配器。
func NewCredentialStore(store CredentialVersionStore, now func() time.Time) (*CredentialStore, error) {
	if store == nil {
		return nil, ErrInvalidDependencies
	}
	if now == nil {
		now = time.Now
	}
	return &CredentialStore{store: store, now: now}, nil
}

// desktopSessionDocument 是 nativeAuth.desktopSession 的持久化形状。
//
// 字段名与 Node writeDesktopSession 完全一致：桌面启动器按同一份 JSON 读取。
type desktopSessionDocument struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	UserID       string `json:"userId"`
	UpdatedAtMS  int64  `json:"updatedAtMs"`
}

// Read 读取账号托管的桌面会话。
//
// found=false 覆盖三种情况：账号不是 kimi、没有原生凭据、nativeAuth 里没有
// 带 refreshToken 的 desktopSession——与 Node readDesktopSession 的「不可用即
// 未托管」同义。只有存储本身不可读才返回 error。
func (store *CredentialStore) Read(ctx context.Context, accountRef string) (Session, bool, error) {
	ref, err := normalizeAccountRef(accountRef)
	if err != nil {
		return Session{}, false, nil
	}
	snapshot, err := store.store.GetCredentialSnapshot(ctx, ref)
	if err != nil {
		if errors.Is(err, accountapp.ErrCredentialNotFound) {
			return Session{}, false, nil
		}
		return Session{}, false, err
	}
	return readSessionFromSnapshot(snapshot)
}

// readSessionFromSnapshot 从已校验凭据里读出 desktopSession。
func readSessionFromSnapshot(snapshot accountapp.CredentialSnapshot) (Session, bool, error) {
	if snapshot.ProviderID() != ProviderID {
		return Session{}, false, nil
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil {
		return Session{}, false, nil
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(native.Payload(), &document); err != nil || document == nil {
		return Session{}, false, nil
	}
	raw, exists := document["desktopSession"]
	if !exists || len(raw) == 0 {
		return Session{}, false, nil
	}
	var section desktopSessionDocument
	if err := json.Unmarshal(raw, &section); err != nil {
		return Session{}, false, nil
	}
	refreshToken := strings.TrimSpace(section.RefreshToken)
	if refreshToken == "" {
		return Session{}, false, nil
	}
	return Session{
		AccessToken:  strings.TrimSpace(section.AccessToken),
		RefreshToken: refreshToken,
		UserID:       strings.TrimSpace(section.UserID),
		UpdatedAtMS:  section.UpdatedAtMS,
	}, true, nil
}

// Write 合并写入 desktopSession，保留 nativeAuth 的其它字段。
func (store *CredentialStore) Write(ctx context.Context, accountRef string, session Session) error {
	ref, err := normalizeAccountRef(accountRef)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < maxWriteAttempts; attempt++ {
		snapshot, err := store.store.GetCredentialSnapshot(ctx, ref)
		if err != nil {
			return err
		}
		credential, err := mergeDesktopSession(snapshot, session, store.now())
		if err != nil {
			return err
		}
		updatedAt := store.now()
		if !updatedAt.After(snapshot.UpdatedAt()) {
			// 同一毫秒内的两次写入：CAS 要求版本严格递增。
			updatedAt = snapshot.UpdatedAt().Add(time.Millisecond)
		}
		replacement, err := accountapp.NewCredentialReplacement(snapshot, credential, updatedAt)
		if err != nil {
			return err
		}
		if err := store.store.ReplaceCredential(ctx, replacement); err != nil {
			if errors.Is(err, accountapp.ErrCredentialConflict) {
				continue
			}
			return err
		}
		return nil
	}
	return accountapp.ErrCredentialConflict
}

// mergeDesktopSession 生成替换用的凭据：原生 payload 只增改 desktopSession。
func mergeDesktopSession(
	snapshot accountapp.CredentialSnapshot,
	session Session,
	now time.Time,
) (accountapp.Credential, error) {
	if snapshot.ProviderID() != ProviderID {
		return nil, ErrInvalidDependencies
	}
	native, ok := snapshot.Credential().(*accountcore.NativeCredential)
	if !ok || native == nil {
		return nil, ErrInvalidDependencies
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(native.Payload(), &document); err != nil || document == nil {
		return nil, ErrInvalidDependencies
	}
	updatedAtMS := session.UpdatedAtMS
	if updatedAtMS <= 0 {
		updatedAtMS = now.UnixMilli()
	}
	section, err := json.Marshal(desktopSessionDocument{
		AccessToken:  strings.TrimSpace(session.AccessToken),
		RefreshToken: strings.TrimSpace(session.RefreshToken),
		UserID:       strings.TrimSpace(session.UserID),
		UpdatedAtMS:  updatedAtMS,
	})
	if err != nil {
		return nil, err
	}
	document["desktopSession"] = section
	merged, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	// 重新走 Provider decoder：身份（subject）必须与原凭据一致，凭据结构必须仍然合法。
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(ProviderID, merged)
	if err != nil {
		return nil, err
	}
	return credential, nil
}
