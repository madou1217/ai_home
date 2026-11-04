package accounts

import (
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ErrInvalidUIState 表示账号页展示状态字段越界或时间无效。
var ErrInvalidUIState = errors.New("账号展示状态无效")

// UIStateInput 是账号页展示状态的全部字段。
type UIStateInput struct {
	AccountRef  AccountRef
	Status      string
	DisplayName string
	AuthMode    string
	APIKeyMode  bool
	BaseURL     string
	UpdatedAt   time.Time
}

// UIState 是构造后不可变的账号页展示状态。
type UIState struct {
	accountRef  AccountRef
	status      string
	displayName string
	authMode    string
	apiKeyMode  bool
	baseURL     string
	updatedAt   time.Time
}

// NewUIState 校验字段长度与时间后创建展示状态。
func NewUIState(input UIStateInput) (UIState, error) {
	rawStatus := strings.TrimSpace(input.Status)
	// 与 Node 的 status-file.js 同一口径：enabled/disabled 这类别名先归一为 up/down。
	status := ResolveEffectiveAccountStatus(rawStatus)
	displayName := strings.TrimSpace(input.DisplayName)
	authMode := strings.TrimSpace(input.AuthMode)
	baseURL := strings.TrimSpace(input.BaseURL)
	updatedAt, updatedValid := normalizeUIStateTime(input.UpdatedAt)
	if !input.AccountRef.IsValid() ||
		rawStatus == "" ||
		len(status) > 32 ||
		input.DisplayName != displayName ||
		!validDisplayText(displayName, 256) ||
		input.AuthMode != authMode ||
		len(authMode) > 64 ||
		input.BaseURL != baseURL ||
		len(baseURL) > 2048 ||
		!updatedValid {
		return UIState{}, ErrInvalidUIState
	}
	return UIState{
		accountRef:  input.AccountRef,
		status:      status,
		displayName: displayName,
		authMode:    authMode,
		apiKeyMode:  input.APIKeyMode,
		baseURL:     baseURL,
		updatedAt:   updatedAt,
	}, nil
}

// AccountRef 返回状态所属账号。
func (state UIState) AccountRef() AccountRef { return state.accountRef }

// Status 返回账号生命周期状态（up/down/...）。
func (state UIState) Status() string { return state.status }

// DisplayName 返回账号展示名。
func (state UIState) DisplayName() string { return state.displayName }

// AuthMode 返回账号认证模式。
func (state UIState) AuthMode() string { return state.authMode }

// APIKeyMode 表示账号是否使用静态密钥。
func (state UIState) APIKeyMode() bool { return state.apiKeyMode }

// BaseURL 返回账号自定义上游地址。
func (state UIState) BaseURL() string { return state.baseURL }

// UpdatedAt 返回状态最后写入时间。
func (state UIState) UpdatedAt() time.Time { return state.updatedAt }

// IsValid 重新校验跨层传递后的不可变状态。
func (state UIState) IsValid() bool {
	restored, err := NewUIState(UIStateInput{
		AccountRef:  state.accountRef,
		Status:      state.status,
		DisplayName: state.displayName,
		AuthMode:    state.authMode,
		APIKeyMode:  state.apiKeyMode,
		BaseURL:     state.baseURL,
		UpdatedAt:   state.updatedAt,
	})
	return err == nil && restored == state
}

func validDisplayText(value string, maxLength int) bool {
	if len(value) > maxLength || !utf8.ValidString(value) {
		return false
	}
	return strings.IndexFunc(value, unicode.IsControl) < 0
}

func normalizeUIStateTime(value time.Time) (time.Time, bool) {
	if value.IsZero() {
		return time.Time{}, false
	}
	unixMS := value.UnixMilli()
	if unixMS < 0 || unixMS > 253_402_300_799_999 {
		return time.Time{}, false
	}
	return time.UnixMilli(unixMS).UTC(), true
}
