package completion

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Candidate 是一条协议候选：值 + 一句话说明 + 分组。
type Candidate struct {
	Value       string
	Description string
	Group       string
}

// 候选分组：zsh 按组分别 compadd（每组一个标题），bash 侧忽略。
const (
	groupCommand    = "命令"
	groupProvider   = "CLI"
	groupAction     = "动作"
	groupSubcommand = "子命令"
	groupAccount    = "账号"
	groupSession    = "会话"
	groupFlag       = "选项"
	groupHistory    = "历史（你用过）"
	groupModel      = "模型"
	groupMCP        = "MCP"
	groupOther      = "其它"
)

type collector struct {
	items   []Candidate
	seen    map[string]struct{}
	current string
}

func newCollector(current string) *collector {
	return &collector{seen: make(map[string]struct{}), current: current}
}

// add 按前缀/片段命中过滤后追加；重复值只保留第一次。
func (c *collector) add(value, description, group, matchText string) {
	text := value
	if text == "" {
		return
	}
	if _, exists := c.seen[text]; exists {
		return
	}
	if !matchesPrefix(text, c.current) && !matchesContains(matchText, c.current) {
		return
	}
	c.seen[text] = struct{}{}
	c.items = append(c.items, Candidate{
		Value:       text,
		Description: collapseWhitespace(description),
		Group:       group,
	})
}

func matchesPrefix(value, current string) bool {
	if current == "" {
		return true
	}
	if strings.HasPrefix(value, current) {
		return true
	}
	return strings.HasPrefix(strings.ToLower(value), strings.ToLower(current))
}

func matchesContains(text, current string) bool {
	if current == "" {
		return true
	}
	return strings.Contains(strings.ToLower(text), strings.ToLower(current))
}

// collapseWhitespace 把说明里的换行/连续空白压平：协议是一行一个候选。
func collapseWhitespace(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func describeProvider(provider string) string {
	label := strings.TrimSpace(providerMenuLabel(provider))
	if label == "" {
		return "CLI"
	}
	return "CLI：" + label
}

func shortRef(accountRef string) string {
	if utf8.RuneCountInString(accountRef) > 12 {
		runes := []rune(accountRef)
		return string(runes[:11]) + "…"
	}
	return accountRef
}

// clipText 与 Node 的「压平 + 截断 + 省略号」一致。
func clipText(text string, max int) string {
	value := collapseWhitespace(text)
	if max <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max-1]) + "…"
	}
	return value
}

// formatRelativeMoment 把秒/毫秒时间戳转成「N 分钟前 / N 天前 / 日期」。
func formatRelativeMoment(value int64, now time.Time) string {
	if value <= 0 {
		return ""
	}
	millis := value
	if value < 1_000_000_000_000 {
		millis = value * 1000
	}
	moment := time.UnixMilli(millis)
	diff := now.Sub(moment)
	if diff < 0 {
		return "刚刚"
	}
	const (
		minute = time.Minute
		hour   = time.Hour
		day    = 24 * time.Hour
	)
	switch {
	case diff < minute:
		return "刚刚"
	case diff < hour:
		return fmt.Sprintf("%d 分钟前", int64(diff/minute))
	case diff < day:
		return fmt.Sprintf("%d 小时前", int64(diff/hour))
	case diff < 30*day:
		return fmt.Sprintf("%d 天前", int64(diff/day))
	default:
		return moment.Format("2006-01-02")
	}
}

// formatSessionTime 把 ISO 串或 epoch 毫秒统一压成 `YYYY-MM-DD HH:mm`。
func formatSessionTime(value string) string {
	text := strings.TrimSpace(value)
	if text == "" {
		return ""
	}
	if isNumericTimestamp(text) {
		numeric, err := strconv.ParseFloat(text, 64)
		if err == nil && numeric >= 1e8 {
			millis := numeric
			if numeric < 1e12 {
				millis = math.Round(numeric * 1000)
			} else {
				millis = math.Round(numeric)
			}
			return time.UnixMilli(int64(millis)).Format("2006-01-02 15:04")
		}
	}
	runes := []rune(text)
	if len(runes) > 16 {
		return string(runes[:16])
	}
	return text
}

func isNumericTimestamp(text string) bool {
	dotSeen := false
	beforeDot := 0
	afterDot := 0
	for index := 0; index < len(text); index++ {
		char := text[index]
		if char == '.' {
			if dotSeen {
				return false
			}
			dotSeen = true
			continue
		}
		if char < '0' || char > '9' {
			return false
		}
		if dotSeen {
			afterDot++
		} else {
			beforeDot++
		}
	}
	if beforeDot < 9 || beforeDot > 16 {
		return false
	}
	return !dotSeen || afterDot > 0
}
