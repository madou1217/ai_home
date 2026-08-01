package sqliteaccount

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	credentialFormatVersion = 1
	maxCredentialJSONBytes  = 256 * 1024
)

var errInvalidJSONDocument = errors.New("持久化 JSON 文档无效")

// encodedCredential 是写入 account_credentials 的版本化凭据文档。
type encodedCredential struct {
	credentialRef accountcore.CredentialRef
	authKind      string
	authMode      string
	json          []byte
}

// credentialCodec 是 Provider 专属凭据序列化策略。
type credentialCodec interface {
	ProviderID() string
	Encode(credential accountapp.Credential) (encodedCredential, error)
	Decode(authKind string, authMode string, payload []byte) (accountapp.Credential, error)
}

// credentialRegistry 按 Provider ID 选择凭据 codec。
type credentialRegistry map[string]credentialCodec

// newCredentialRegistry 创建当前已研究 Provider 的凭据 codec 注册表。
func newCredentialRegistry() credentialRegistry {
	codecs := []credentialCodec{
		codexCredentialCodec{},
		claudeCredentialCodec{},
	}
	registry := make(credentialRegistry, len(codecs))
	for _, codec := range codecs {
		registry[codec.ProviderID()] = codec
	}
	return registry
}

// Encode 使用凭据自身的 Provider ID 选择编码策略。
func (registry credentialRegistry) Encode(
	credential accountapp.Credential,
) (encodedCredential, error) {
	if credential == nil {
		return encodedCredential{}, ErrInvalidCredential
	}
	codec, found := registry[credential.ProviderID()]
	if !found {
		return encodedCredential{}, ErrInvalidCredential
	}
	document, err := codec.Encode(credential)
	if err != nil || len(document.json) == 0 || len(document.json) > maxCredentialJSONBytes {
		return encodedCredential{}, ErrInvalidCredential
	}
	credentialRef, err := accountcore.DeriveCredentialRef(credential)
	if err != nil {
		return encodedCredential{}, ErrInvalidCredential
	}
	document.credentialRef = credentialRef
	return document, nil
}

// Decode 根据账号 Provider 选择解码策略并重新进入领域构造器。
func (registry credentialRegistry) Decode(
	providerID string,
	authKind string,
	authMode string,
	payload []byte,
) (accountapp.Credential, error) {
	codec, found := registry[providerID]
	if !found || len(payload) == 0 || len(payload) > maxCredentialJSONBytes {
		return nil, ErrInvalidCredential
	}
	credential, err := codec.Decode(authKind, authMode, payload)
	if err != nil || credential == nil || credential.ProviderID() != providerID {
		return nil, ErrInvalidCredential
	}
	return credential, nil
}

// encodeCredentialJSON 使用结构体字段顺序生成确定性 JSON。
func encodeCredentialJSON(value any) ([]byte, error) {
	payload, err := json.Marshal(value)
	if err != nil || len(payload) == 0 || len(payload) > maxCredentialJSONBytes {
		return nil, ErrInvalidCredential
	}
	return payload, nil
}

// decodeCredentialJSON 拒绝重复字段、未知字段、尾随 JSON 和超大文档。
func decodeCredentialJSON(payload []byte, destination any) error {
	if len(payload) == 0 || len(payload) > maxCredentialJSONBytes {
		return ErrInvalidCredential
	}
	if err := rejectDuplicateJSONKeys(payload); err != nil {
		return ErrInvalidCredential
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return ErrInvalidCredential
	}
	if err := requireJSONEOF(decoder); err != nil {
		return ErrInvalidCredential
	}
	return nil
}

// rejectDuplicateJSONKeys 遍历 JSON token 并拒绝任意层级的重复对象字段。
func rejectDuplicateJSONKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	return requireJSONEOF(decoder)
}

// consumeJSONValue 递归消费一个完整 JSON 值。
func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		return consumeJSONObject(decoder)
	case '[':
		return consumeJSONArray(decoder)
	default:
		return errInvalidJSONDocument
	}
}

// consumeJSONObject 消费对象并检查同层字段唯一性。
func consumeJSONObject(decoder *json.Decoder) error {
	keys := make(map[string]struct{})
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		key, ok := token.(string)
		if !ok {
			return errInvalidJSONDocument
		}
		if _, exists := keys[key]; exists {
			return errInvalidJSONDocument
		}
		keys[key] = struct{}{}
		if err := consumeJSONValue(decoder); err != nil {
			return err
		}
	}
	return requireClosingDelimiter(decoder, '}')
}

// consumeJSONArray 消费数组中的全部 JSON 值。
func consumeJSONArray(decoder *json.Decoder) error {
	for decoder.More() {
		if err := consumeJSONValue(decoder); err != nil {
			return err
		}
	}
	return requireClosingDelimiter(decoder, ']')
}

// requireClosingDelimiter 校验对象或数组闭合符。
func requireClosingDelimiter(decoder *json.Decoder, expected json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != expected {
		return errInvalidJSONDocument
	}
	return nil
}

// requireJSONEOF 确保文档只有一个顶层 JSON 值。
func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errInvalidJSONDocument
	}
	return errInvalidJSONDocument
}
