package requirements

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// ImportInput 描述一次从外部 TodoList 导入。
type ImportInput struct {
	Format         string `json:"format"`
	Content        string `json:"content"`
	WorkspacePath  string `json:"workspacePath"`
	WorkspaceLabel string `json:"workspaceLabel"`
	WorkspaceKind  string `json:"workspaceKind"`
}

// ImportItem 是解析后的中间条目。
type ImportItem struct {
	Title       string
	Description string
	Priority    int
	Done        bool
}

var markdownCheckboxPattern = regexp.MustCompile(`^\s*[-*+]\s*\[( |x|X)\]\s*(.+)$`)

// Import 解析外部数据并创建需求；指定工作区时直接进入待排期。
func (service *Service) Import(ctx context.Context, input ImportInput) ([]Requirement, error) {
	items, format, err := ParseImport(strings.ToLower(strings.TrimSpace(input.Format)), input.Content)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("%w: 没有解析到可导入的条目", ErrInvalid)
	}
	workspacePath, err := NormalizeWorkspacePath(input.WorkspacePath)
	if err != nil {
		return nil, err
	}
	workspaceLabel := strings.TrimSpace(input.WorkspaceLabel)
	workspaceKind := strings.TrimSpace(input.WorkspaceKind)
	created := make([]Requirement, 0, len(items))
	for _, item := range items {
		description := strings.TrimSpace(item.Description)
		status := StatusIdea
		switch {
		case item.Done:
			status = StatusDone
		case workspacePath != "":
			if description == "" {
				description = item.Title
			}
			status = StatusReady
		}
		requirement, createErr := service.CreateRequirement(ctx, Requirement{
			Title:          item.Title,
			Description:    description,
			Status:         status,
			Priority:       item.Priority,
			WorkspacePath:  workspacePath,
			WorkspaceLabel: workspaceLabel,
			WorkspaceKind:  workspaceKind,
			Mode:           ModePlan,
			Source:         format,
		})
		if createErr != nil {
			return created, fmt.Errorf("导入 %q 失败: %w", item.Title, createErr)
		}
		created = append(created, requirement)
	}
	service.Notify()
	return created, nil
}

// ParseImport 解析常见 TodoList 格式，返回条目与识别出的格式。
func ParseImport(format, content string) ([]ImportItem, string, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, "", fmt.Errorf("%w: 导入内容为空", ErrInvalid)
	}
	if format == "" || format == "auto" {
		format = detectImportFormat(content)
	}
	switch format {
	case "todoist":
		items, err := parseTodoist(content)
		return items, format, err
	case "trello":
		items, err := parseTrello(content)
		return items, format, err
	case "markdown", "md":
		return parseMarkdown(content), "markdown", nil
	case "csv":
		items, err := parseCSV(content)
		return items, format, err
	case "json":
		items, err := parseGenericJSON(content)
		return items, format, err
	default:
		return nil, "", fmt.Errorf("%w: 不支持的导入格式 %q", ErrInvalid, format)
	}
}

func detectImportFormat(content string) string {
	trimmed := strings.TrimSpace(content)
	if strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[") {
		lower := strings.ToLower(trimmed)
		switch {
		case strings.Contains(lower, "\"cards\"") && strings.Contains(lower, "\"idlist\""):
			return "trello"
		case strings.Contains(lower, "\"items\"") || strings.Contains(lower, "\"child_order\""):
			return "todoist"
		default:
			return "json"
		}
	}
	if markdownCheckboxPattern.MatchString(trimmed) || strings.Contains(trimmed, "\n- [") || strings.Contains(trimmed, "\n* [") {
		return "markdown"
	}
	if strings.Contains(strings.SplitN(trimmed, "\n", 2)[0], ",") {
		return "csv"
	}
	return "markdown"
}

func parseTodoist(content string) ([]ImportItem, error) {
	var payload struct {
		Items []struct {
			Content     string `json:"content"`
			Description string `json:"description"`
			Priority    int    `json:"priority"`
			Checked     bool   `json:"checked"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(content), &payload); err != nil {
		var array []struct {
			Content     string `json:"content"`
			Description string `json:"description"`
			Priority    int    `json:"priority"`
			Checked     bool   `json:"checked"`
		}
		if arrayErr := json.Unmarshal([]byte(content), &array); arrayErr != nil {
			return nil, fmt.Errorf("%w: Todoist JSON 无法解析", ErrInvalid)
		}
		for _, item := range array {
			payload.Items = append(payload.Items, item)
		}
	}
	items := make([]ImportItem, 0, len(payload.Items))
	for _, item := range payload.Items {
		title := strings.TrimSpace(item.Content)
		if title == "" {
			continue
		}
		priority := PriorityNormal
		switch {
		case item.Priority >= 4:
			priority = PriorityHigh
		case item.Priority <= 1:
			priority = PriorityLow
		}
		items = append(items, ImportItem{Title: title, Description: strings.TrimSpace(item.Description), Priority: priority, Done: item.Checked})
	}
	return items, nil
}

func parseTrello(content string) ([]ImportItem, error) {
	var payload struct {
		Cards []struct {
			Name   string  `json:"name"`
			Desc   string  `json:"desc"`
			Closed bool    `json:"closed"`
			Pos    float64 `json:"pos"`
		} `json:"cards"`
	}
	if err := json.Unmarshal([]byte(content), &payload); err != nil {
		return nil, fmt.Errorf("%w: Trello JSON 无法解析", ErrInvalid)
	}
	items := make([]ImportItem, 0, len(payload.Cards))
	for _, card := range payload.Cards {
		title := strings.TrimSpace(card.Name)
		if title == "" {
			continue
		}
		items = append(items, ImportItem{Title: title, Description: strings.TrimSpace(card.Desc), Priority: PriorityNormal, Done: card.Closed})
	}
	return items, nil
}

func parseMarkdown(content string) []ImportItem {
	items := []ImportItem{}
	for _, line := range strings.Split(content, "\n") {
		match := markdownCheckboxPattern.FindStringSubmatch(line)
		if len(match) == 3 {
			title := strings.TrimSpace(match[2])
			if title == "" {
				continue
			}
			items = append(items, ImportItem{Title: title, Priority: PriorityNormal, Done: strings.EqualFold(strings.TrimSpace(match[1]), "x")})
			continue
		}
		// 连续列表也接受：- 标题
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
			title := strings.TrimSpace(trimmed[2:])
			if len([]rune(title)) >= 2 {
				items = append(items, ImportItem{Title: title, Priority: PriorityNormal})
			}
		}
	}
	return items
}

func parseCSV(content string) ([]ImportItem, error) {
	reader := csv.NewReader(strings.NewReader(content))
	reader.FieldsPerRecord = -1
	reader.LazyQuotes = true
	records, err := reader.ReadAll()
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("%w: CSV 无法解析", ErrInvalid)
	}
	if len(records) == 0 {
		return nil, nil
	}
	header := records[0]
	columns := map[string]int{}
	for index, name := range header {
		columns[strings.ToLower(strings.TrimSpace(name))] = index
	}
	titleIndex := firstColumn(columns, "title", "task", "name", "content", "summary")
	if titleIndex < 0 {
		titleIndex = 0
	}
	descriptionIndex := firstColumn(columns, "description", "notes", "desc", "detail")
	priorityIndex := firstColumn(columns, "priority", "p")
	statusIndex := firstColumn(columns, "status", "done", "completed", "checked")
	items := []ImportItem{}
	start := 0
	if titleIndex >= 0 && len(records) > 0 {
		if _, named := columns["title"]; named {
			start = 1
		} else if _, named := columns["task"]; named {
			start = 1
		} else if _, named := columns["name"]; named {
			start = 1
		}
	}
	for _, record := range records[start:] {
		title := cell(record, titleIndex)
		if title == "" {
			continue
		}
		item := ImportItem{Title: title, Priority: PriorityNormal}
		item.Description = cell(record, descriptionIndex)
		if raw := cell(record, priorityIndex); raw != "" {
			item.Priority = parsePriority(raw)
		}
		if raw := cell(record, statusIndex); raw != "" {
			item.Done = isDone(raw)
		}
		items = append(items, item)
	}
	return items, nil
}

func parseGenericJSON(content string) ([]ImportItem, error) {
	var raw []map[string]any
	if err := json.Unmarshal([]byte(content), &raw); err != nil {
		var single map[string]any
		if singleErr := json.Unmarshal([]byte(content), &single); singleErr != nil {
			return nil, fmt.Errorf("%w: JSON 无法解析", ErrInvalid)
		}
		if nested, ok := single["items"].([]any); ok {
			for _, entry := range nested {
				if object, ok := entry.(map[string]any); ok {
					raw = append(raw, object)
				}
			}
		} else {
			raw = append(raw, single)
		}
	}
	items := make([]ImportItem, 0, len(raw))
	for _, object := range raw {
		title := firstString(object, "title", "name", "content", "task", "summary")
		if title == "" {
			continue
		}
		item := ImportItem{Title: title, Priority: PriorityNormal}
		item.Description = firstString(object, "description", "notes", "desc", "detail")
		if value, ok := object["priority"]; ok {
			item.Priority = parsePriority(fmt.Sprintf("%v", value))
		}
		if value, ok := object["done"]; ok {
			item.Done = isDone(fmt.Sprintf("%v", value))
		}
		if value, ok := object["checked"]; ok {
			item.Done = isDone(fmt.Sprintf("%v", value))
		}
		items = append(items, item)
	}
	return items, nil
}

func firstColumn(columns map[string]int, names ...string) int {
	for _, name := range names {
		if index, ok := columns[name]; ok {
			return index
		}
	}
	return -1
}

func cell(record []string, index int) string {
	if index < 0 || index >= len(record) {
		return ""
	}
	return strings.TrimSpace(record[index])
}

func parsePriority(raw string) int {
	raw = strings.ToLower(strings.TrimSpace(raw))
	switch raw {
	case "high", "urgent", "p0", "p1", "0", "1", "紧急", "高":
		return PriorityHigh
	case "low", "p3", "4", "低":
		return PriorityLow
	default:
		if number, err := strconv.Atoi(raw); err == nil {
			switch {
			case number <= 1:
				return PriorityHigh
			case number >= 3:
				return PriorityLow
			}
		}
		return PriorityNormal
	}
}

func isDone(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "y", "done", "completed", "complete", "checked", "已完成":
		return true
	default:
		return false
	}
}

func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := object[key]; ok {
			if text, ok := value.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}
