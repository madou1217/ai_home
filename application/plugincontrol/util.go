package plugincontrol

import (
	"encoding/json"
	"time"
)

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// encodeRecord 编码一条 installed 记录。map 的键会排序；JSON 语义与 Node 等价，
// manifest 与 signature 以 RawMessage 原样嵌入。
func encodeRecord(value map[string]any) ([]byte, error) {
	return json.Marshal(value)
}
