package nativeterminal

import (
	"net/url"
	"strings"
)

func envValue(env []string, name string) string {
	for _, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}
func setEnv(env []string, name, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		if !strings.EqualFold(key, name) {
			out = append(out, item)
		}
	}
	return append(out, name+"="+value)
}
func withoutEnv(env []string, names ...string) []string {
	out := make([]string, 0, len(env))
	for _, item := range env {
		key, _, _ := strings.Cut(item, "=")
		skip := false
		for _, name := range names {
			if strings.EqualFold(key, name) {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, item)
		}
	}
	return out
}
func intentField(raw, key string) string {
	for _, part := range strings.Split(raw, ",") {
		k, v, ok := strings.Cut(part, "=")
		if ok && k == key {
			decoded, err := url.PathUnescape(v)
			if err == nil {
				return decoded
			}
		}
	}
	return ""
}
func setIntent(raw, key, value string) string {
	parts := []string{}
	for _, part := range strings.Split(raw, ",") {
		k, _, _ := strings.Cut(part, "=")
		if part != "" && k != key {
			parts = append(parts, part)
		}
	}
	if value != "" {
		parts = append(parts, key+"="+url.PathEscape(value))
	}
	return strings.Join(parts, ",")
}
