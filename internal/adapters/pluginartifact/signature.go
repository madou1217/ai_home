package pluginartifact

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/plugintrust"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	codeSignatureInvalid   = "plugin_signature_invalid"
	codeSignatureUntrusted = "plugin_signature_untrusted"
	codeSignatureRequired  = "plugin_signature_required"
)

type signatureOptions struct {
	AIHomeDir     string
	TrustedKeys   map[string]string
	RequireSigned bool
}

// resolveSignature 校验 metadata 里的发布者签名并落实安装策略。
//
// 与 Node 一致：已签名包一旦签名无效/公钥不可信就拒绝；未签名包显式标记，
// 由 requireSigned 决定是否安装，不把「没有签名」伪装成「验证通过」。
func resolveSignature(metadata map[string]any, options signatureOptions) (Signature, *pluginerr.Error) {
	signatureValue, present := metadata["signature"]
	if !present || signatureValue == nil {
		if options.RequireSigned {
			return Signature{Status: "unsigned"}, pluginerr.New(codeSignatureRequired,
				"该安装策略要求插件包必须由受信任的发布者签名")
		}
		return Signature{Status: "unsigned"}, nil
	}
	signature, ok := signatureValue.(map[string]any)
	if !ok {
		return Signature{Status: "invalid", Detail: "签名结构不合法"}, pluginerr.New(codeSignatureInvalid, "签名结构不合法")
	}
	algorithm, _ := signature["algorithm"].(string)
	value, _ := signature["value"].(string)
	keyID, _ := signature["keyId"].(string)
	if algorithm != "ed25519" || value == "" || keyID == "" {
		return Signature{Status: "invalid", Detail: "签名结构不合法"}, pluginerr.New(codeSignatureInvalid, "签名结构不合法")
	}
	trusted, trustErr := trustedKeysFor(options)
	if trustErr != nil {
		return Signature{Status: "invalid", KeyID: keyID, Detail: trustErr.Error()},
			pluginerr.New(codeSignatureInvalid, trustErr.Error())
	}
	publicKeyPEM, isTrusted := trusted[keyID]
	if !isTrusted {
		detail := "本机没有该签名公钥"
		return Signature{Status: "untrusted", KeyID: keyID, Detail: detail},
			pluginerr.New(codeSignatureUntrusted, fmt.Sprintf("插件包签名公钥 %s 不在本机信任根中（aih plugin trust）", keyID))
	}
	normalized, err := plugintrust.NormalizePublicKey(publicKeyPEM)
	if err != nil {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	block, _ := pem.Decode([]byte(normalized))
	if block == nil {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	payload, err := signedPayload(metadata)
	if err != nil {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil || len(decoded) != ed25519.SignatureSize || !ed25519.Verify(publicKey, payload, decoded) {
		return Signature{Status: "invalid", KeyID: keyID, Detail: "签名与包内容不匹配"},
			pluginerr.New(codeSignatureInvalid, "签名与包内容不匹配")
	}
	signedAt, _ := signature["signedAt"].(string)
	return Signature{Status: "signed", KeyID: keyID, SignedAt: &signedAt}, nil
}

func trustedKeysFor(options signatureOptions) (map[string]string, error) {
	if options.TrustedKeys != nil {
		return options.TrustedKeys, nil
	}
	store, err := plugintrust.NewTrustStore(options.AIHomeDir)
	if err != nil {
		return nil, err
	}
	return store.Read()
}

// signedPayload 与 Node signature.js 的 signedPayload 同构：
// canonicalJson({formatVersion, manifest, files})。
func signedPayload(metadata map[string]any) ([]byte, error) {
	return canonicalJSON(map[string]any{
		"formatVersion": metadata["formatVersion"],
		"manifest":      metadata["manifest"],
		"files":         metadata["files"],
	})
}

func canonicalJSON(value any) ([]byte, error) {
	var builder strings.Builder
	if err := writeCanonicalJSON(&builder, value); err != nil {
		return nil, err
	}
	return []byte(builder.String()), nil
}

func writeCanonicalJSON(builder *strings.Builder, value any) error {
	switch typed := value.(type) {
	case nil:
		builder.WriteString("null")
	case bool:
		if typed {
			builder.WriteString("true")
		} else {
			builder.WriteString("false")
		}
	case string:
		writeJSONString(builder, typed)
	case json.Number:
		if err := writeJSONNumber(builder, typed.String()); err != nil {
			return err
		}
	case float64:
		if err := writeJSONNumber(builder, strconv.FormatFloat(typed, 'g', -1, 64)); err != nil {
			return err
		}
	case int:
		builder.WriteString(strconv.Itoa(typed))
	case int64:
		builder.WriteString(strconv.FormatInt(typed, 10))
	case []any:
		builder.WriteByte('[')
		for index, item := range typed {
			if index > 0 {
				builder.WriteByte(',')
			}
			if err := writeCanonicalJSON(builder, item); err != nil {
				return err
			}
		}
		builder.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		builder.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				builder.WriteByte(',')
			}
			writeJSONString(builder, key)
			builder.WriteByte(':')
			if err := writeCanonicalJSON(builder, typed[key]); err != nil {
				return err
			}
		}
		builder.WriteByte('}')
	default:
		return fmt.Errorf("无法规范化 JSON 值 %T", value)
	}
	return nil
}

// writeJSONString 复刻 JSON.stringify 的字符串转义（不转义 HTML、不转义 U+2028/2029）。
func writeJSONString(builder *strings.Builder, value string) {
	builder.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			builder.WriteString("\\\"")
		case '\\':
			builder.WriteString("\\\\")
		case '\b':
			builder.WriteString("\\b")
		case '\f':
			builder.WriteString("\\f")
		case '\n':
			builder.WriteString("\\n")
		case '\r':
			builder.WriteString("\\r")
		case '\t':
			builder.WriteString("\\t")
		default:
			if character < 0x20 {
				builder.WriteString(fmt.Sprintf("\\u%04x", character))
			} else {
				builder.WriteRune(character)
			}
		}
	}
	builder.WriteByte('"')
}

func writeJSONNumber(builder *strings.Builder, raw string) error {
	number, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return fmt.Errorf("数字无效: %s", raw)
	}
	if number == 0 {
		builder.WriteByte('0')
		return nil
	}
	absolute := math.Abs(number)
	if absolute >= 1e-6 && absolute < 1e21 {
		builder.WriteString(strconv.FormatFloat(number, 'f', -1, 64))
		return nil
	}
	formatted := strconv.FormatFloat(number, 'e', -1, 64)
	builder.WriteString(normalizeExponent(formatted))
	return nil
}

// normalizeExponent 把 Go 的 e-07 规范成 JS 的 e-7。
func normalizeExponent(value string) string {
	index := strings.IndexAny(value, "eE")
	if index < 0 {
		return value
	}
	mantissa := value[:index]
	exponent := value[index+1:]
	sign := ""
	if strings.HasPrefix(exponent, "+") || strings.HasPrefix(exponent, "-") {
		sign = exponent[:1]
		exponent = exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}
