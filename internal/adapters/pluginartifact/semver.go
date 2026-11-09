package pluginartifact

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// 这里实现 node-semver 的一个受控子集：清单与 engines 使用到的
// 严格版本、比较符、^、~、x-range、连字符区间与 || 组合。
// 与 Node 的语义保持一致，尤其是「预发布版本默认不进入区间」这条规则。

var semverVersionPattern = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

type semVersion struct {
	major      uint64
	minor      uint64
	patch      uint64
	prerelease []string
}

func parseSemver(text string) (semVersion, bool) {
	match := semverVersionPattern.FindStringSubmatch(strings.TrimSpace(text))
	if match == nil {
		return semVersion{}, false
	}
	major, err := strconv.ParseUint(match[1], 10, 64)
	if err != nil {
		return semVersion{}, false
	}
	minor, err := strconv.ParseUint(match[2], 10, 64)
	if err != nil {
		return semVersion{}, false
	}
	patch, err := strconv.ParseUint(match[3], 10, 64)
	if err != nil {
		return semVersion{}, false
	}
	version := semVersion{major: major, minor: minor, patch: patch}
	if match[4] != "" {
		version.prerelease = strings.Split(match[4], ".")
	}
	return version, true
}

// validSemver 与 node-semver 的 semver.valid 对齐：必须是完整的三段版本。
func validSemver(text string) bool {
	_, ok := parseSemver(text)
	return ok
}

func compareSemver(left semVersion, right semVersion) int {
	if left.major != right.major {
		return compareUint(left.major, right.major)
	}
	if left.minor != right.minor {
		return compareUint(left.minor, right.minor)
	}
	if left.patch != right.patch {
		return compareUint(left.patch, right.patch)
	}
	return comparePrerelease(left.prerelease, right.prerelease)
}

func compareUint(left uint64, right uint64) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func comparePrerelease(left []string, right []string) int {
	if len(left) == 0 && len(right) == 0 {
		return 0
	}
	// 正式版本高于同号预发布版本。
	if len(left) == 0 {
		return 1
	}
	if len(right) == 0 {
		return -1
	}
	for index := 0; index < len(left) && index < len(right); index++ {
		if comparison := comparePrereleaseIdentifier(left[index], right[index]); comparison != 0 {
			return comparison
		}
	}
	return compareUint(uint64(len(left)), uint64(len(right)))
}

func comparePrereleaseIdentifier(left string, right string) int {
	leftNumeric, leftErr := strconv.ParseUint(left, 10, 64)
	rightNumeric, rightErr := strconv.ParseUint(right, 10, 64)
	leftIsNumeric := leftErr == nil
	rightIsNumeric := rightErr == nil
	switch {
	case leftIsNumeric && rightIsNumeric:
		return compareUint(leftNumeric, rightNumeric)
	case leftIsNumeric:
		return -1 // 数字标识符低于字母标识符
	case rightIsNumeric:
		return 1
	default:
		return strings.Compare(left, right)
	}
}

type semComparator struct {
	operator string // "", ">", ">=", "<", "<="
	version  semVersion
}

type semComparatorSet []semComparator

type semRange []semComparatorSet

func (parsed semRange) satisfies(version semVersion) bool {
	for _, set := range parsed {
		if set.satisfies(version) {
			return true
		}
	}
	return false
}

func (set semComparatorSet) satisfies(version semVersion) bool {
	for _, comparator := range set {
		switch comparator.operator {
		case ">":
			if compareSemver(version, comparator.version) <= 0 {
				return false
			}
		case ">=":
			if compareSemver(version, comparator.version) < 0 {
				return false
			}
		case "<":
			if compareSemver(version, comparator.version) >= 0 {
				return false
			}
		case "<=":
			if compareSemver(version, comparator.version) > 0 {
				return false
			}
		default:
			if compareSemver(version, comparator.version) != 0 {
				return false
			}
		}
	}
	if len(version.prerelease) > 0 {
		// node-semver：预发布版本只有在同一 [major,minor,patch] 的比较符
		// 自身带预发布标识时才允许匹配。
		for _, comparator := range set {
			if len(comparator.version.prerelease) > 0 &&
				comparator.version.major == version.major &&
				comparator.version.minor == version.minor &&
				comparator.version.patch == version.patch {
				return true
			}
		}
		return false
	}
	return true
}

type partialVersion struct {
	major      uint64
	minor      uint64
	patch      uint64
	majorSet   bool
	minorSet   bool
	patchSet   bool
	prerelease []string
}

func (partial partialVersion) lower() semVersion {
	return semVersion{major: partial.major, minor: partial.minor, patch: partial.patch, prerelease: partial.prerelease}
}

func parsePartial(text string) (partialVersion, bool) {
	raw := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "v"))
	if raw == "" {
		return partialVersion{}, false
	}
	core := raw
	if index := strings.IndexAny(core, "+"); index >= 0 {
		core = core[:index]
	}
	prerelease := []string(nil)
	if index := strings.Index(core, "-"); index >= 0 {
		prerelease = strings.Split(core[index+1:], ".")
		core = core[:index]
	}
	parts := strings.Split(core, ".")
	if len(parts) > 3 {
		return partialVersion{}, false
	}
	partial := partialVersion{prerelease: prerelease}
	values := []*uint64{&partial.major, &partial.minor, &partial.patch}
	flags := []*bool{&partial.majorSet, &partial.minorSet, &partial.patchSet}
	for index, part := range parts {
		if part == "" {
			return partialVersion{}, false
		}
		if part == "x" || part == "X" || part == "*" {
			break
		}
		value, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return partialVersion{}, false
		}
		*values[index] = value
		*flags[index] = true
	}
	return partial, true
}

func (partial partialVersion) upperForWildcard() semVersion {
	switch {
	case !partial.majorSet:
		return semVersion{}
	case !partial.minorSet:
		return semVersion{major: partial.major + 1}
	case !partial.patchSet:
		return semVersion{major: partial.major, minor: partial.minor + 1}
	default:
		return semVersion{major: partial.major, minor: partial.minor, patch: partial.patch + 1}
	}
}

func parseSemverRange(text string) (semRange, error) {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return semRange{{}}, nil
	}
	alternatives := strings.Split(normalized, "||")
	parsed := make(semRange, 0, len(alternatives))
	for _, alternative := range alternatives {
		set, err := parseComparatorSet(strings.TrimSpace(alternative))
		if err != nil {
			return nil, err
		}
		parsed = append(parsed, set)
	}
	return parsed, nil
}

func parseComparatorSet(text string) (semComparatorSet, error) {
	if text == "" || text == "*" || text == "x" || text == "X" {
		return semComparatorSet{}, nil
	}
	// 连字符区间：a - b
	if left, right, found := strings.Cut(text, " - "); found {
		leftPartial, ok := parsePartial(left)
		if !ok {
			return nil, fmt.Errorf("无效的版本区间: %s", text)
		}
		rightPartial, ok := parsePartial(right)
		if !ok {
			return nil, fmt.Errorf("无效的版本区间: %s", text)
		}
		set := semComparatorSet{}
		if leftPartial.majorSet {
			set = append(set, semComparator{operator: ">=", version: leftPartial.lower()})
		}
		if rightPartial.majorSet {
			if !rightPartial.minorSet || !rightPartial.patchSet {
				set = append(set, semComparator{operator: "<", version: rightPartial.upperForWildcard()})
			} else {
				set = append(set, semComparator{operator: "<=", version: rightPartial.lower()})
			}
		}
		return set, nil
	}
	fields := strings.Fields(text)
	set := semComparatorSet{}
	for index := 0; index < len(fields); index++ {
		token := fields[index]
		if strings.HasPrefix(token, "~>") {
			token = "~" + strings.TrimPrefix(token, "~>")
		}
		operator := ""
		for _, candidate := range []string{">=", "<=", ">", "<", "=", "~", "^"} {
			if strings.HasPrefix(token, candidate) {
				operator = candidate
				token = strings.TrimSpace(strings.TrimPrefix(token, candidate))
				break
			}
		}
		if token == "" && index+1 < len(fields) {
			index++
			token = fields[index]
		}
		if token == "" {
			if operator != "" {
				return nil, fmt.Errorf("无效的版本区间: %s", text)
			}
			continue
		}
		if token == "*" || token == "x" || token == "X" {
			continue
		}
		partial, ok := parsePartial(token)
		if !ok {
			return nil, fmt.Errorf("无效的版本区间: %s", text)
		}
		expanded, err := expandComparator(operator, partial)
		if err != nil {
			return nil, err
		}
		set = append(set, expanded...)
	}
	return set, nil
}

func expandComparator(operator string, partial partialVersion) (semComparatorSet, error) {
	lower := partial.lower()
	switch operator {
	case "^":
		upper := semVersion{}
		switch {
		case !partial.majorSet:
			return semComparatorSet{}, nil
		case partial.major > 0:
			upper = semVersion{major: partial.major + 1}
		case !partial.minorSet:
			upper = semVersion{major: 1}
		case partial.minor > 0:
			upper = semVersion{major: 0, minor: partial.minor + 1}
		case !partial.patchSet:
			upper = semVersion{major: 0, minor: 1}
		default:
			upper = semVersion{major: 0, minor: 0, patch: partial.patch + 1}
		}
		return semComparatorSet{
			{operator: ">=", version: lower},
			{operator: "<", version: upper},
		}, nil
	case "~":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		upper := semVersion{major: partial.major + 1}
		if partial.minorSet {
			upper = semVersion{major: partial.major, minor: partial.minor + 1}
		}
		return semComparatorSet{
			{operator: ">=", version: lower},
			{operator: "<", version: upper},
		}, nil
	case "":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		if !partial.minorSet || !partial.patchSet {
			return semComparatorSet{
				{operator: ">=", version: lower},
				{operator: "<", version: partial.upperForWildcard()},
			}, nil
		}
		return semComparatorSet{{operator: "", version: lower}}, nil
	case "=":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		if !partial.minorSet || !partial.patchSet {
			return semComparatorSet{
				{operator: ">=", version: lower},
				{operator: "<", version: partial.upperForWildcard()},
			}, nil
		}
		return semComparatorSet{{operator: "", version: lower}}, nil
	case ">=":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		return semComparatorSet{{operator: ">=", version: lower}}, nil
	case ">":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		if !partial.minorSet || !partial.patchSet {
			return semComparatorSet{{operator: ">=", version: partial.upperForWildcard()}}, nil
		}
		return semComparatorSet{{operator: ">", version: lower}}, nil
	case "<":
		if !partial.majorSet {
			return semComparatorSet{{operator: "<", version: semVersion{}}}, nil
		}
		return semComparatorSet{{operator: "<", version: lower}}, nil
	case "<=":
		if !partial.majorSet {
			return semComparatorSet{}, nil
		}
		if !partial.minorSet || !partial.patchSet {
			return semComparatorSet{{operator: "<", version: partial.upperForWildcard()}}, nil
		}
		return semComparatorSet{{operator: "<=", version: lower}}, nil
	}
	return nil, fmt.Errorf("不支持的版本比较符: %s", operator)
}

// satisfiesSemverRange 返回 version 是否落在 range 内；range 无效时返回 false。
func satisfiesSemverRange(version string, text string) bool {
	parsedVersion, ok := parseSemver(version)
	if !ok {
		return false
	}
	parsedRange, err := parseSemverRange(text)
	if err != nil {
		return false
	}
	return parsedRange.satisfies(parsedVersion)
}

// validSemverRange 与 node-semver 的 semver.validRange 对齐（只判断能否解析）。
func validSemverRange(text string) bool {
	_, err := parseSemverRange(text)
	return err == nil
}
