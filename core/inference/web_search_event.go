package inference

import (
	"net/url"
	"strings"
)

// EventWebSearchCompleted 表示服务器侧网络搜索动作已经完成。
const EventWebSearchCompleted EventKind = "web_search_completed"

// WebSearchActionKind 是服务器侧网络搜索动作的稳定类别。
type WebSearchActionKind string

const (
	// WebSearchActionSearch 表示执行一个或多个搜索查询。
	WebSearchActionSearch WebSearchActionKind = "search"
	// WebSearchActionOpenPage 表示打开搜索结果页面。
	WebSearchActionOpenPage WebSearchActionKind = "open_page"
	// WebSearchActionFindInPage 表示在页面内查找文本。
	WebSearchActionFindInPage WebSearchActionKind = "find_in_page"
)

// WebSearchAction 是不携带 Provider 私有字段的搜索动作值对象。
type WebSearchAction struct {
	kind    WebSearchActionKind
	query   string
	queries []string
	sources []string
	url     string
	pattern string
}

// NewWebSearchAction 创建搜索查询动作并保留可选批量查询与来源 URL。
func NewWebSearchAction(
	query string,
	queries []string,
	sources []string,
) (WebSearchAction, error) {
	action := WebSearchAction{
		kind:    WebSearchActionSearch,
		query:   query,
		queries: append([]string(nil), queries...),
		sources: append([]string(nil), sources...),
	}
	if !action.IsValid() {
		return WebSearchAction{}, ErrInvalidEvent
	}
	return action, nil
}

// NewWebOpenPageAction 创建打开页面动作。
func NewWebOpenPageAction(rawURL string) (WebSearchAction, error) {
	action := WebSearchAction{kind: WebSearchActionOpenPage, url: rawURL}
	if !action.IsValid() {
		return WebSearchAction{}, ErrInvalidEvent
	}
	return action, nil
}

// NewWebFindInPageAction 创建页面内查找动作。
func NewWebFindInPageAction(rawURL string, pattern string) (WebSearchAction, error) {
	action := WebSearchAction{
		kind:    WebSearchActionFindInPage,
		url:     rawURL,
		pattern: pattern,
	}
	if !action.IsValid() {
		return WebSearchAction{}, ErrInvalidEvent
	}
	return action, nil
}

// Kind 返回搜索动作类别。
func (action WebSearchAction) Kind() WebSearchActionKind { return action.kind }

// Query 返回兼容旧版单查询合同的主查询。
func (action WebSearchAction) Query() string { return action.query }

// Queries 返回批量搜索查询副本。
func (action WebSearchAction) Queries() []string {
	return append([]string(nil), action.queries...)
}

// Sources 返回搜索动作公开的来源 URL 副本。
func (action WebSearchAction) Sources() []string {
	return append([]string(nil), action.sources...)
}

// URL 返回打开或查找动作的页面 URL。
func (action WebSearchAction) URL() string { return action.url }

// Pattern 返回页面内查找文本。
func (action WebSearchAction) Pattern() string { return action.pattern }

// Equal 比较两个动作的全部语义字段。
func (action WebSearchAction) Equal(other WebSearchAction) bool {
	if action.kind != other.kind || action.query != other.query ||
		action.url != other.url || action.pattern != other.pattern ||
		len(action.queries) != len(other.queries) ||
		len(action.sources) != len(other.sources) {
		return false
	}
	for index, query := range action.queries {
		if other.queries[index] != query {
			return false
		}
	}
	for index, source := range action.sources {
		if other.sources[index] != source {
			return false
		}
	}
	return true
}

// IsValid 判断动作字段只属于其判别类别。
func (action WebSearchAction) IsValid() bool {
	switch action.kind {
	case WebSearchActionSearch:
		if action.url != "" || action.pattern != "" ||
			(action.query == "" && len(action.queries) == 0) ||
			len(action.queries) > 16 || len(action.sources) > 32 {
			return false
		}
		if action.query != "" && !isBoundedSearchText(action.query) {
			return false
		}
		for _, query := range action.queries {
			if !isBoundedSearchText(query) {
				return false
			}
		}
		for _, source := range action.sources {
			if !isValidWebURL(source) {
				return false
			}
		}
		return true
	case WebSearchActionOpenPage:
		return action.query == "" && len(action.queries) == 0 &&
			len(action.sources) == 0 && action.pattern == "" &&
			isValidWebURL(action.url)
	case WebSearchActionFindInPage:
		return action.query == "" && len(action.queries) == 0 &&
			len(action.sources) == 0 && isValidWebURL(action.url) &&
			isBoundedSearchText(action.pattern)
	default:
		return false
	}
}

// isBoundedSearchText 限制搜索文本，避免流式响应占用无界内存。
func isBoundedSearchText(value string) bool {
	return len(value) <= 4096 && isNonBlankText(value) && strings.TrimSpace(value) == value
}

// isValidWebURL 只接受有主机名的 HTTP(S) URL。
func isValidWebURL(value string) bool {
	if len(value) == 0 || len(value) > 8192 || strings.TrimSpace(value) != value {
		return false
	}
	parsed, err := url.ParseRequestURI(value)
	return err == nil && parsed.Host != "" &&
		(parsed.Scheme == "http" || parsed.Scheme == "https")
}

// WebSearchCompletedEvent 保存可向客户端公开的搜索查询。
type WebSearchCompletedEvent struct {
	eventBase
	outputIndex uint32
	action      WebSearchAction
}

// NewWebSearchCompletedEvent 创建网络搜索动作终值事件。
func NewWebSearchCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	query string,
) (WebSearchCompletedEvent, error) {
	action, err := NewWebSearchAction(query, nil, nil)
	if err != nil {
		return WebSearchCompletedEvent{}, ErrInvalidEvent
	}
	return NewWebSearchActionCompletedEvent(sequence, outputIndex, action)
}

// NewWebSearchActionCompletedEvent 创建保留完整动作的网络搜索终值事件。
func NewWebSearchActionCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	action WebSearchAction,
) (WebSearchCompletedEvent, error) {
	if !action.IsValid() {
		return WebSearchCompletedEvent{}, ErrInvalidEvent
	}
	return WebSearchCompletedEvent{
		eventBase:   eventBase{sequence: sequence},
		outputIndex: outputIndex,
		action:      action,
	}, nil
}

// Kind 返回服务器侧网络搜索完成类别。
func (WebSearchCompletedEvent) Kind() EventKind { return EventWebSearchCompleted }

// OutputIndex 返回搜索调用所属输出项索引。
func (event WebSearchCompletedEvent) OutputIndex() uint32 { return event.outputIndex }

// Action 返回上游实际执行的完整搜索动作。
func (event WebSearchCompletedEvent) Action() WebSearchAction {
	return WebSearchAction{
		kind:    event.action.kind,
		query:   event.action.query,
		queries: event.action.Queries(),
		sources: event.action.Sources(),
		url:     event.action.url,
		pattern: event.action.pattern,
	}
}

// Query 返回兼容旧版单查询消费者的主搜索词。
func (event WebSearchCompletedEvent) Query() string { return event.action.Query() }

// isStreamEvent 将 WebSearchCompletedEvent 限制在 Canonical 事件联合类型内。
func (WebSearchCompletedEvent) isStreamEvent() {}
