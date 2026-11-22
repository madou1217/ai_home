package proxykit

import (
	"regexp"
	"strings"
)

var (
	multiSpacePattern = regexp.MustCompile(`\s+`)
	surgeNameBadChars = strings.NewReplacer(",", " ", "=", " ")
)

// SanitizeSurgeName 清洗 Surge 系配置中不允许的名称字符。
func SanitizeSurgeName(name string) string {
	cleaned := surgeNameBadChars.Replace(name)
	cleaned = multiSpacePattern.ReplaceAllString(cleaned, " ")
	return strings.TrimSpace(cleaned)
}
