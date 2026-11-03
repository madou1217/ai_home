package codeassist

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/madou1217/ai_home/core/inference"
)

// Gemini functionDeclaration 名称上限 64 字节。
const maxCodeAssistToolNameBytes = 64

// toolNameMapper 在 Code Assist 扁平函数名与 Canonical 工具身份之间做可逆映射
// （同 Claude 适配器）。Codex CLI 的 namespace 工具在不同命名空间里有同名子工具
// （mcp__cua_repl/js 与 mcp__node_repl/js），直接用裸名上游报「Tool names must be unique」。
// 普通工具保持原名；namespaced 工具用 namespace__name，超长或冲突时退化为稳定摘要名。
type toolNameMapper struct {
	toWire   map[inference.ToolIdentity]string
	fromWire map[string]inference.ToolIdentity
}

func newToolNameMapper(request inference.Request) (toolNameMapper, error) {
	identities := requestToolIdentities(request)
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
		if len(candidate) > maxCodeAssistToolNameBytes || mapper.containsWire(candidate) {
			candidate = hashedToolName(identity)
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

func (mapper *toolNameMapper) bind(identity inference.ToolIdentity, wireName string) error {
	if mapper == nil || !identity.IsValid() || wireName == "" || len(wireName) > maxCodeAssistToolNameBytes {
		return ErrUnsupportedRequest
	}
	if _, exists := mapper.toWire[identity]; exists || mapper.containsWire(wireName) {
		return ErrUnsupportedRequest
	}
	mapper.toWire[identity] = wireName
	mapper.fromWire[wireName] = identity
	return nil
}

func (mapper toolNameMapper) containsWire(wireName string) bool {
	_, exists := mapper.fromWire[wireName]
	return exists
}

func (mapper toolNameMapper) encode(identity inference.ToolIdentity) (string, error) {
	if value, exists := mapper.toWire[identity]; exists {
		return value, nil
	}
	return "", ErrUnsupportedRequest
}

// decode 把上游返回的扁平名恢复为完整身份；没有映射（无工具请求）时按普通名解析。
func (mapper toolNameMapper) decode(wireName string) (inference.ToolIdentity, error) {
	if identity, exists := mapper.fromWire[wireName]; exists {
		return identity, nil
	}
	if len(mapper.fromWire) == 0 {
		return inference.NewToolIdentity(wireName)
	}
	return inference.ToolIdentity{}, ErrInvalidUpstreamResponse
}

func hashedToolName(identity inference.ToolIdentity) string {
	namespace, _ := identity.Namespace()
	digest := sha256.Sum256([]byte(namespace + "\x00" + identity.Name()))
	return "aih_ns_" + hex.EncodeToString(digest[:])[:32]
}
