package completion

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// minCorrectionLength 是纠错的最小长度门槛：短命令打错就让它照常报错。
const minCorrectionLength = 3

// reasonWeight 是判据权重（越小越靠前）：相邻换位/一位错打优先于「前缀更长」。
var reasonWeight = map[string]int{
	"learned":       -100,
	"case":          0,
	"transposition": 1,
	"typo":          2,
	"abbrev":        3,
	"prefix":        4,
}

type suggestion struct {
	Value  string
	Reason string
	Argv   []string
	Typo   string
}

type scoredSuggestion struct {
	Value        string
	Reason       string
	Distance     int
	HistoryCount int
	Priority     int
	Weight       int
	Argv         []string
}

// damerauLevenshtein 计算 Damerau / OSA 距离（相邻换位按一次编辑计）。
func damerauLevenshtein(left, right string) int {
	a := []rune(left)
	b := []rune(right)
	if string(a) == string(b) {
		return 0
	}
	if len(a) == 0 {
		return len(b)
	}
	if len(b) == 0 {
		return len(a)
	}
	rows := len(a) + 1
	cols := len(b) + 1
	matrix := make([][]int, rows)
	for index := range matrix {
		matrix[index] = make([]int, cols)
		matrix[index][0] = index
	}
	for index := 0; index < cols; index++ {
		matrix[0][index] = index
	}
	for row := 1; row < rows; row++ {
		for column := 1; column < cols; column++ {
			cost := 1
			if a[row-1] == b[column-1] {
				cost = 0
			}
			value := minimum(
				matrix[row-1][column]+1,
				matrix[row][column-1]+1,
				matrix[row-1][column-1]+cost,
			)
			if row > 1 && column > 1 && a[row-1] == b[column-2] && a[row-2] == b[column-1] {
				value = minimum(value, matrix[row-2][column-2]+1)
			}
			matrix[row][column] = value
		}
	}
	return matrix[rows-1][cols-1]
}

func minimum(values ...int) int {
	result := values[0]
	for _, value := range values[1:] {
		if value < result {
			result = value
		}
	}
	return result
}

func isAdjacentTransposition(left, right string) bool {
	a := []rune(left)
	b := []rune(right)
	if len(a) != len(b) || left == right {
		return false
	}
	diff := make([]int, 0, 2)
	for index := range a {
		if a[index] != b[index] {
			diff = append(diff, index)
		}
	}
	if len(diff) != 2 {
		return false
	}
	first, second := diff[0], diff[1]
	return second == first+1 && a[first] == b[second] && a[second] == b[first]
}

func isSubsequence(input, candidate string) bool {
	source := []rune(input)
	target := []rune(candidate)
	index := 0
	for _, char := range target {
		if index < len(source) && char == source[index] {
			index++
		}
		if index == len(source) {
			return true
		}
	}
	return len(source) == 0
}

func allowedDistance(length int) int {
	if length <= 3 {
		return 1
	}
	return 2
}

func scoreCandidate(input, candidate string) (int, string, bool) {
	source := input
	target := candidate
	if source == "" || target == "" || source == target {
		return 0, "", false
	}
	if strings.EqualFold(source, target) {
		return 0, "case", true
	}
	if strings.HasPrefix(target, source) {
		return utf8.RuneCountInString(target) - utf8.RuneCountInString(source), "prefix", true
	}
	distance := damerauLevenshtein(source, target)
	if distance == 0 {
		return 0, "", false
	}
	if distance > allowedDistance(utf8.RuneCountInString(source)) {
		return 0, "", false
	}
	if isAdjacentTransposition(source, target) {
		return distance, "transposition", true
	}
	if distance == 1 {
		return distance, "typo", true
	}
	if utf8.RuneCountInString(source) >= 5 && isSubsequence(source, target) {
		return distance, "abbrev", true
	}
	if utf8.RuneCountInString(source) >= 5 {
		return distance, "typo", true
	}
	return 0, "", false
}

// rankedCandidate 是排序输入：值 + 该值在用户历史里出现的次数。
type rankedCandidate struct {
	Value        string
	HistoryCount int
}

// rankSuggestions 对候选集合排序；已学习纠正排在最前。
func rankSuggestions(input string, candidates []rankedCandidate, limit int, learned map[string][]string, priorityCommands []string) []scoredSuggestion {
	if limit < 1 {
		limit = 5
	}
	priority := make(map[string]struct{}, len(priorityCommands))
	for _, name := range priorityCommands {
		if name != "" {
			priority[name] = struct{}{}
		}
	}
	scored := make([]scoredSuggestion, 0, len(candidates))
	for _, candidate := range candidates {
		value := strings.TrimSpace(candidate.Value)
		if value == "" {
			continue
		}
		distance, reason, matched := scoreCandidate(input, value)
		if !matched {
			continue
		}
		weight, found := reasonWeight[reason]
		if !found {
			weight = 9
		}
		priorityValue := 0
		if _, exists := priority[value]; exists {
			priorityValue = 1
		}
		scored = append(scored, scoredSuggestion{
			Value:        value,
			Reason:       reason,
			Distance:     distance,
			HistoryCount: candidate.HistoryCount,
			Priority:     priorityValue,
			Weight:       weight,
		})
	}
	sort.SliceStable(scored, func(left, right int) bool {
		if scored[left].Weight != scored[right].Weight {
			return scored[left].Weight < scored[right].Weight
		}
		if scored[left].Priority != scored[right].Priority {
			return scored[left].Priority > scored[right].Priority
		}
		if scored[left].Distance != scored[right].Distance {
			return scored[left].Distance < scored[right].Distance
		}
		if scored[left].HistoryCount != scored[right].HistoryCount {
			return scored[left].HistoryCount > scored[right].HistoryCount
		}
		if utf8.RuneCountInString(scored[left].Value) != utf8.RuneCountInString(scored[right].Value) {
			return utf8.RuneCountInString(scored[left].Value) < utf8.RuneCountInString(scored[right].Value)
		}
		return scored[left].Value < scored[right].Value
	})
	unique := make([]scoredSuggestion, 0, limit)
	seen := make(map[string]struct{}, len(scored))
	for _, entry := range scored {
		if _, exists := seen[entry.Value]; exists {
			continue
		}
		seen[entry.Value] = struct{}{}
		unique = append(unique, entry)
		if len(unique) >= limit {
			break
		}
	}
	if learnedArgv, found := learned[input]; found && len(learnedArgv) > 0 {
		unique = append([]scoredSuggestion{{
			Value:  strings.Join(learnedArgv, " "),
			Reason: "learned",
			Weight: reasonWeight["learned"],
			Argv:   append([]string(nil), learnedArgv...),
		}}, unique...)
	}
	if len(unique) > limit {
		unique = unique[:limit]
	}
	return unique
}

// listPathCommands 扫描 PATH 里的可执行名（只读目录项，不做 stat）。
func listPathCommands(environment Environment) []string {
	names := make([]string, 0, 256)
	seen := make(map[string]struct{}, 256)
	pathValue := environment.env("PATH")
	for _, directory := range filepath.SplitList(pathValue) {
		if directory == "" {
			continue
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			name := entry.Name()
			if utf8.RuneCountInString(name) < 2 || strings.HasPrefix(name, ".") {
				continue
			}
			if !entry.Type().IsRegular() && entry.Type()&os.ModeSymlink == 0 {
				continue
			}
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			names = append(names, name)
		}
	}
	return names
}

func pushSuggestion(items []suggestion, argv []string, reason string, explicitValue string) []suggestion {
	value := explicitValue
	if value == "" {
		value = strings.Join(argv, " ")
	}
	if value == "" {
		return items
	}
	for _, entry := range items {
		if entry.Value == value {
			return items
		}
	}
	return append(items, suggestion{Value: value, Reason: reason, Argv: append([]string(nil), argv...)})
}

// suggestCommand 修正一条打错的命令；保留用户其余参数。
func suggestCommand(tokens []string, aihNames []string, historyEntries []historyEntry, learned map[string][]string, environment Environment) []suggestion {
	if len(tokens) == 0 {
		return nil
	}
	head := tokens[0]
	rest := append([]string(nil), tokens[1:]...)
	if utf8.RuneCountInString(head) < minCorrectionLength {
		return nil
	}
	limit := 5
	items := make([]suggestion, 0, limit)
	hasAihName := false
	for _, name := range aihNames {
		if name == "aih" {
			hasAihName = true
			break
		}
	}
	if hasAihName {
		if _, reason, matched := scoreCandidate(head, "aih"); matched {
			if learnedArgv, found := learned[head]; found && len(learnedArgv) > 0 {
				argv := append([]string(nil), learnedArgv...)
				if len(rest) > 0 {
					argv = append([]string{learnedArgv[0]}, rest...)
				}
				items = pushSuggestion(items, argv, "learned", "")
			}
			argv := append([]string{"aih"}, rest...)
			items = pushSuggestion(items, argv, reason, "")
			if len(rest) == 0 {
				for _, entry := range rankHistoryCandidates(historyEntries, "", 3) {
					suffixTokens := strings.Fields(entry.Suffix)
					argv := append([]string{"aih"}, suffixTokens...)
					items = pushSuggestion(items, argv, "history", "aih "+entry.Suffix)
				}
			}
			if len(items) > limit {
				items = items[:limit]
			}
			return items
		}
	}
	pathCommands := listPathCommands(environment)
	candidates := make([]rankedCandidate, 0, len(pathCommands)+len(historyEntries))
	for _, command := range pathCommands {
		candidates = append(candidates, rankedCandidate{Value: command})
	}
	for _, entry := range historyEntries {
		fields := strings.Fields(entry.Suffix)
		if len(fields) > 0 && fields[0] != "" {
			candidates = append(candidates, rankedCandidate{Value: fields[0], HistoryCount: entry.Count})
		}
	}
	for _, entry := range rankSuggestions(head, candidates, limit, learned, aihNames) {
		if entry.Argv != nil {
			argv := append([]string(nil), entry.Argv...)
			explicit := ""
			if len(rest) > 0 {
				argv = append([]string{entry.Argv[0]}, rest...)
			} else {
				explicit = entry.Value
			}
			items = pushSuggestion(items, argv, entry.Reason, explicit)
			continue
		}
		argv := append([]string{entry.Value}, rest...)
		items = pushSuggestion(items, argv, entry.Reason, "")
	}
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

// suggestInsideArgv 只修正 `aih` 之后的那一个词，其余参数原样保留。
func suggestInsideArgv(tokens []string, universe []string, learned map[string][]string) []suggestion {
	if len(tokens) < 2 {
		return nil
	}
	head := tokens[0]
	target := tokens[1]
	rest := append([]string(nil), tokens[2:]...)
	if utf8.RuneCountInString(target) < minCorrectionLength {
		return nil
	}
	cleanUniverse := make([]string, 0, len(universe))
	known := make(map[string]struct{}, len(universe))
	for _, value := range universe {
		if value == "" {
			continue
		}
		cleanUniverse = append(cleanUniverse, value)
		known[value] = struct{}{}
	}
	if _, exists := known[target]; exists {
		return nil
	}
	limit := 5
	items := make([]suggestion, 0, limit)
	rankedUniverse := make([]rankedCandidate, 0, len(cleanUniverse))
	for _, value := range cleanUniverse {
		rankedUniverse = append(rankedUniverse, rankedCandidate{Value: value})
	}
	for _, entry := range rankSuggestions(target, rankedUniverse, limit, nil, cleanUniverse) {
		argv := append([]string{head, entry.Value}, rest...)
		items = append(items, suggestion{
			Value:  strings.Join(argv, " "),
			Reason: entry.Reason,
			Argv:   argv,
			Typo:   target,
		})
	}
	if learnedArgv, found := learned[target]; found && len(learnedArgv) > 1 &&
		learnedArgv[0] == head {
		if _, exists := known[learnedArgv[1]]; exists {
			argv := append([]string{head, learnedArgv[1]}, rest...)
			value := strings.Join(argv, " ")
			deduped := make([]suggestion, 0, len(items))
			for _, entry := range items {
				if entry.Value == value {
					continue
				}
				deduped = append(deduped, entry)
			}
			items = append([]suggestion{{
				Value:  value,
				Reason: "learned",
				Argv:   argv,
				Typo:   target,
			}}, deduped...)
		}
	}
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}
