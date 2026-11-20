package zcoderelay

import (
	"encoding/json"
	"strings"
)

// stripDeclaredModelPrefix 把客户端显式写出的 zcode/ 或 zai/ 命名空间还原成裸模型 id。
// 只在这两个本 Provider 声明过的前缀上生效；其它模型 id 逐字节返回。
func stripDeclaredModelPrefix(body []byte) []byte {
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil {
		return body
	}
	rawModel, ok := payload["model"]
	if !ok {
		return body
	}
	var model string
	if json.Unmarshal(rawModel, &model) != nil {
		return body
	}
	trimmed := strings.TrimSpace(model)
	lower := strings.ToLower(trimmed)
	for _, prefix := range []string{"zcode", "zai"} {
		if len(trimmed) <= len(prefix)+1 || !strings.HasPrefix(lower, prefix+"/") {
			continue
		}
		bare := strings.TrimSpace(trimmed[len(prefix)+1:])
		if bare == "" {
			return body
		}
		encoded, err := json.Marshal(bare)
		if err != nil {
			return body
		}
		payload["model"] = encoded
		rewritten, err := json.Marshal(payload)
		if err != nil {
			return body
		}
		return rewritten
	}
	return body
}
