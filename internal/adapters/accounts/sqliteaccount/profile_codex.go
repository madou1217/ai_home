package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// codexProfileCodec 编解码 Codex OAuth 公开账号资料。
type codexProfileCodec struct{}

// ProviderID 返回 Codex 规范 Provider ID。
func (codexProfileCodec) ProviderID() string {
	return codex.ProviderID
}

// Encode 把经过领域校验的 Codex 公开资料编码为 v1 JSON。
func (codexProfileCodec) Encode(
	profile accountapp.PublicProfile,
) (encodedProfile, error) {
	value, ok := profile.(codex.AccountProfile)
	if !ok || !value.IsValid() {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	payload, err := encodeProfileJSON(codexProfileV1{
		UserID:    value.UserID(),
		AccountID: value.AccountID(),
		IsFedRAMP: value.IsFedRAMP(),
	})
	return encodedProfile{
		email:            value.Email(),
		subscriptionKind: value.SubscriptionKind(),
		subscriptionRaw:  value.SubscriptionRaw(),
		json:             payload,
	}, err
}

// Decode 解析 v1 JSON 并通过 Codex 公开资料构造器重新校验。
func (codexProfileCodec) Decode(
	document encodedProfile,
) (accountapp.PublicProfile, error) {
	if document.displayName != "" {
		return nil, ErrInvalidProfileDocument
	}
	var payload codexProfileV1
	if err := decodeProfileJSON(document.json, &payload); err != nil {
		return nil, err
	}
	profile, err := codex.NewAccountProfile(codex.Profile{
		UserID:    payload.UserID,
		AccountID: payload.AccountID,
		Email:     document.email,
		Plan:      codex.ParsePlan(document.subscriptionRaw),
		IsFedRAMP: payload.IsFedRAMP,
	})
	if err != nil || profile.SubscriptionKind() != document.subscriptionKind {
		return nil, ErrInvalidProfileDocument
	}
	return profile, nil
}

// codexProfileV1 是 Codex 公开资料 JSON 的唯一 v1 结构。
type codexProfileV1 struct {
	UserID    string `json:"user_id"`
	AccountID string `json:"account_id"`
	IsFedRAMP bool   `json:"is_fedramp"`
}
