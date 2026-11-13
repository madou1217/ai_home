// Package providercliupgrade 提供 Provider CLI 自动升级的运行态、周期调度与账本投影。
package providercliupgrade

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	// 与 Node normalizeVersion 完全对齐：允许 2~4 段版本号、可选 prerelease 与 +build。
	semverExtractRe = regexp.MustCompile(`(?:^|[^0-9])v?(\d+(?:\.\d+){1,3})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?(?:$|[^0-9A-Za-z])`)
	safeVersionRe   = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z.+-]*$`)
	strictStableRe  = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
)

// ParsedVersion 表示解析后的语义化版本号（与 Node app-update-checker 同口径）。
type ParsedVersion struct {
	Parts      [4]int
	PartCount  int
	Prerelease []string
	Text       string
}

// ParseVersion 从任意 CLI 自报文本或版本号串中提取语义化版本号。
func ParseVersion(raw string) (ParsedVersion, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ParsedVersion{}, false
	}
	match := semverExtractRe.FindStringSubmatch(trimmed)
	if len(match) < 2 {
		return ParsedVersion{}, false
	}
	segments := strings.Split(match[1], ".")
	if len(segments) < 2 || len(segments) > 4 {
		return ParsedVersion{}, false
	}
	var parts [4]int
	for idx, segment := range segments {
		value, err := strconv.Atoi(segment)
		if err != nil {
			return ParsedVersion{}, false
		}
		parts[idx] = value
	}
	var prerelease []string
	preRaw := ""
	if len(match) > 2 {
		preRaw = match[2]
	}
	if preRaw != "" {
		for _, item := range strings.Split(preRaw, ".") {
			if item != "" {
				prerelease = append(prerelease, item)
			}
		}
	}
	text := match[1]
	if preRaw != "" {
		text += "-" + preRaw
	}
	return ParsedVersion{
		Parts:      parts,
		PartCount:  len(segments),
		Prerelease: prerelease,
		Text:       text,
	}, true
}

// NormalizeVersionText 提取干净的版本号文本；提取失败则回退到去空白原文。
func NormalizeVersionText(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if parsed, ok := ParseVersion(trimmed); ok {
		return parsed.Text
	}
	return trimmed
}

// CompareVersions 比较两个版本号；任一不可解析时返回 (0, false)。
// 比较前三段数字后再按 SemVer 预发布规则判定（正式版 > 预发布）。
func CompareVersions(leftRaw, rightRaw string) (int, bool) {
	left, okL := ParseVersion(leftRaw)
	right, okR := ParseVersion(rightRaw)
	if !okL || !okR {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if left.Parts[i] != right.Parts[i] {
			if left.Parts[i] < right.Parts[i] {
				return -1, true
			}
			return 1, true
		}
	}
	lHasPre := len(left.Prerelease) > 0
	rHasPre := len(right.Prerelease) > 0
	if !lHasPre && rHasPre {
		return 1, true
	}
	if lHasPre && !rHasPre {
		return -1, true
	}
	limit := len(left.Prerelease)
	if len(right.Prerelease) > limit {
		limit = len(right.Prerelease)
	}
	for i := 0; i < limit; i++ {
		if i >= len(left.Prerelease) {
			return -1, true
		}
		if i >= len(right.Prerelease) {
			return 1, true
		}
		ls := left.Prerelease[i]
		rs := right.Prerelease[i]
		if ls == rs {
			continue
		}
		lNum, lIsNum := parseUintDigits(ls)
		rNum, rIsNum := parseUintDigits(rs)
		if lIsNum && rIsNum {
			if lNum < rNum {
				return -1, true
			}
			return 1, true
		}
		if lIsNum != rIsNum {
			if lIsNum {
				return -1, true
			}
			return 1, true
		}
		if ls < rs {
			return -1, true
		}
		return 1, true
	}
	return 0, true
}

func parseUintDigits(value string) (int, bool) {
	if value == "" {
		return 0, false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return 0, false
		}
	}
	num, err := strconv.Atoi(value)
	if err != nil {
		return 0, false
	}
	return num, true
}

// NormalizeVersionSpec 校验并规范化用于 env / npm spec 的安全版本号字符串。
func NormalizeVersionSpec(value string) string {
	trimmed := strings.TrimSpace(value)
	if !safeVersionRe.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

// IsStrictStableVersion 判断是否为标准三段正式版本（x.y.z）。
func IsStrictStableVersion(value string) bool {
	return strictStableRe.MatchString(strings.TrimSpace(value))
}
