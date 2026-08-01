package accounts

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
)

const (
	// AccountRefPrefix 是公开账号业务身份的固定前缀。
	AccountRefPrefix = "acct_"
	// AccountRefHashLength 是公开账号业务身份保留的 SHA-256 十六进制长度。
	AccountRefHashLength = 20
	// CredentialRefPrefix 是当前凭据查重引用的固定前缀。
	CredentialRefPrefix = "cred_"
	// CredentialRefHashLength 与账号引用保持相同的碰撞边界。
	CredentialRefHashLength = 20
	accountIdentityDomain   = "unique:"
	accountRefLength        = len(AccountRefPrefix) + AccountRefHashLength
	credentialRefLength     = len(CredentialRefPrefix) + CredentialRefHashLength
)

var (
	// ErrInvalidAccountRef 表示公开账号业务身份不符合规范格式。
	ErrInvalidAccountRef = errors.New("账号引用无效")
	// ErrInvalidCredentialRef 表示当前凭据查重引用不符合规范格式。
	ErrInvalidCredentialRef = errors.New("凭据引用无效")
)

// AccountRef 是全链路使用的稳定公开账号业务身份。
//
// 它不包含 Provider 凭据，也不等同于本机可变的 CLI 数字别名。
type AccountRef string

// CredentialRef 是当前凭据的不可逆查重引用。
//
// 它会随 API Key、Token、凭据类型或 Base URL 变化，不能作为账号主键使用。
type CredentialRef string

// DeriveAccountRef 从 Provider 认证值的稳定身份种子派生账号引用。
//
// 哈希输入保持现有业务合同，避免重构后改变 Server、Web、Runtime 和 Usage 的账号身份。
func DeriveAccountRef(source IdentitySource) (AccountRef, error) {
	_, identitySeed, err := readIdentitySource(source)
	if err != nil {
		return "", err
	}
	return deriveAccountRefFromSeed(identitySeed), nil
}

// DeriveCredentialRef 从当前 Provider 凭据派生只用于查重的引用。
func DeriveCredentialRef(source IdentitySource) (CredentialRef, error) {
	_, identitySeed, err := readIdentitySource(source)
	if err != nil {
		return "", err
	}
	return deriveCredentialRefFromSeed(identitySeed), nil
}

// ParseAccountRef 校验并创建规范账号引用，不隐式修剪或修改调用方输入。
func ParseAccountRef(value string) (AccountRef, error) {
	if !isCanonicalAccountRef(value) {
		return "", ErrInvalidAccountRef
	}
	return AccountRef(value), nil
}

// String 返回规范账号引用文本。
func (accountRef AccountRef) String() string {
	return string(accountRef)
}

// IsValid 判断账号引用是否符合当前业务合同。
func (accountRef AccountRef) IsValid() bool {
	return isCanonicalAccountRef(string(accountRef))
}

// ParseCredentialRef 校验并创建规范凭据引用。
func ParseCredentialRef(value string) (CredentialRef, error) {
	if !isCanonicalReference(value, CredentialRefPrefix, credentialRefLength) {
		return "", ErrInvalidCredentialRef
	}
	return CredentialRef(value), nil
}

// String 返回规范凭据引用文本。
func (credentialRef CredentialRef) String() string {
	return string(credentialRef)
}

// IsValid 判断凭据引用是否符合当前查重合同。
func (credentialRef CredentialRef) IsValid() bool {
	return isCanonicalReference(
		string(credentialRef),
		CredentialRefPrefix,
		credentialRefLength,
	)
}

// isCanonicalAccountRef 使用固定长度检查避免在高频解析路径创建正则表达式。
func isCanonicalAccountRef(value string) bool {
	return isCanonicalReference(value, AccountRefPrefix, accountRefLength)
}

// isCanonicalReference 使用固定长度和前缀校验公开哈希引用。
func isCanonicalReference(value string, prefix string, length int) bool {
	if len(value) != length || !strings.HasPrefix(value, prefix) {
		return false
	}
	for _, character := range value[len(prefix):] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// deriveAccountRefFromSeed 使用一次输入分配构建稳定哈希，供已校验身份复用。
func deriveAccountRefFromSeed(identitySeed string) AccountRef {
	return AccountRef(deriveReferenceFromSeed(identitySeed, AccountRefPrefix))
}

// deriveCredentialRefFromSeed 复用同一身份摘要并使用独立前缀，支持无损 v4 回填。
func deriveCredentialRefFromSeed(identitySeed string) CredentialRef {
	return CredentialRef(deriveReferenceFromSeed(identitySeed, CredentialRefPrefix))
}

// deriveReferenceFromSeed 对规范身份种子执行一次固定域哈希。
func deriveReferenceFromSeed(identitySeed string, prefix string) string {
	hashInput := make([]byte, len(accountIdentityDomain)+len(identitySeed))
	copy(hashInput, accountIdentityDomain)
	copy(hashInput[len(accountIdentityDomain):], identitySeed)
	digest := sha256.Sum256(hashInput)

	encoded := make([]byte, len(prefix)+AccountRefHashLength)
	copy(encoded, prefix)
	hex.Encode(encoded[len(prefix):], digest[:AccountRefHashLength/2])
	return string(encoded)
}
