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
	AccountRefHashLength  = 20
	accountIdentityDomain = "unique:"
	accountRefLength      = len(AccountRefPrefix) + AccountRefHashLength
)

var (
	// ErrInvalidAccountRef 表示公开账号业务身份不符合规范格式。
	ErrInvalidAccountRef = errors.New("账号引用无效")
)

// AccountRef 是全链路使用的稳定公开账号业务身份。
//
// 它不包含 Provider 凭据，也不等同于本机可变的 CLI 数字别名。
type AccountRef string

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

// isCanonicalAccountRef 使用固定长度检查避免在高频解析路径创建正则表达式。
func isCanonicalAccountRef(value string) bool {
	if len(value) != accountRefLength ||
		!strings.HasPrefix(value, AccountRefPrefix) {
		return false
	}
	for _, character := range value[len(AccountRefPrefix):] {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// deriveAccountRefFromSeed 使用一次输入分配构建稳定哈希，供已校验身份复用。
func deriveAccountRefFromSeed(identitySeed string) AccountRef {
	hashInput := make([]byte, len(accountIdentityDomain)+len(identitySeed))
	copy(hashInput, accountIdentityDomain)
	copy(hashInput[len(accountIdentityDomain):], identitySeed)
	digest := sha256.Sum256(hashInput)

	var encoded [accountRefLength]byte
	copy(encoded[:], AccountRefPrefix)
	hex.Encode(encoded[len(AccountRefPrefix):], digest[:AccountRefHashLength/2])
	return AccountRef(string(encoded[:]))
}
