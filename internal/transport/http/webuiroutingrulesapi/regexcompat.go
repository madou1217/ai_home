package webuiroutingrulesapi

import (
	"fmt"
	"regexp"
	"strings"

	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// Node 读侧（lib/account/upstream-error-rules.js 的 compilePattern）在解析 env 时
// 还会做一次「防灾难性回溯」白名单：禁分组、禁反向引用、每分支最多一个量词、
// 禁 `{`，且带重复量词的分支若有后续内容必须以 ^ 锚定。
//
// Go 的 core/upstreamrules 只能保证 RE2 可编译，是 Node 接受集合的超集；写侧如果
// 不补这层检查，一条 `(a)+` 之类的规则会让 Node 读侧整份丢弃账号的全部规则，
// 表现为「保存成功但规则从不生效」。因此写 env 前必须按读侧契约再校验一次。
var (
	nodeEscapedAtom     = regexp.MustCompile(`\\[^1-9]`)
	nodeCharClass       = regexp.MustCompile(`\[[^\]]*\]`)
	nodeBackreference   = regexp.MustCompile(`\\[1-9]`)
	nodeQuantifier      = regexp.MustCompile(`[+*?{]`)
	nodeRepetitionChars = "+*"
)

// assertNodeReaderCompatible 校验一条规则里的全部正则；停用规则同样检查，
// 因为 Node 读侧校验不区分 enabled。
func assertNodeReaderCompatible(rule rulescore.Rule) error {
	for _, matcher := range rule.Matchers() {
		if matcher.IsLegacy() {
			if err := checkNodePattern(matcher.Pattern()); err != nil {
				return err
			}
			continue
		}
		if matcher.Operator() == rulescore.OperatorRegex {
			if err := checkNodePattern(rulescore.TextOf(matcher.Value())); err != nil {
				return err
			}
		}
	}
	return nil
}

// checkNodePattern 复刻 Node compilePattern 的接受集合。
func checkNodePattern(pattern string) error {
	atoms := nodeEscapedAtom.ReplaceAllString(pattern, "x")
	atoms = nodeCharClass.ReplaceAllString(atoms, "x")
	if strings.ContainsAny(atoms, "()") || nodeBackreference.MatchString(pattern) {
		return fmt.Errorf("%w: 正则不支持分组与反向引用", rulescore.ErrInvalidRules)
	}
	if strings.Contains(atoms, "{") {
		return fmt.Errorf("%w: 正则不支持 {n} 计数重复", rulescore.ErrInvalidRules)
	}
	branches := strings.Split(atoms, "|")
	for _, branch := range branches {
		if len(nodeQuantifier.FindAllString(branch, -1)) > 1 {
			return fmt.Errorf("%w: 每个候选分支最多一个基础量词", rulescore.ErrInvalidRules)
		}
	}
	for _, branch := range branches {
		index := strings.IndexAny(branch, nodeRepetitionChars)
		// 无起点锚定的 a+b 在不匹配的长文本上会反复扫描后缀；Node 直接拒绝。
		if index >= 0 && index < len(branch)-1 && !strings.HasPrefix(branch, "^") {
			return fmt.Errorf("%w: 带重复量词和后续内容的分支须以 ^ 锚定", rulescore.ErrInvalidRules)
		}
	}
	return nil
}
