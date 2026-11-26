// Package identityderive 从账号当前凭据里重新解析可展示身份。
//
// 设计取向：不读取任何历史/兼容展示名，也不按 Provider 写死字段路径。凭据本身
// 就携带了 userInfo / account / userInfo.email 等事实，这里做一次受控的递归提取：
// 只认明确的身份键，跳过令牌类字段，产出 email / phone / nickname 三个规范事实。
package identityderive

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
)

// Identity 是重新解析出的账号身份事实。
type Identity struct {
	Email       string
	Phone       string
	Nickname    string
	DisplayName string
}

// IsEmpty 表示没有解析出任何可用身份。
func (identity Identity) IsEmpty() bool {
	return identity.Email == "" && identity.Phone == "" && identity.Nickname == ""
}

var (
	emailPattern       = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)
	syntheticPhoneMail = regexp.MustCompile(`(?i)^(\d{6,})@phone\.local$`)
	phonePattern       = regexp.MustCompile(`^[+()\-\s\d*]{6,32}$`)
	uuidPattern        = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	schemePattern      = regexp.MustCompile(`^[a-z][a-z0-9+.-]*://`)
	numberPattern      = regexp.MustCompile(`^\d+$`)
)

// 身份键（小写、去掉 _ - 后比较）。
var (
	emailKeys = map[string]bool{
		"email": true, "emailaddress": true, "mail": true, "useremail": true, "accountemail": true,
	}
	phoneKeys = map[string]bool{
		"phone": true, "phonenumber": true, "mobile": true, "mobilephone": true, "telephone": true,
	}
	nicknameKeys = map[string]bool{
		"nickname": true, "username": true, "displayname": true, "accountname": true,
		"fullname": true, "name": true,
	}
	firstNameKeys = map[string]bool{"firstname": true, "givenname": true}
	lastNameKeys  = map[string]bool{"lastname": true, "familyname": true, "surname": true}
)

// 不参与身份提取的子树/键：令牌、密钥、签名、授权。
var bannedKeyParts = []string{
	"token", "secret", "password", "passwd", "refresh", "access", "signature",
	"authorization", "cookie", "apikey", "api_key", "credentialsecret", "privatekey",
}

type candidate struct {
	value string
	score int
	path  string
}

type collector struct {
	emails  []candidate
	phones  []candidate
	nicks   []candidate
	first   []candidate
	last    []candidate
	visited int
}

// Derive 从 credential_json 原文解析身份。第二个返回值表示是否解析到任何事实。
func Derive(credentialJSON []byte) (Identity, bool) {
	var document any
	if err := json.Unmarshal(credentialJSON, &document); err != nil {
		return Identity{}, false
	}
	document = expandNativeAuth(document)
	collector := &collector{}
	collector.walk(document, "", 0)
	return collector.build()
}

// expandNativeAuth 把凭据信封里的 native_auth_json（可能是字符串）展开成对象。
func expandNativeAuth(document any) any {
	object, ok := document.(map[string]any)
	if !ok {
		return document
	}
	inner, exists := object["native_auth_json"]
	if !exists {
		return document
	}
	if text, ok := inner.(string); ok {
		var parsed any
		if json.Unmarshal([]byte(text), &parsed) == nil {
			return parsed
		}
	}
	return inner
}

func (collector *collector) walk(value any, path string, depth int) {
	if depth > 8 || collector.visited > 20000 {
		return
	}
	collector.visited++
	switch typed := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			normalized := normalizeKey(key)
			if isBannedKey(normalized) {
				continue
			}
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			child := typed[key]
			if text, ok := child.(string); ok {
				collector.consider(normalized, text, childPath, depth)
				continue
			}
			collector.walk(child, childPath, depth+1)
		}
	case []any:
		for index, child := range typed {
			if index >= 10 {
				break
			}
			collector.walk(child, path, depth+1)
		}
	}
}

func (collector *collector) consider(key, raw, path string, depth int) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return
	}
	score := 100 - depth*5 - strings.Count(path, ".")
	switch {
	case emailKeys[key] || strings.Contains(key, "email"):
		if match := syntheticPhoneMail.FindStringSubmatch(value); match != nil {
			collector.phones = append(collector.phones, candidate{value: match[1], score: score + 10, path: path})
			return
		}
		if emailPattern.MatchString(value) {
			collector.emails = append(collector.emails, candidate{value: value, score: score, path: path})
		}
	case phoneKeys[key] || strings.Contains(key, "phone") || strings.Contains(key, "mobile"):
		if phonePattern.MatchString(value) {
			collector.phones = append(collector.phones, candidate{value: value, score: score, path: path})
		}
	case firstNameKeys[key]:
		collector.first = append(collector.first, candidate{value: value, score: score, path: path})
	case lastNameKeys[key]:
		collector.last = append(collector.last, candidate{value: value, score: score, path: path})
	case nicknameKeys[key]:
		if isMeaningfulNickname(value) {
			collector.nicks = append(collector.nicks, candidate{value: value, score: score, path: path})
		}
	}
}

func (collector *collector) build() (Identity, bool) {
	identity := Identity{}
	identity.Email = best(collector.emails)
	identity.Phone = best(collector.phones)
	identity.Nickname = best(collector.nicks)
	if identity.Nickname == "" && len(collector.first) > 0 && len(collector.last) > 0 {
		identity.Nickname = strings.TrimSpace(best(collector.first) + " " + best(collector.last))
	}
	if identity.Nickname == identity.Email {
		identity.Nickname = ""
	}
	// 部分 Provider 把邮箱填在 nickname（如 meadeodeo@gmail.com）：
	// 有邮箱语义就归到 email，避免昵称与邮箱重复。
	if identity.Nickname != "" && emailPattern.MatchString(identity.Nickname) {
		if identity.Email == "" {
			identity.Email = identity.Nickname
		}
		identity.Nickname = ""
	}
	switch {
	case identity.Nickname != "":
		identity.DisplayName = identity.Nickname
	case identity.Email != "":
		identity.DisplayName = identity.Email
	default:
		identity.DisplayName = identity.Phone
	}
	return identity, !identity.IsEmpty()
}

// best 取分数最高、路径最短的候选。
func best(values []candidate) string {
	if len(values) == 0 {
		return ""
	}
	sort.SliceStable(values, func(left, right int) bool {
		if values[left].score != values[right].score {
			return values[left].score > values[right].score
		}
		leftDepth := strings.Count(values[left].path, ".")
		rightDepth := strings.Count(values[right].path, ".")
		if leftDepth != rightDepth {
			return leftDepth < rightDepth
		}
		return values[left].path < values[right].path
	})
	return values[0].value
}

func normalizeKey(key string) string {
	replacer := strings.NewReplacer("_", "", "-", "", " ", "")
	return strings.ToLower(replacer.Replace(strings.TrimSpace(key)))
}

func isBannedKey(key string) bool {
	for _, part := range bannedKeyParts {
		if strings.Contains(key, part) {
			return true
		}
	}
	return false
}

func isMeaningfulNickname(value string) bool {
	lower := strings.ToLower(value)
	if uuidPattern.MatchString(value) || numberPattern.MatchString(value) {
		return false
	}
	if schemePattern.MatchString(value) {
		return false
	}
	if len(value) > 128 {
		return false
	}
	if strings.HasPrefix(lower, "api key") || strings.HasPrefix(lower, "access token") {
		return false
	}
	if lower == "unknown" || lower == "null" {
		return false
	}
	return true
}