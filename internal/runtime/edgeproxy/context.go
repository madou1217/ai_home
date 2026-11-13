package edgeproxy

import (
	"net/url"
	"strings"
)

// EdgeContextEnv 合并边缘代理二进制与配置文件路径覆盖的环境变量名。
const EdgeContextEnv = "AIH_EDGE_CONTEXT"

// ParseEdgeContext 解析 AIH_EDGE_CONTEXT 中的逗号分隔键值覆盖项。
func ParseEdgeContext(value string) map[string]string {
	fields := make(map[string]string)
	for _, part := range strings.Split(value, ",") {
		idx := strings.IndexByte(part, '=')
		if idx <= 0 {
			continue
		}
		key := strings.TrimSpace(part[:idx])
		raw := strings.TrimSpace(part[idx+1:])
		if key == "" || raw == "" {
			continue
		}
		if decoded, err := url.QueryUnescape(strings.ReplaceAll(raw, "+", "%2B")); err == nil {
			fields[key] = decoded
		} else {
			fields[key] = raw
		}
	}
	return fields
}

func readEdgeContextField(env map[string]string, key string) string {
	if env == nil {
		return ""
	}
	fields := ParseEdgeContext(env[EdgeContextEnv])
	return fields[key]
}
