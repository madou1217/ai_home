package accounts

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// DefaultOverviewLimit 是账号管理列表的默认分页大小。
	DefaultOverviewLimit = 50
	// MaxOverviewLimit 防止管理列表一次读取过多账号。
	MaxOverviewLimit = 256
)

// ErrInvalidOverview 表示账号管理查询或持久化投影无效。
var ErrInvalidOverview = errors.New("账号管理投影无效")

// OverviewQuery 是使用 AccountRef 稳定游标的账号管理列表查询。
type OverviewQuery struct {
	afterRef accountcore.AccountRef
	limit    int
}

// NewOverviewQuery 校验游标和分页大小并创建账号管理查询。
func NewOverviewQuery(
	afterRef accountcore.AccountRef,
	limit int,
) (OverviewQuery, error) {
	if afterRef != "" && !afterRef.IsValid() {
		return OverviewQuery{}, ErrInvalidOverview
	}
	if limit == 0 {
		limit = DefaultOverviewLimit
	}
	if limit < 1 || limit > MaxOverviewLimit {
		return OverviewQuery{}, ErrInvalidOverview
	}
	return OverviewQuery{afterRef: afterRef, limit: limit}, nil
}

// AfterRef 返回不包含在下一页中的 AccountRef 游标。
func (query OverviewQuery) AfterRef() accountcore.AccountRef {
	return query.afterRef
}

// Limit 返回本次账号管理查询的最大行数。
func (query OverviewQuery) Limit() int {
	return query.limit
}

// AccountOverviewInput 是从持久化标量构造账号管理投影所需的字段。
type AccountOverviewInput struct {
	Account          accountcore.Account
	HasCredential    bool
	AuthKind         string
	AuthMode         string
	HasProfile       bool
	DisplayName      string
	Email            string
	SubscriptionKind string
	SubscriptionRaw  string
	ProfileUpdatedAt time.Time
}

// AccountOverview 是账号列表使用的无敏感数据只读投影。
type AccountOverview struct {
	account          accountcore.Account
	hasCredential    bool
	authKind         string
	authMode         string
	hasProfile       bool
	displayName      string
	email            string
	subscriptionKind string
	subscriptionRaw  string
	profileUpdatedAt time.Time
}

// NewAccountOverview 校验基础账号和可选凭据、资料标量。
func NewAccountOverview(input AccountOverviewInput) (AccountOverview, error) {
	if !input.Account.IsValid() ||
		!validCredentialOverview(input) ||
		!validProfileOverview(input) {
		return AccountOverview{}, ErrInvalidOverview
	}
	return AccountOverview{
		account:          input.Account,
		hasCredential:    input.HasCredential,
		authKind:         input.AuthKind,
		authMode:         input.AuthMode,
		hasProfile:       input.HasProfile,
		displayName:      input.DisplayName,
		email:            input.Email,
		subscriptionKind: input.SubscriptionKind,
		subscriptionRaw:  input.SubscriptionRaw,
		profileUpdatedAt: input.ProfileUpdatedAt,
	}, nil
}

// Account 返回完整基础账号快照。
func (overview AccountOverview) Account() accountcore.Account {
	return overview.account
}

// HasCredential 返回账号是否已有可用凭据记录。
func (overview AccountOverview) HasCredential() bool {
	return overview.hasCredential
}

// AuthKind 返回不含敏感内容的认证类型。
func (overview AccountOverview) AuthKind() string {
	return overview.authKind
}

// AuthMode 返回 Provider 认证子模式。
func (overview AccountOverview) AuthMode() string {
	return overview.authMode
}

// HasProfile 返回账号是否已有公开资料。
func (overview AccountOverview) HasProfile() bool {
	return overview.hasProfile
}

// DisplayName 返回公开展示名称。
func (overview AccountOverview) DisplayName() string {
	return overview.displayName
}

// Email 返回公开邮箱。
func (overview AccountOverview) Email() string {
	return overview.email
}

// SubscriptionKind 返回稳定订阅分类。
func (overview AccountOverview) SubscriptionKind() string {
	return overview.subscriptionKind
}

// SubscriptionRaw 返回 Provider 原始订阅值。
func (overview AccountOverview) SubscriptionRaw() string {
	return overview.subscriptionRaw
}

// ProfileUpdatedAt 返回公开资料采集时间；没有资料时为零值。
func (overview AccountOverview) ProfileUpdatedAt() time.Time {
	return overview.profileUpdatedAt
}

// AccountOverviewStore 是账号管理列表的独立查询端口。
type AccountOverviewStore interface {
	ListAccountOverviews(
		ctx context.Context,
		query OverviewQuery,
	) ([]AccountOverview, error)
}

// validCredentialOverview 校验凭据存在标记和公开认证类型的一致性。
func validCredentialOverview(input AccountOverviewInput) bool {
	if !input.HasCredential {
		return input.AuthKind == "" && input.AuthMode == ""
	}
	return validMetadataToken(input.AuthKind, 32) &&
		(input.AuthMode == "" || validMetadataToken(input.AuthMode, 32))
}

// validProfileOverview 校验资料存在标记和公开标量的一致性。
func validProfileOverview(input AccountOverviewInput) bool {
	if !input.HasProfile {
		return input.DisplayName == "" &&
			input.Email == "" &&
			input.SubscriptionKind == "" &&
			input.SubscriptionRaw == "" &&
			input.ProfileUpdatedAt.IsZero()
	}
	normalizedTime, err := normalizePersistedTime(input.ProfileUpdatedAt)
	return err == nil &&
		normalizedTime.Equal(input.ProfileUpdatedAt) &&
		validPublicText(input.DisplayName, 256) &&
		validPublicText(input.Email, 320) &&
		validMetadataToken(input.SubscriptionKind, 64) &&
		validPublicText(input.SubscriptionRaw, 128)
}

// validMetadataToken 校验数据库中的小写枚举标量。
func validMetadataToken(value string, maxLength int) bool {
	if value == "" || len(value) > maxLength {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' ||
			character == '_' {
			continue
		}
		return false
	}
	return true
}

// validPublicText 校验非敏感展示文本不会制造控制字符或异常内存占用。
func validPublicText(value string, maxLength int) bool {
	return len(value) <= maxLength &&
		utf8.ValidString(value) &&
		value == strings.TrimSpace(value) &&
		strings.IndexFunc(value, unicode.IsControl) < 0
}
