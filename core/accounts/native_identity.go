package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"net/mail"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

// NativeIdentity 是 Provider adapter 经过证据校验后得到的封闭身份值。
// 字段全部私有，调用方不能把任意 identitySeed 注入账号领域；只能通过下面按
// Provider 语义命名的构造器产生种子，SQLite 恢复也因此必须重新运行 adapter。
type NativeIdentity struct {
	providerID string
	authKind   string
	seed       string
}

// ProviderID returns the fixed Provider scope carried by this identity value.
func (identity NativeIdentity) ProviderID() string { return identity.providerID }

// AuthKind returns the credential mode derived by the Provider policy.
func (identity NativeIdentity) AuthKind() string { return identity.authKind }

// IdentitySeed returns the already-derived local identity vector.
func (identity NativeIdentity) IdentitySeed() string { return identity.seed }

// NewNativeSubjectIdentity 为拒绝邮箱回退的 OAuth Provider 构造稳定主体身份。
func NewNativeSubjectIdentity(providerID, subject string) (NativeIdentity, error) {
	if !nativeSubjectProvider(providerID) || !validNativeSubject(subject) {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	return nativeIdentity(providerID, "oauth", "oauth:"+providerID+":user:"+digest16(subject)), nil
}

// NewNativeEmailIdentity 为只有官方邮箱可作为主体的 Provider 构造身份。
func NewNativeEmailIdentity(providerID, email string) (NativeIdentity, error) {
	if providerID != "gemini" && providerID != "agy" {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	normalized, err := normalizeNativeEmail(email)
	if err != nil {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	return nativeIdentity(providerID, "oauth", "oauth:"+providerID+":"+normalized), nil
}

// NativeOpenCodeGrant 是一个 OpenCode upstream grant 的已验证身份输入。
// API key 只在 Secret 中传递给构造器并立即哈希；OAuth 则使用 Subject。
type NativeOpenCodeGrant struct {
	Upstream string
	Type     string
	Subject  string
	Secret   string
}

// NewNativeOpenCodeIdentity 按 upstream/type 和稳定主体生成 OpenCode 身份集合。
func NewNativeOpenCodeIdentity(grants []NativeOpenCodeGrant) (NativeIdentity, error) {
	if len(grants) == 0 || len(grants) > 256 {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	entries := make([]string, 0, len(grants))
	authKind := "api-key"
	seen := make(map[string]struct{}, len(grants))
	for _, grant := range grants {
		upstream := strings.ToLower(strings.TrimSpace(grant.Upstream))
		if !validNativeSubject(upstream) {
			return NativeIdentity{}, ErrInvalidNativeCredential
		}
		typ := strings.ToLower(strings.TrimSpace(grant.Type))
		if typ == "" {
			typ = "unknown"
		}
		var entry string
		switch typ {
		case "api", "api-key", "unknown":
			if !validNativeSecret(grant.Secret) || grant.Subject != "" {
				return NativeIdentity{}, ErrInvalidNativeCredential
			}
			entry = upstream + ":" + typ + ":key:" + digest16(grant.Secret)
		case "oauth":
			if !validNativeSubject(grant.Subject) || grant.Secret != "" {
				return NativeIdentity{}, ErrInvalidNativeCredential
			}
			entry = upstream + ":oauth:id:" + grant.Subject
			authKind = "oauth"
		default:
			return NativeIdentity{}, ErrInvalidNativeCredential
		}
		if _, exists := seen[upstream]; exists {
			return NativeIdentity{}, ErrInvalidNativeCredential
		}
		seen[upstream] = struct{}{}
		entries = append(entries, entry)
	}
	sort.Strings(entries)
	return nativeIdentity("opencode", authKind, "oauth:opencode:auth:"+digest16(strings.Join(entries, "\n"))), nil
}

// NewNativeGrokIdentity scopes the stable native user/principal set to Grok.
func NewNativeGrokIdentity(ids []string) (NativeIdentity, error) {
	if len(ids) == 0 || len(ids) > 256 {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	entries := make([]string, 0, len(ids))
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if !validNativeSubject(id) {
			return NativeIdentity{}, ErrInvalidNativeCredential
		}
		entry := "id:" + id
		if _, exists := seen[entry]; exists {
			continue
		}
		seen[entry] = struct{}{}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	sort.Strings(entries)
	return nativeIdentity("grok", "oauth", "oauth:grok:auth:"+digest16(strings.Join(entries, "\n"))), nil
}

// NewNativeQoderIdentity uses only the materialized UID, never display labels.
func NewNativeQoderIdentity(providerID, uid string) (NativeIdentity, error) {
	if (providerID != "qoder" && providerID != "qodercn") || !validNativeSubject(uid) {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	return nativeIdentity(providerID, "oauth", "oauth:"+providerID+":uid:"+uid), nil
}

// NewNativeQoderPATIdentity derives the documented PAT fingerprint for static imports.
func NewNativeQoderPATIdentity(providerID, pat string) (NativeIdentity, error) {
	if (providerID != "qoder" && providerID != "qodercn") || !validNativeSecret(pat) {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	return nativeIdentity(providerID, "api-key", "api_key:"+providerID+":pat:"+digest16(pat)), nil
}

// NewNativeKiroIdentity requires authenticated GetUsageLimits evidence.
func NewNativeKiroIdentity(endpoint, subject string) (NativeIdentity, error) {
	if !validKiroEndpoint(endpoint) || !validNativeSubject(subject) {
		return NativeIdentity{}, ErrInvalidNativeCredential
	}
	return nativeIdentity("kiro", "oauth", "oauth:kiro:user:"+digest16(endpoint+"\n"+subject)), nil
}

func (identity NativeIdentity) IsValid() bool {
	return isCanonicalProviderID(identity.providerID) && validNativeAuthKind(identity.authKind) &&
		isCanonicalIdentitySeed(identity.seed) &&
		(strings.HasPrefix(identity.seed, nativeIdentityPrefix(identity.providerID, identity.authKind)) ||
			(identity.providerID == "opencode" && strings.HasPrefix(identity.seed, "oauth:opencode:auth:")))
}

func nativeIdentity(providerID, authKind, seed string) NativeIdentity {
	return NativeIdentity{providerID: providerID, authKind: authKind, seed: seed}
}

func nativeSubjectProvider(providerID string) bool {
	switch providerID {
	case "kimi", "zcode", "codebuddy", "codebuddycn", "workbuddy", "workbuddycn":
		return true
	default:
		return false
	}
}

func validNativeAuthKind(value string) bool {
	return value == "oauth" || value == "api-key" || value == "pat"
}

func nativeIdentityPrefix(providerID, authKind string) string {
	if authKind == "api-key" || authKind == "pat" {
		return "api_key:" + providerID + ":"
	}
	return "oauth:" + providerID + ":"
}

// ValidNativeSubject deliberately matches the strict Node subject policy. This
// validates identity metadata, not the upstream JWT signature.
func ValidNativeSubject(value string) bool {
	return utf8.ValidString(value) && value != "" && len(value) <= 1024 &&
		value == strings.TrimSpace(value) && strings.IndexFunc(value, func(r rune) bool {
		return r == ':' || r == '\ufffd' || r < 0x20 || r == 0x7f || unicode.IsSpace(r)
	}) < 0
}

func validNativeSubject(value string) bool { return ValidNativeSubject(value) }

func validNativeSecret(value string) bool {
	return value != "" && value == strings.TrimSpace(value) && len(value) <= maxNativeCredentialBytes &&
		strings.IndexFunc(value, func(character rune) bool {
			return character < 0x20 || character == 0x7f
		}) < 0
}

func normalizeNativeEmail(value string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	parsed, err := mail.ParseAddress(normalized)
	if err != nil || parsed.Address != normalized || strings.Count(normalized, "@") != 1 || len(normalized) > 320 {
		return "", ErrInvalidNativeCredential
	}
	return normalized, nil
}

var kiroEndpointPattern = regexp.MustCompile(`^https://codewhisperer\.[a-z]{2}-[a-z]+-[0-9]\.amazonaws\.com$`)

func validKiroEndpoint(value string) bool { return kiroEndpointPattern.MatchString(value) }

func digest16(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])[:16]
}

// String prevents debug formatting of constructor inputs from leaking API keys.
func (grant NativeOpenCodeGrant) String() string   { return "NativeOpenCodeGrant{redacted:true}" }
func (grant NativeOpenCodeGrant) GoString() string { return grant.String() }
