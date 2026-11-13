package accounts

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	"github.com/madou1217/ai_home/core/providers"
)

var (
	// ErrInvalidStaticCredentialRotation 表示轮换命令没有保持账号和 Provider 边界。
	ErrInvalidStaticCredentialRotation = errors.New("静态账号凭据轮换无效")
	// ErrStaticCredentialRotationUnsupported 表示目标账号不是可原地轮换的静态凭据。
	ErrStaticCredentialRotationUnsupported = errors.New("账号凭据不支持静态轮换")
	// ErrStaticCredentialRotationConflict 表示账号或凭据已被并发修改，或者新凭据已被占用。
	ErrStaticCredentialRotationConflict = errors.New("静态账号凭据轮换冲突")
	// ErrInvalidStaticCredentialRotatorDependencies 表示用例缺少目录、存储、清理或时钟依赖。
	ErrInvalidStaticCredentialRotatorDependencies = errors.New("静态账号凭据轮换依赖无效")
	// ErrStaticCredentialEditIncomplete 表示编辑没有提供切换认证方式所需的新密钥。
	ErrStaticCredentialEditIncomplete = errors.New("静态账号凭据编辑缺少必填字段")
	// ErrStaticBaseURLUnsupported 表示当前认证模式不支持自定义 Base URL。
	ErrStaticBaseURLUnsupported = errors.New("当前认证模式不支持自定义 Base URL")
)

// StaticCredentialEdit 是 WebUI 形态的静态凭据编辑命令：空密钥表示沿用当前密钥，
// 未携带 BaseURL 表示沿用当前地址。映射到 Provider 领域值由 Edit 负责。
type StaticCredentialEdit struct {
	APIKey         string
	BaseURL        string
	IncludeBaseURL bool
	AuthKind       string
}

// StaticCredentialRotation 是保持 AccountRef 不变的完整静态凭据轮换命令。
type StaticCredentialRotation struct {
	account     accountcore.Account
	current     CredentialSnapshot
	replacement Credential
	updatedAt   time.Time
}

// NewStaticCredentialRotation 创建可由持久化层执行 CAS 的轮换命令。
func NewStaticCredentialRotation(
	account accountcore.Account,
	current CredentialSnapshot,
	replacement Credential,
	updatedAt time.Time,
) (StaticCredentialRotation, error) {
	normalizedTime, err := normalizePersistedTime(updatedAt)
	if err != nil ||
		!validStaticCredentialRotation(
			account,
			current,
			replacement,
			normalizedTime,
		) {
		return StaticCredentialRotation{}, ErrInvalidStaticCredentialRotation
	}
	return StaticCredentialRotation{
		account:     account,
		current:     current,
		replacement: replacement,
		updatedAt:   normalizedTime,
	}, nil
}

// AccountRef 返回轮换前后都必须保持不变的稳定账号引用。
func (rotation StaticCredentialRotation) AccountRef() accountcore.AccountRef {
	return rotation.account.Ref()
}

// ProviderID 返回目标账号的规范 Provider。
func (rotation StaticCredentialRotation) ProviderID() string {
	return rotation.account.ProviderID()
}

// ExpectedAccountUpdatedAt 返回基础账号的 CAS 旧值。
func (rotation StaticCredentialRotation) ExpectedAccountUpdatedAt() time.Time {
	return rotation.account.UpdatedAt()
}

// ExpectedCredentialUpdatedAt 返回当前凭据的 CAS 旧值。
func (rotation StaticCredentialRotation) ExpectedCredentialUpdatedAt() time.Time {
	return rotation.current.UpdatedAt()
}

// CurrentCredential 返回轮换前的静态凭据，仅用于持久化层复核类型和查重引用。
func (rotation StaticCredentialRotation) CurrentCredential() Credential {
	return rotation.current.Credential()
}

// Replacement 返回经过 Provider 领域构造器校验的新静态凭据。
func (rotation StaticCredentialRotation) Replacement() Credential {
	return rotation.replacement
}

// UpdatedAt 返回账号、凭据和模型共同推进到的业务时间。
func (rotation StaticCredentialRotation) UpdatedAt() time.Time {
	return rotation.updatedAt
}

// IsValid 重新检查跨层传递后的完整轮换不变量。
func (rotation StaticCredentialRotation) IsValid() bool {
	return validStaticCredentialRotation(
		rotation.account,
		rotation.current,
		rotation.replacement,
		rotation.updatedAt,
	)
}

// validStaticCredentialRotation 集中维护账号、Provider、类型、模型和时间约束。
func validStaticCredentialRotation(
	account accountcore.Account,
	current CredentialSnapshot,
	replacement Credential,
	updatedAt time.Time,
) bool {
	normalizedTime, timeErr := normalizePersistedTime(updatedAt)
	return timeErr == nil &&
		normalizedTime.Equal(updatedAt) &&
		account.IsValid() &&
		current.IsValid() &&
		current.AccountRef() == account.Ref() &&
		current.ProviderID() == account.ProviderID() &&
		isRotatableStaticCredential(current.Credential()) &&
		isRotatableStaticCredential(replacement) &&
		replacement.ProviderID() == account.ProviderID() &&
		updatedAt.After(account.UpdatedAt()) &&
		updatedAt.After(current.UpdatedAt())
}

// isRotatableStaticCredential 允许 Codex/Claude/Gemini 以及通用 StaticAPIKeyAuth 静态凭据原地轮换。
func isRotatableStaticCredential(credential Credential) bool {
	switch typed := credential.(type) {
	case *codex.APIKeyAuth:
		return typed != nil
	case *claude.APIKeyAuth:
		return typed != nil
	case *claude.AuthTokenAuth:
		return typed != nil
	case *gemini.VertexAuth:
		return typed != nil
	case *accountcore.StaticAPIKeyAuth:
		return typed != nil
	default:
		return false
	}
}

// StaticCredentialRotationStore 提供轮换所需的最小账号、凭据和原子写入端口。
type StaticCredentialRotationStore interface {
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
	GetCredentialSnapshot(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (CredentialSnapshot, error)
	RotateStaticCredential(
		ctx context.Context,
		rotation StaticCredentialRotation,
	) (accountcore.Account, error)
}

// StaticCredentialRotator 编排校验、原子写入和提交后运行态清理。
type StaticCredentialRotator struct {
	catalog  *providers.Catalog
	store    StaticCredentialRotationStore
	cleanups []DeletionCleanup
	clock    Clock
}

// NewStaticCredentialRotator 创建依赖完整的静态凭据轮换用例。
func NewStaticCredentialRotator(
	catalog *providers.Catalog,
	store StaticCredentialRotationStore,
	clock Clock,
	cleanups ...DeletionCleanup,
) (*StaticCredentialRotator, error) {
	if catalog == nil || store == nil || clock == nil || len(cleanups) == 0 {
		return nil, ErrInvalidStaticCredentialRotatorDependencies
	}
	for _, cleanup := range cleanups {
		if cleanup == nil {
			return nil, ErrInvalidStaticCredentialRotatorDependencies
		}
	}
	return &StaticCredentialRotator{
		catalog:  catalog,
		store:    store,
		cleanups: append([]DeletionCleanup(nil), cleanups...),
		clock:    clock,
	}, nil
}

// Rotate 在同一个 AccountRef 下轮换静态凭据，并保留最后成功的模型快照。
func (rotator *StaticCredentialRotator) Rotate(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	replacement Credential,
) (accountcore.Account, error) {
	if rotator == nil ||
		rotator.catalog == nil ||
		rotator.store == nil ||
		len(rotator.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() ||
		replacement == nil {
		return accountcore.Account{}, ErrInvalidStaticCredentialRotation
	}
	if err := ctx.Err(); err != nil {
		return accountcore.Account{}, err
	}
	account, current, err := rotator.readTarget(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, err
	}
	if !isRotatableStaticCredential(current.Credential()) ||
		!isRotatableStaticCredential(replacement) {
		return accountcore.Account{}, ErrStaticCredentialRotationUnsupported
	}
	if replacement.ProviderID() != account.ProviderID() {
		return accountcore.Account{}, ErrInvalidStaticCredentialRotation
	}
	updatedAt, err := nextStaticCredentialRotationTime(
		rotator.clock(),
		account.UpdatedAt(),
		current.UpdatedAt(),
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	rotation, err := NewStaticCredentialRotation(
		account,
		current,
		replacement,
		updatedAt,
	)
	if err != nil {
		return accountcore.Account{}, err
	}
	updated, err := rotator.store.RotateStaticCredential(ctx, rotation)
	if err != nil {
		return accountcore.Account{}, err
	}
	for _, cleanup := range rotator.cleanups {
		cleanup.ForgetAccount(accountRef)
	}
	return updated, nil
}

// Edit 在当前账号上应用一次 WebUI 形态的编辑：空密钥/未携带地址时沿用当前值，
// 切换 Claude 认证方式时必须提供新密钥。最终仍走 Rotate 的完整校验与 CAS。
func (rotator *StaticCredentialRotator) Edit(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	edit StaticCredentialEdit,
) (accountcore.Account, error) {
	if rotator == nil ||
		rotator.catalog == nil ||
		rotator.store == nil ||
		len(rotator.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() {
		return accountcore.Account{}, ErrInvalidStaticCredentialRotation
	}
	if err := ctx.Err(); err != nil {
		return accountcore.Account{}, err
	}
	_, current, err := rotator.readTarget(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, err
	}
	replacement, err := replacementForEdit(current.Credential(), edit)
	if err != nil {
		return accountcore.Account{}, err
	}
	return rotator.Rotate(ctx, accountRef, replacement)
}

// replacementForEdit 只在 Provider 领域类型已知时构造替换凭据；未知形态 fail-closed。
func replacementForEdit(current Credential, edit StaticCredentialEdit) (Credential, error) {
	if edit.IncludeBaseURL && strings.TrimSpace(edit.BaseURL) != "" {
		if _, err := accountcore.NormalizeStaticBaseURL(edit.BaseURL); err != nil {
			return nil, err
		}
	}
	switch credential := current.(type) {
	case *codex.APIKeyAuth:
		kind := normalizeStaticEditKind(edit.AuthKind)
		if kind != "" && kind != "api-key" {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		apiKey := strings.TrimSpace(edit.APIKey)
		if apiKey == "" {
			apiKey = credential.APIKey()
		}
		if apiKey == "" {
			return nil, ErrStaticCredentialEditIncomplete
		}
		baseURL := credential.BaseURL()
		if edit.IncludeBaseURL {
			baseURL = strings.TrimSpace(edit.BaseURL)
		}
		auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", accountcore.ErrInvalidStaticAPIKey, err)
		}
		return auth, nil
	case *claude.APIKeyAuth:
		kind := normalizeStaticEditKind(edit.AuthKind)
		if kind == "" {
			kind = "api-key"
		}
		if kind != "api-key" && kind != "auth-token" {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		baseURL := credential.BaseURL()
		if edit.IncludeBaseURL {
			baseURL = strings.TrimSpace(edit.BaseURL)
		}
		if kind == "api-key" {
			apiKey := strings.TrimSpace(edit.APIKey)
			if apiKey == "" {
				apiKey = credential.APIKey()
			}
			if apiKey == "" {
				return nil, ErrStaticCredentialEditIncomplete
			}
			auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
			if err != nil {
				return nil, fmt.Errorf("%w: %v", accountcore.ErrInvalidStaticAPIKey, err)
			}
			return auth, nil
		}
		if strings.TrimSpace(edit.APIKey) == "" {
			return nil, ErrStaticCredentialEditIncomplete
		}
		auth, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
			AuthToken: strings.TrimSpace(edit.APIKey),
			BaseURL:   baseURL,
		})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", accountcore.ErrInvalidStaticAPIKey, err)
		}
		return auth, nil
	case *claude.AuthTokenAuth:
		kind := normalizeStaticEditKind(edit.AuthKind)
		if kind == "" {
			kind = "auth-token"
		}
		if kind != "auth-token" && kind != "api-key" {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		baseURL := credential.BaseURL()
		if edit.IncludeBaseURL {
			baseURL = strings.TrimSpace(edit.BaseURL)
		}
		if kind == "auth-token" {
			token := strings.TrimSpace(edit.APIKey)
			if token == "" {
				token = credential.AuthToken()
			}
			if token == "" {
				return nil, ErrStaticCredentialEditIncomplete
			}
			auth, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: token, BaseURL: baseURL})
			if err != nil {
				return nil, fmt.Errorf("%w: %v", accountcore.ErrInvalidStaticAPIKey, err)
			}
			return auth, nil
		}
		if strings.TrimSpace(edit.APIKey) == "" {
			return nil, ErrStaticCredentialEditIncomplete
		}
		auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
			APIKey:  strings.TrimSpace(edit.APIKey),
			BaseURL: baseURL,
		})
		if err != nil {
			return nil, fmt.Errorf("%w: %v", accountcore.ErrInvalidStaticAPIKey, err)
		}
		return auth, nil
	case *gemini.VertexAuth:
		kind := normalizeStaticEditKind(edit.AuthKind)
		if kind != "" && kind != "api-key" && kind != "vertex-ai" {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		apiKey := strings.TrimSpace(edit.APIKey)
		if apiKey == "" {
			apiKey = credential.APIKey()
		}
		baseURL := credential.BaseURL()
		if edit.IncludeBaseURL {
			baseURL = strings.TrimSpace(edit.BaseURL)
		}
		return gemini.NewVertexAuth(gemini.VertexInput{
			ProjectID:   credential.ProjectID(),
			Location:    credential.Location(),
			APIKey:      apiKey,
			BaseURL:     baseURL,
			Placeholder: credential.Placeholder(),
		})
	case *accountcore.StaticAPIKeyAuth:
		if credential == nil {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		kind := normalizeStaticEditKind(edit.AuthKind)
		if kind != "" && kind != "api-key" {
			return nil, ErrStaticCredentialRotationUnsupported
		}
		apiKey := strings.TrimSpace(edit.APIKey)
		if apiKey == "" {
			apiKey = credential.APIKey()
		}
		if apiKey == "" {
			return nil, ErrStaticCredentialEditIncomplete
		}
		baseURL := credential.BaseURL()
		if edit.IncludeBaseURL {
			baseURL = strings.TrimSpace(edit.BaseURL)
		}
		if credential.ProviderID() == gemini.ProviderID && baseURL != "" {
			return nil, ErrStaticBaseURLUnsupported
		}
		return accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
			ProviderID: credential.ProviderID(),
			APIKey:     apiKey,
			BaseURL:    baseURL,
		})
	default:
		return nil, ErrStaticCredentialRotationUnsupported
	}
}

// normalizeStaticEditKind 接受 WebUI 的 api-key/auth-token 及下划线写法。
func normalizeStaticEditKind(value string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(value)), "_", "-")
}

// readTarget 按固定顺序读取基础账号和当前凭据绑定。
func (rotator *StaticCredentialRotator) readTarget(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, CredentialSnapshot, error) {
	account, err := rotator.store.GetByRef(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, CredentialSnapshot{}, err
	}
	current, err := rotator.store.GetCredentialSnapshot(ctx, accountRef)
	if err != nil {
		return accountcore.Account{}, CredentialSnapshot{}, err
	}
	providerID, found := rotator.catalog.CanonicalID(account.ProviderID())
	if !found ||
		providerID != account.ProviderID() ||
		!current.IsValid() ||
		current.AccountRef() != account.Ref() ||
		current.ProviderID() != providerID {
		return accountcore.Account{}, CredentialSnapshot{}, ErrInvalidStaticCredentialRotation
	}
	return account, current, nil
}

// nextStaticCredentialRotationTime 生成晚于账号和凭据版本的毫秒时间。
func nextStaticCredentialRotationTime(
	now time.Time,
	accountUpdatedAt time.Time,
	credentialUpdatedAt time.Time,
) (time.Time, error) {
	normalizedNow, err := normalizePersistedTime(now)
	if err != nil {
		return time.Time{}, ErrInvalidStaticCredentialRotation
	}
	latest := accountUpdatedAt
	if credentialUpdatedAt.After(latest) {
		latest = credentialUpdatedAt
	}
	if !normalizedNow.After(latest) {
		normalizedNow = latest.Add(time.Millisecond)
	}
	if _, err := normalizePersistedTime(normalizedNow); err != nil {
		return time.Time{}, ErrInvalidStaticCredentialRotation
	}
	return normalizedNow, nil
}
