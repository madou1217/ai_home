package edgeproxy

import (
	"fmt"
	"strings"
)

// EdgeBlockPrefix 是受管文本块在 Edge Proxy 配置中的固定前缀。
const EdgeBlockPrefix = "aih-edge"

// BuildManagedBlockMarkers 返回受管块的起止标记行。
func BuildManagedBlockMarkers(name, prefix string) (start, end string) {
	resolvedPrefix := strings.TrimSpace(prefix)
	if resolvedPrefix == "" {
		resolvedPrefix = "aih"
	}
	label := fmt.Sprintf("%s:%s", resolvedPrefix, strings.TrimSpace(name))
	return "# >>> " + label + " >>>", "# <<< " + label + " <<<"
}

// ReplaceManagedBlock 幂等替换同名受管文本块，其余手工配置保持原样。
func ReplaceManagedBlock(text, name, content, prefix string) string {
	start, end := BuildManagedBlockMarkers(name, prefix)
	lines := strings.Split(text, "\n")
	startIndex := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == start {
			startIndex = i
			break
		}
	}
	next := text
	if startIndex >= 0 {
		endIndex := -1
		for i := startIndex + 1; i < len(lines); i++ {
			if strings.TrimSpace(lines[i]) == end {
				endIndex = i
				break
			}
		}
		var kept []string
		if endIndex >= 0 {
			kept = append(kept, lines[:startIndex]...)
			kept = append(kept, lines[endIndex+1:]...)
		} else {
			kept = append(kept, lines[:startIndex]...)
		}
		next = strings.Join(kept, "\n")
	}
	trimmedNext := strings.TrimRight(next, " \t\r\n")
	trimmedContent := strings.TrimSpace(content)
	return fmt.Sprintf("%s\n%s\n%s\n%s\n", trimmedNext, start, trimmedContent, end)
}
