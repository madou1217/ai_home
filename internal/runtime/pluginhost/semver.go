package pluginhost

import (
	"regexp"
	"strconv"
	"strings"
)

type semverVersion struct {
	major      int
	minor      int
	patch      int
	prerelease []string
}

var (
	semverExactRE  = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`)
	semverPrefixRE = regexp.MustCompile(`^(<=|>=|<|>|=)?\s*(.+)$`)
)

// ValidSemver 检查严格的三段式 semver（不允许 v 前缀，与 Node semver.valid(x, { loose: false }) 对齐）。
func ValidSemver(raw string) bool {
	_, ok := parseSemver(strings.TrimSpace(raw))
	return ok
}

func parseSemver(raw string) (semverVersion, bool) {
	m := semverExactRE.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return semverVersion{}, false
	}
	major, err1 := parseNumericIdent(m[1])
	minor, err2 := parseNumericIdent(m[2])
	patch, err3 := parseNumericIdent(m[3])
	if err1 || err2 || err3 {
		return semverVersion{}, false
	}
	var pre []string
	if m[4] != "" {
		pre = strings.Split(m[4], ".")
		for _, ident := range pre {
			if ident == "" {
				return semverVersion{}, false
			}
			if isAllDigits(ident) && len(ident) > 1 && strings.HasPrefix(ident, "0") {
				return semverVersion{}, false
			}
		}
	}
	if m[5] != "" {
		for _, ident := range strings.Split(m[5], ".") {
			if ident == "" {
				return semverVersion{}, false
			}
		}
	}
	return semverVersion{major: major, minor: minor, patch: patch, prerelease: pre}, true
}

func parseNumericIdent(raw string) (int, bool) {
	if raw == "" || (len(raw) > 1 && strings.HasPrefix(raw, "0")) {
		return 0, true
	}
	val, err := strconv.Atoi(raw)
	return val, err != nil
}

func isAllDigits(raw string) bool {
	if raw == "" {
		return false
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] < '0' || raw[i] > '9' {
			return false
		}
	}
	return true
}

// CompareSemver 比较两个合法 semver 版本大小（a<b 返回 -1，a==b 返回 0，a>b 返回 1）。
func CompareSemver(aRaw, bRaw string) (int, bool) {
	a, okA := parseSemver(aRaw)
	b, okB := parseSemver(bRaw)
	if !okA || !okB {
		return 0, false
	}
	return compareSemver(a, b), true
}

func compareSemver(a, b semverVersion) int {
	if a.major != b.major {
		return cmpInt(a.major, b.major)
	}
	if a.minor != b.minor {
		return cmpInt(a.minor, b.minor)
	}
	if a.patch != b.patch {
		return cmpInt(a.patch, b.patch)
	}
	if len(a.prerelease) == 0 && len(b.prerelease) == 0 {
		return 0
	}
	if len(a.prerelease) == 0 {
		return 1
	}
	if len(b.prerelease) == 0 {
		return -1
	}
	limit := len(a.prerelease)
	if len(b.prerelease) < limit {
		limit = len(b.prerelease)
	}
	for i := 0; i < limit; i++ {
		ai, bi := a.prerelease[i], b.prerelease[i]
		if ai == bi {
			continue
		}
		aNum, bNum := isAllDigits(ai), isAllDigits(bi)
		switch {
		case aNum && bNum:
			av, _ := strconv.Atoi(ai)
			bv, _ := strconv.Atoi(bi)
			return cmpInt(av, bv)
		case aNum:
			return -1
		case bNum:
			return 1
		case ai < bi:
			return -1
		default:
			return 1
		}
	}
	return cmpInt(len(a.prerelease), len(b.prerelease))
}

func cmpInt(a, b int) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

type semverComparator struct {
	op      string
	version semverVersion
	any     bool
}

// ValidSemverRange 检查是否为可解析的 semver range。
func ValidSemverRange(raw string) bool {
	_, ok := parseSemverRange(raw)
	return ok
}

// SatisfiesSemverRange 判断 version 是否满足 rangeExpr（遵循 node-semver 预发布隔离与比较器规则）。
func SatisfiesSemverRange(version string, rangeExpr string) bool {
	v, ok := parseSemver(version)
	if !ok {
		return false
	}
	clauses, ok := parseSemverRange(rangeExpr)
	if !ok {
		return false
	}
	for _, clause := range clauses {
		if satisfiesClause(v, clause) {
			return true
		}
	}
	return false
}

func parseSemverRange(raw string) ([][]semverComparator, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, false
	}
	orParts := strings.Split(trimmed, "||")
	clauses := make([][]semverComparator, 0, len(orParts))
	for _, part := range orParts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, false
		}
		comps, ok := parseRangeClause(part)
		if !ok {
			return nil, false
		}
		clauses = append(clauses, comps)
	}
	return clauses, true
}

func parseRangeClause(clause string) ([]semverComparator, bool) {
	if strings.Contains(clause, " - ") {
		parts := strings.Split(clause, " - ")
		if len(parts) != 2 {
			return nil, false
		}
		left, okL := expandHyphenLeft(strings.TrimSpace(parts[0]))
		right, okR := expandHyphenRight(strings.TrimSpace(parts[1]))
		if !okL || !okR {
			return nil, false
		}
		return append(left, right...), true
	}
	tokens := strings.Fields(clause)
	if len(tokens) == 0 {
		return nil, false
	}
	var out []semverComparator
	for _, token := range tokens {
		expanded, ok := expandToken(token)
		if !ok {
			return nil, false
		}
		out = append(out, expanded...)
	}
	return out, true
}

func expandHyphenLeft(raw string) ([]semverComparator, bool) {
	maj, min, pat, pre, hasMin, hasPat, ok := parsePartial(raw)
	if !ok || maj < 0 {
		return nil, false
	}
	if !hasMin {
		min = 0
	}
	if !hasPat {
		pat = 0
	}
	return []semverComparator{{op: ">=", version: semverVersion{major: maj, minor: min, patch: pat, prerelease: pre}}}, true
}

func expandHyphenRight(raw string) ([]semverComparator, bool) {
	maj, min, pat, pre, hasMin, hasPat, ok := parsePartial(raw)
	if !ok || maj < 0 {
		return nil, false
	}
	if !hasMin {
		return []semverComparator{{op: "<", version: semverVersion{major: maj + 1, prerelease: []string{"0"}}}}, true
	}
	if !hasPat {
		return []semverComparator{{op: "<", version: semverVersion{major: maj, minor: min + 1, prerelease: []string{"0"}}}}, true
	}
	return []semverComparator{{op: "<=", version: semverVersion{major: maj, minor: min, patch: pat, prerelease: pre}}}, true
}

func expandToken(token string) ([]semverComparator, bool) {
	if strings.HasPrefix(token, "^") {
		return expandCaret(strings.TrimPrefix(token, "^"))
	}
	if strings.HasPrefix(token, "~") {
		return expandTilde(strings.TrimPrefix(token, "~"))
	}
	m := semverPrefixRE.FindStringSubmatch(token)
	if m == nil {
		return nil, false
	}
	op := m[1]
	body := strings.TrimSpace(m[2])
	if body == "" {
		return nil, false
	}
	maj, min, pat, pre, hasMin, hasPat, ok := parsePartial(body)
	if !ok {
		return nil, false
	}
	if maj < 0 {
		switch op {
		case "", "=", ">=":
			return []semverComparator{{any: true}}, true
		default:
			return []semverComparator{{op: "<", version: semverVersion{major: 0}}}, true
		}
	}
	if !hasMin || !hasPat {
		minVal := min
		if !hasMin {
			minVal = 0
		}
		patVal := pat
		if !hasPat {
			patVal = 0
		}
		lower := semverVersion{major: maj, minor: minVal, patch: patVal}
		var upper semverVersion
		if !hasMin {
			upper = semverVersion{major: maj + 1, prerelease: []string{"0"}}
		} else {
			upper = semverVersion{major: maj, minor: min + 1, prerelease: []string{"0"}}
		}
		switch op {
		case "", "=":
			return []semverComparator{{op: ">=", version: lower}, {op: "<", version: upper}}, true
		case ">":
			return []semverComparator{{op: ">=", version: upper}}, true
		case ">=":
			return []semverComparator{{op: ">=", version: lower}}, true
		case "<":
			return []semverComparator{{op: "<", version: semverVersion{major: lower.major, minor: lower.minor, patch: lower.patch, prerelease: []string{"0"}}}}, true
		case "<=":
			return []semverComparator{{op: "<", version: upper}}, true
		}
	}
	if op == "" {
		op = "="
	}
	return []semverComparator{{op: op, version: semverVersion{major: maj, minor: min, patch: pat, prerelease: pre}}}, true
}

func expandCaret(raw string) ([]semverComparator, bool) {
	maj, min, pat, pre, hasMin, hasPat, ok := parsePartial(raw)
	if !ok {
		return nil, false
	}
	if maj < 0 {
		return []semverComparator{{any: true}}, true
	}
	minVal := min
	if !hasMin {
		minVal = 0
	}
	patVal := pat
	if !hasPat {
		patVal = 0
	}
	lower := semverVersion{major: maj, minor: minVal, patch: patVal, prerelease: pre}
	var upper semverVersion
	switch {
	case maj > 0:
		upper = semverVersion{major: maj + 1, prerelease: []string{"0"}}
	case hasMin && min > 0:
		upper = semverVersion{major: 0, minor: min + 1, prerelease: []string{"0"}}
	case hasPat && hasMin:
		upper = semverVersion{major: 0, minor: 0, patch: pat + 1, prerelease: []string{"0"}}
	case !hasMin:
		upper = semverVersion{major: 1, prerelease: []string{"0"}}
	default:
		upper = semverVersion{major: 0, minor: 1, prerelease: []string{"0"}}
	}
	return []semverComparator{{op: ">=", version: lower}, {op: "<", version: upper}}, true
}

func expandTilde(raw string) ([]semverComparator, bool) {
	maj, min, pat, pre, hasMin, hasPat, ok := parsePartial(raw)
	if !ok {
		return nil, false
	}
	if maj < 0 {
		return []semverComparator{{any: true}}, true
	}
	minVal := min
	if !hasMin {
		minVal = 0
	}
	patVal := pat
	if !hasPat {
		patVal = 0
	}
	lower := semverVersion{major: maj, minor: minVal, patch: patVal, prerelease: pre}
	var upper semverVersion
	if !hasMin {
		upper = semverVersion{major: maj + 1, prerelease: []string{"0"}}
	} else {
		upper = semverVersion{major: maj, minor: min + 1, prerelease: []string{"0"}}
	}
	return []semverComparator{{op: ">=", version: lower}, {op: "<", version: upper}}, true
}

func parsePartial(raw string) (maj, min, pat int, pre []string, hasMin, hasPat, ok bool) {
	body := strings.TrimSpace(raw)
	if idx := strings.IndexByte(body, '+'); idx >= 0 {
		body = body[:idx]
	}
	if idx := strings.IndexByte(body, '-'); idx >= 0 {
		prePart := body[idx+1:]
		body = body[:idx]
		if prePart == "" {
			return
		}
		pre = strings.Split(prePart, ".")
		for _, ident := range pre {
			if ident == "" || (isAllDigits(ident) && len(ident) > 1 && strings.HasPrefix(ident, "0")) {
				return
			}
		}
	}
	parts := strings.Split(body, ".")
	if len(parts) > 3 {
		return
	}
	isWildcard := func(s string) bool { return s == "*" || s == "x" || s == "X" }
	if isWildcard(parts[0]) {
		if len(parts) > 1 {
			for _, p := range parts[1:] {
				if !isWildcard(p) {
					return
				}
			}
		}
		return -1, 0, 0, nil, false, false, true
	}
	var err bool
	maj, err = parseNumericIdent(parts[0])
	if err {
		return
	}
	if len(parts) >= 2 && !isWildcard(parts[1]) {
		min, err = parseNumericIdent(parts[1])
		if err {
			return
		}
		hasMin = true
	}
	if len(parts) == 3 {
		if !hasMin && !isWildcard(parts[2]) {
			return
		}
		if !isWildcard(parts[2]) {
			pat, err = parseNumericIdent(parts[2])
			if err {
				return
			}
			hasPat = true
		}
	}
	if len(pre) > 0 && (!hasMin || !hasPat) {
		return
	}
	return maj, min, pat, pre, hasMin, hasPat, true
}

func satisfiesClause(v semverVersion, comps []semverComparator) bool {
	for _, comp := range comps {
		if !comp.matches(v) {
			return false
		}
	}
	if len(v.prerelease) > 0 {
		allowed := false
		for _, comp := range comps {
			if !comp.any && len(comp.version.prerelease) > 0 &&
				comp.version.major == v.major &&
				comp.version.minor == v.minor &&
				comp.version.patch == v.patch {
				allowed = true
				break
			}
		}
		if !allowed {
			return false
		}
	}
	return true
}

func (comp semverComparator) matches(v semverVersion) bool {
	if comp.any {
		return true
	}
	cmp := compareSemver(v, comp.version)
	switch comp.op {
	case "=":
		return cmp == 0
	case ">":
		return cmp > 0
	case ">=":
		return cmp >= 0
	case "<":
		return cmp < 0
	case "<=":
		return cmp <= 0
	default:
		return false
	}
}
