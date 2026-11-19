package harnessrun

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
)

// readJSONObject 读取一个 JSON 对象；缺失/损坏/非对象一律按 {} 处理
// （Node readJsonFile 的 fallback 语义）。
func readJSONObject(filePath string) map[string]any {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return map[string]any{}
	}
	var value any
	if err := json.Unmarshal(content, &value); err != nil {
		return map[string]any{}
	}
	object, ok := asObject(value)
	if !ok {
		return map[string]any{}
	}
	return object
}

// fileURLString 等价于 Node pathToFileURL(path).href（Unix 语义）。
func fileURLString(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		absolute = path
	}
	location := url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}
	return location.String()
}

// jsonQuote 输出不转义 HTML 的 JSON 字符串字面量（与 JSON.stringify 一致）。
func jsonQuote(value string) (string, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return "", err
	}
	encoded := buffer.String()
	return encoded[:len(encoded)-1], nil
}
