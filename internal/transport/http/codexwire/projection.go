package codexwire

import "encoding/json"

// canonicalProjectionFields 是标准 OpenAI Responses 参数中，Codex 原生线协议
// 无法表达、但 Canonical 适配器可以安全丢弃的字段。
//
// 原生快路径按字节透传；如果让这些字段直接落到 Codex 上游，上游会以 400
// 拒绝整个请求。标准 SDK 经常默认携带 temperature / max_output_tokens，
// 因此命中这些字段时必须交回 Canonical，由适配层做无损/有损投影。
var canonicalProjectionFields = []string{
	"background",
	"max_output_tokens",
	"metadata",
	"safety_identifier",
	"stop",
	"temperature",
	"top_k",
	"top_p",
	"truncation",
	"user",
}

// RequiresCanonicalProjection 判断原生 Codex payload 是否包含需要 Canonical
// 投影的标准 Responses 字段。解析失败时返回 false，让原生路径按原有错误处理。
func RequiresCanonicalProjection(payload []byte) bool {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return false
	}
	for _, key := range canonicalProjectionFields {
		if _, found := fields[key]; found {
			return true
		}
	}
	return false
}
