package sqliteaccount

import (
	"bytes"
	"encoding/json"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	profileFormatVersion = 1
	maxProfileJSONBytes  = 256 * 1024
)

// encodedProfile 是写入 account_profiles 的公开资料标量和版本化 JSON。
type encodedProfile struct {
	displayName      string
	email            string
	subscriptionKind string
	subscriptionRaw  string
	json             []byte
}

// profileCodec 是 Provider 专属公开资料序列化策略。
type profileCodec interface {
	ProviderID() string
	Encode(profile accountapp.PublicProfile) (encodedProfile, error)
	Decode(document encodedProfile) (accountapp.PublicProfile, error)
}

// profileRegistry 按 Provider ID 选择公开资料 codec。
type profileRegistry map[string]profileCodec

// newProfileRegistry 创建当前已研究 Provider 的公开资料 codec 注册表。
func newProfileRegistry() profileRegistry {
	codecs := []profileCodec{
		codexProfileCodec{},
		claudeProfileCodec{},
	}
	registry := make(profileRegistry, len(codecs))
	for _, codec := range codecs {
		registry[codec.ProviderID()] = codec
	}
	return registry
}

// Encode 使用公开资料自身的 Provider ID 选择编码策略。
func (registry profileRegistry) Encode(
	profile accountapp.PublicProfile,
) (encodedProfile, error) {
	if profile == nil || !profile.IsValid() {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	codec, found := registry[profile.ProviderID()]
	if !found {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	document, err := codec.Encode(profile)
	if err != nil ||
		len(document.json) == 0 ||
		len(document.json) > maxProfileJSONBytes {
		return encodedProfile{}, ErrInvalidProfileDocument
	}
	return document, nil
}

// Decode 根据账号 Provider 选择解码策略并重新进入领域构造器。
func (registry profileRegistry) Decode(
	providerID string,
	document encodedProfile,
) (accountapp.PublicProfile, error) {
	codec, found := registry[providerID]
	if !found ||
		len(document.json) == 0 ||
		len(document.json) > maxProfileJSONBytes {
		return nil, ErrInvalidProfileDocument
	}
	profile, err := codec.Decode(document)
	if err != nil ||
		profile == nil ||
		!profile.IsValid() ||
		profile.ProviderID() != providerID {
		return nil, ErrInvalidProfileDocument
	}
	return profile, nil
}

// encodeProfileJSON 使用结构体字段顺序生成确定性公开资料 JSON。
func encodeProfileJSON(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) == 0 || len(payload) > maxProfileJSONBytes {
		return nil, ErrInvalidProfileDocument
	}
	return payload, nil
}

// decodeProfileJSON 拒绝重复字段、未知字段、尾随 JSON 和超大文档。
func decodeProfileJSON(payload []byte, destination any) error {
	if len(payload) == 0 || len(payload) > maxProfileJSONBytes {
		return ErrInvalidProfileDocument
	}
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return ErrInvalidProfileDocument
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return ErrInvalidProfileDocument
	}
	if err := requireJSONEOF(decoder); err != nil {
		return ErrInvalidProfileDocument
	}
	return nil
}
