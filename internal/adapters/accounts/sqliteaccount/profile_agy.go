package sqliteaccount

import (
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

// agyProfileCodec 编解码 agy 公开资料：身份只有邮箱，没有套餐字段。
//
// Node 的原生导入会带着 agy 资料文档进来；注册表缺这个 codec 时，
// native_import 会稳定报「账号公开资料文档无效」，账号同步与刷新链路被卡住。
type agyProfileCodec struct{}

// ProviderID 返回 agy 规范 Provider ID。
func (agyProfileCodec) ProviderID() string { return agy.ProviderID }

// Encode 把经过领域校验的 agy 公开资料编码为 v1 JSON。
func (agyProfileCodec) Encode(
	profile accountapp.PublicProfile,
) (encodedProfile, error) {
	value, ok := profile.(agy.AccountProfile)
	if !ok || !value.IsValid() {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	payload, err := encodeProfileJSON(struct{}{})
	if err != nil {
		return encodedProfile{}, err
	}
	return encodedProfile{
		displayName:      value.DisplayName(),
		email:            value.Email(),
		subscriptionKind: value.SubscriptionKind(),
		subscriptionRaw:  value.SubscriptionRaw(),
		json:             payload,
	}, nil
}

// Decode 解析 v1 JSON 并通过 agy 公开资料构造器重新校验。
func (agyProfileCodec) Decode(
	document encodedProfile,
) (accountapp.PublicProfile, error) {
	profile, err := agy.NewAccountProfile(document.email)
	if err != nil {
		return nil, ErrInvalidProfileDocument
	}
	if profile.SubscriptionKind() != document.subscriptionKind ||
		profile.SubscriptionRaw() != document.subscriptionRaw {
		return nil, ErrInvalidProfileDocument
	}
	return profile, nil
}
