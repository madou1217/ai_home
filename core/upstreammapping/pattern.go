package upstreammapping

import (
	"regexp"
	"strings"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

var (
	// escapedAtomPattern 把「反斜杠 + 非数字」当作一个普通原子，避免转义字符影响分组检查。
	escapedAtomPattern = regexp.MustCompile(`\[^1-9]`)
	// characterClassPattern 把字符类折叠成一个原子，字符类内部的分组符号不算分组。
	characterClassPattern = regexp.MustCompile(`[[^]]*]`)
	// backReferencePattern 识别反向引用；Node 明确拒绝，Go 也必须拒绝才能保证配置可回推。
	backReferencePattern = regexp.MustCompile(`\[1-9]`)
	// quantifierPattern 统计每个候选分支里的量词数量。
	quantifierPattern = regexp.MustCompile(`[+*?{]`)
)

// validatePattern 复刻 Node compilePattern 的结构约束，再用 Go RE2 编译一次。
//
// 为什么两套检查都要：结构约束决定「Node 是否接受」，RE2 编译决定「Go 现在能否
// 执行」。只做后者会让 Go 接受 Node 不认的写法（例如内联旗标），配置一旦回推
// 就会在 Node 侧整组失效；只做前者又会让 RE2 不支持的写法落库后在匹配时才失败。
//
// 与 Node 唯一的已知差异：JS 的正则语法比 RE2 宽（例如 \u0041 转义），这类写法
// 会被这里判为「正则表达式无效」——写入口宁可拒绝，也不存一条自己执行不了的规则。
func validatePattern(pattern string) error {
	if length := len([]rune(pattern)); length == 0 || length > rulescore.MaxPatternLength {
		return invalid("正则长度须为 1–%d", rulescore.MaxPatternLength)
	}
	atoms := escapedAtomPattern.ReplaceAllString(pattern, "x")
	atoms = characterClassPattern.ReplaceAllString(atoms, "x")
	const unsupported = "正则支持锚点、字符类、候选分支，每个分支最多一个基础量词；不支持分组和反向引用"
	if strings.ContainsAny(atoms, "()") || backReferencePattern.MatchString(pattern) {
		return invalid("%s", unsupported)
	}
	for _, branch := range strings.Split(atoms, "|") {
		if strings.Contains(branch, "{") || len(quantifierPattern.FindAllString(branch, -1)) > 1 {
			return invalid("%s", unsupported)
		}
		// 无起点锚定的 a+b 在不匹配的长文本上会反复扫描后缀；Node 用这条规则
		// 防止灾难性回溯，Go 虽然用 RE2 不会回溯，但仍要保持同一份可回推配置。
		if index := strings.IndexAny(branch, "+*"); index >= 0 && index+1 < len(branch) &&
			!strings.HasPrefix(branch, "^") {
			return invalid("带重复量词和后续内容的分支须以 ^ 锚定；包含匹配请直接填写关键词")
		}
	}
	if _, err := regexp.Compile("(?i)" + pattern); err != nil {
		return invalid("正则表达式无效")
	}
	return nil
}
