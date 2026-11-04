package accountusage

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// MaxDocumentPayloadBytes 限制单账号快照文档的原始 JSON 大小。
	// Provider 快照是展示层文档，包含条目、模型与套餐信息，但仍必须是有限大小。
	MaxDocumentPayloadBytes = 256 << 10
)

// ErrInvalidDocument 表示快照文档的身份、时间或 payload 不符合存储合同。
var ErrInvalidDocument = errors.New("账号额度快照文档无效")

// DocumentInput 是采集方写入一份完整 Provider 快照文档所需的字段。
//
// 该文档是 Provider 采集结果的**原样**投影（Node WebUI 直接渲染它），
// Kind/Source/CapturedAt 同时被提升为列，供增量对账与过期判定使用。
type DocumentInput struct {
	AccountRef accountcore.AccountRef
	ProviderID string
	Kind       string
	Source     string
	CapturedAt time.Time
	Payload    []byte
}

// Document 是构造后不可变的 Provider 快照文档。
type Document struct {
	accountRef accountcore.AccountRef
	providerID string
	kind       string
	source     string
	capturedAt time.Time
	payload    []byte
}

// NewDocument 校验身份、时间与 JSON 对象后创建不可变文档。
//
// Kind/Source 允许为空：少数采集结果只带聚合数值；一旦非空就必须是稳定标识符。
func NewDocument(input DocumentInput) (Document, error) {
	providerID := strings.TrimSpace(input.ProviderID)
	kind := strings.TrimSpace(input.Kind)
	source := strings.TrimSpace(input.Source)
	capturedAt, capturedValid := normalizeRequiredTime(input.CapturedAt)
	if !input.AccountRef.IsValid() ||
		input.ProviderID != providerID ||
		!validIdentifier(providerID) ||
		input.Kind != kind ||
		(kind != "" && !validIdentifier(kind)) ||
		input.Source != source ||
		(source != "" && !validIdentifier(source)) ||
		!capturedValid ||
		len(input.Payload) == 0 ||
		len(input.Payload) > MaxDocumentPayloadBytes ||
		!validDocumentPayload(input.Payload) {
		return Document{}, ErrInvalidDocument
	}
	return Document{
		accountRef: input.AccountRef,
		providerID: providerID,
		kind:       kind,
		source:     source,
		capturedAt: capturedAt,
		payload:    append([]byte(nil), input.Payload...),
	}, nil
}

// AccountRef 返回文档所属稳定账号身份。
func (document Document) AccountRef() accountcore.AccountRef {
	return document.accountRef
}

// ProviderID 返回文档所属规范 Provider。
func (document Document) ProviderID() string {
	return document.providerID
}

// Kind 返回 Provider 快照类型；空值表示采集方未声明。
func (document Document) Kind() string {
	return document.kind
}

// Source 返回快照采集来源；空值表示采集方未声明。
func (document Document) Source() string {
	return document.source
}

// CapturedAt 返回快照的 UTC 毫秒采集时间。
func (document Document) CapturedAt() time.Time {
	return document.capturedAt
}

// Payload 返回原始 JSON 对象副本。
func (document Document) Payload() []byte {
	return append([]byte(nil), document.payload...)
}

// IsValid 重新校验跨层传递后的不可变文档。
func (document Document) IsValid() bool {
	restored, err := NewDocument(DocumentInput{
		AccountRef: document.accountRef,
		ProviderID: document.providerID,
		Kind:       document.kind,
		Source:     document.source,
		CapturedAt: document.capturedAt,
		Payload:    document.payload,
	})
	return err == nil && restored.capturedAt == document.capturedAt
}

// validDocumentPayload 只要求 JSON 对象：字段语义属于 Provider，Go 不解析。
func validDocumentPayload(payload []byte) bool {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(trimmed, &object) == nil && object != nil
}
