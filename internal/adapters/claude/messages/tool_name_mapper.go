package messages

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/madou1217/ai_home/core/inference"
)

const maxClaudeToolNameBytes = 128

// toolNameMapper 在 Claude 扁平工具名与 Canonical 工具身份之间执行可逆映射。
//
// 普通工具保持原名；namespaced 工具优先使用可读的 namespace__name，只有
// 超长或冲突时才退化为稳定摘要名。反向映射始终以完整 ToolIdentity 为准。
type toolNameMapper struct {
	toWire   map[inference.ToolIdentity]string
	fromWire map[string]inference.ToolIdentity
}

// newToolNameMapper 为一次请求创建不可变名称映射并拒绝线协议冲突。
func newToolNameMapper(request inference.Request) (toolNameMapper, error) {
	identities := requestToolIdentities(request)
	if _, hasWebSearch := request.WebSearch(); hasWebSearch {
		for _, identity := range identities {
			if _, namespaced := identity.Namespace(); !namespaced &&
				identity.Name() == "web_search" {
				return toolNameMapper{}, ErrUnsupportedRequest
			}
		}
	}
	mapper := toolNameMapper{
		toWire:   make(map[inference.ToolIdentity]string, len(identities)),
		fromWire: make(map[string]inference.ToolIdentity, len(identities)),
	}
	// 先保留普通工具名，避免 namespaced 可读别名遮蔽客户端原生函数。
	for _, identity := range identities {
		if _, namespaced := identity.Namespace(); namespaced {
			continue
		}
		if err := mapper.bind(identity, identity.Name()); err != nil {
			return toolNameMapper{}, err
		}
	}
	for _, identity := range identities {
		namespace, namespaced := identity.Namespace()
		if !namespaced {
			continue
		}
		candidate := namespace + "__" + identity.Name()
		if len(candidate) > maxClaudeToolNameBytes || mapper.containsWire(candidate) {
			candidate = hashedClaudeToolName(identity)
		}
		if err := mapper.bind(identity, candidate); err != nil {
			return toolNameMapper{}, err
		}
	}
	return mapper, nil
}

// requestToolIdentities 按定义和历史首次出现顺序收集完整工具身份。
func requestToolIdentities(request inference.Request) []inference.ToolIdentity {
	identities := make([]inference.ToolIdentity, 0, len(request.Tools()))
	seen := make(map[inference.ToolIdentity]struct{}, len(request.Tools()))
	appendIdentity := func(identity inference.ToolIdentity) {
		if _, exists := seen[identity]; exists {
			return
		}
		seen[identity] = struct{}{}
		identities = append(identities, identity)
	}
	for _, tool := range request.Tools() {
		appendIdentity(tool.Identity())
	}
	for _, message := range request.Messages() {
		for _, content := range message.Contents() {
			if toolCall, ok := content.(inference.ToolCallContent); ok {
				appendIdentity(toolCall.Identity())
			}
		}
	}
	return identities
}

// bind 同时写入正排和倒排，任何重复都失败关闭。
func (mapper *toolNameMapper) bind(identity inference.ToolIdentity, wireName string) error {
	if mapper == nil || !identity.IsValid() || wireName == "" ||
		len(wireName) > maxClaudeToolNameBytes {
		return ErrUnsupportedRequest
	}
	if _, exists := mapper.toWire[identity]; exists || mapper.containsWire(wireName) {
		return ErrUnsupportedRequest
	}
	mapper.toWire[identity] = wireName
	mapper.fromWire[wireName] = identity
	return nil
}

// containsWire 判断一个 Claude 扁平名称是否已经占用。
func (mapper toolNameMapper) containsWire(wireName string) bool {
	_, exists := mapper.fromWire[wireName]
	return exists
}

// encode 返回 Canonical 工具身份对应的 Claude 扁平名称。
func (mapper toolNameMapper) encode(identity inference.ToolIdentity) (string, error) {
	value, exists := mapper.toWire[identity]
	if !exists {
		return "", ErrUnsupportedRequest
	}
	return value, nil
}

// decode 把 Claude 返回的扁平名称恢复为完整 Canonical 工具身份。
func (mapper toolNameMapper) decode(wireName string) (inference.ToolIdentity, error) {
	if len(mapper.fromWire) == 0 {
		identity, err := inference.NewToolIdentity(wireName)
		if err != nil {
			return inference.ToolIdentity{}, ErrInvalidUpstreamResponse
		}
		return identity, nil
	}
	identity, exists := mapper.fromWire[wireName]
	if !exists {
		return inference.ToolIdentity{}, ErrInvalidUpstreamResponse
	}
	return identity, nil
}

// hashedClaudeToolName 为超长或冲突身份生成固定长度别名。
func hashedClaudeToolName(identity inference.ToolIdentity) string {
	namespace, _ := identity.Namespace()
	digest := sha256.Sum256([]byte(namespace + "\x00" + identity.Name()))
	return "aih_ns_" + hex.EncodeToString(digest[:])
}
