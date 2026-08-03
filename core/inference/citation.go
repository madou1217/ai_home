package inference

// EventURLCitationAdded 表示输出文本新增一个网页引用。
const EventURLCitationAdded EventKind = "url_citation_added"

// URLCitation 是跨 Provider 的网页引用值对象。
type URLCitation struct {
	startIndex uint32
	endIndex   uint32
	title      string
	url        string
}

// NewURLCitation 创建带文本字符区间的网页引用。
func NewURLCitation(
	startIndex uint32,
	endIndex uint32,
	title string,
	rawURL string,
) (URLCitation, error) {
	if startIndex > endIndex ||
		(title != "" && !isNonBlankText(title)) ||
		!isValidWebURL(rawURL) {
		return URLCitation{}, ErrInvalidEvent
	}
	return URLCitation{
		startIndex: startIndex,
		endIndex:   endIndex,
		title:      title,
		url:        rawURL,
	}, nil
}

// StartIndex 返回引用在输出文本中的起始字符索引。
func (citation URLCitation) StartIndex() uint32 { return citation.startIndex }

// EndIndex 返回引用在输出文本中的结束字符索引。
func (citation URLCitation) EndIndex() uint32 { return citation.endIndex }

// Title 返回网页标题；上游未提供时可能为空。
func (citation URLCitation) Title() string { return citation.title }

// URL 返回引用网页地址。
func (citation URLCitation) URL() string { return citation.url }

// IsValid 判断网页引用仍满足构造不变量。
func (citation URLCitation) IsValid() bool {
	_, err := NewURLCitation(
		citation.startIndex,
		citation.endIndex,
		citation.title,
		citation.url,
	)
	return err == nil
}

// URLCitationAddedEvent 把网页引用绑定到一个文本内容块。
type URLCitationAddedEvent struct {
	eventBase
	eventPosition
	citation URLCitation
}

// NewURLCitationAddedEvent 创建网页引用增量事件。
func NewURLCitationAddedEvent(
	sequence uint64,
	outputIndex uint32,
	blockIndex uint32,
	citation URLCitation,
) (URLCitationAddedEvent, error) {
	if !citation.IsValid() {
		return URLCitationAddedEvent{}, ErrInvalidEvent
	}
	return URLCitationAddedEvent{
		eventBase:     eventBase{sequence: sequence},
		eventPosition: eventPosition{outputIndex: outputIndex, blockIndex: blockIndex},
		citation:      citation,
	}, nil
}

// Kind 返回网页引用新增类别。
func (URLCitationAddedEvent) Kind() EventKind { return EventURLCitationAdded }

// OutputIndex 返回引用所属输出项索引。
func (event URLCitationAddedEvent) OutputIndex() uint32 { return event.outputIndex }

// BlockIndex 返回引用所属文本块索引。
func (event URLCitationAddedEvent) BlockIndex() uint32 { return event.blockIndex }

// Citation 返回不可变网页引用。
func (event URLCitationAddedEvent) Citation() URLCitation { return event.citation }

// isStreamEvent 将 URLCitationAddedEvent 限制在 Canonical 事件联合类型内。
func (URLCitationAddedEvent) isStreamEvent() {}
