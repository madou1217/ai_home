package accountactivity

// 参数的稳定指纹：同一个选择必须得到同一个键，顺序不同不算不同选择。
//
// 与 lib/server/stable-fingerprint.js 同语义：对象键排序、数组元素按稳定序列化
// 排序，超长时压成 sha256 前缀。不用 encoding/json 直接序列化 map，因为 Go 的
// map 遍历顺序随机会让同一个选择算出不同键，防抖与任务复用都会失效。

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

// MaxFingerprintLength 与 Node 的 MAX_FINGERPRINT_LENGTH 一致。
const MaxFingerprintLength = 192

// StableFingerprint 返回参数指纹；空参数返回空串（调用方据此保持裸键不变）。
func StableFingerprint(params map[string]any) string {
	if len(params) == 0 {
		return ""
	}
	serialized := stableSerialize(params)
	if len(serialized) <= MaxFingerprintLength {
		return serialized
	}
	sum := sha256.Sum256([]byte(serialized))
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

func stableSerialize(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return "null"
		}
		return string(encoded)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case string:
		return quoteJSON(typed)
	case []string:
		items := make([]string, 0, len(typed))
		for _, item := range typed {
			items = append(items, stableSerialize(item))
		}
		sort.Strings(items)
		return "[" + strings.Join(items, ",") + "]"
	case []any:
		items := make([]string, 0, len(typed))
		for _, item := range typed {
			items = append(items, stableSerialize(item))
		}
		sort.Strings(items)
		return "[" + strings.Join(items, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			parts = append(parts, quoteJSON(key)+":"+stableSerialize(typed[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		return quoteJSON(strings.TrimSpace(textOf(value)))
	}
}

func quoteJSON(value string) string {
	var buffer strings.Builder
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return `""`
	}
	return strings.TrimSuffix(buffer.String(), "\n")
}

// RunKey 把事件 id 与参数指纹拼成运行键；空参数返回裸 id。
func RunKey(eventID string, params map[string]any) string {
	id := strings.TrimSpace(eventID)
	if id == "" {
		return ""
	}
	fingerprint := StableFingerprint(params)
	if fingerprint == "" {
		return id
	}
	return id + "#" + fingerprint
}
