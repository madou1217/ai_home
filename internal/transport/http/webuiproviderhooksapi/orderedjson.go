package webuiproviderhooksapi

// Hook 配置是用户的原生文件（settings.json / hooks.json），不是本服务的私有账本。
// Node 的实现用 JSON.parse → 修改 → JSON.stringify 保留键的插入顺序；Go 的
// map[string]any 会按字典序重排整份文件，用户会看到一次无意义的全局 diff。
// 因此这里保留一个最小的有序 JSON 树：只服务于「读出来、改几个键、写回去」。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
)

// orderedObject 是保留键顺序的 JSON 对象。
type orderedObject struct {
	keys   []string
	values map[string]any
}

func newOrderedObject() *orderedObject {
	return &orderedObject{values: map[string]any{}}
}

func (object *orderedObject) get(key string) any {
	if object == nil {
		return nil
	}
	return object.values[key]
}

func (object *orderedObject) has(key string) bool {
	if object == nil {
		return false
	}
	_, exists := object.values[key]
	return exists
}

func (object *orderedObject) set(key string, value any) {
	if object == nil {
		return
	}
	if _, exists := object.values[key]; !exists {
		object.keys = append(object.keys, key)
	}
	object.values[key] = value
}

func (object *orderedObject) remove(key string) {
	if object == nil {
		return
	}
	if _, exists := object.values[key]; !exists {
		return
	}
	delete(object.values, key)
	keys := make([]string, 0, len(object.keys))
	for _, candidate := range object.keys {
		if candidate != key {
			keys = append(keys, candidate)
		}
	}
	object.keys = keys
}

func (object *orderedObject) len() int {
	if object == nil {
		return 0
	}
	return len(object.keys)
}

// decodeOrderedJSON 解析一份 JSON 文档；对象保序，数字保留字面量。
func decodeOrderedJSON(raw []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := decodeOrderedValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("JSON 尾部有多余内容")
	}
	return value, nil
}

func decodeOrderedValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return token, nil
	}
	switch delimiter {
	case '{':
		object := newOrderedObject()
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, fmt.Errorf("JSON 对象键不是字符串")
			}
			value, err := decodeOrderedValue(decoder)
			if err != nil {
				return nil, err
			}
			object.set(key, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return object, nil
	case '[':
		array := []any{}
		for decoder.More() {
			value, err := decodeOrderedValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, value)
		}
		if _, err := decoder.Token(); err != nil {
			return nil, err
		}
		return array, nil
	default:
		return nil, fmt.Errorf("意外的 JSON 分隔符 %q", delimiter)
	}
}

// encodeOrderedCompact 输出紧凑 JSON，用于「内容是否变化」的比较。
func encodeOrderedCompact(value any) string {
	buffer := &bytes.Buffer{}
	writeOrderedValue(buffer, value, "", false)
	return buffer.String()
}

// encodeOrderedIndented 输出与 JSON.stringify(value, null, 2) 一致的缩进 JSON。
func encodeOrderedIndented(value any) string {
	buffer := &bytes.Buffer{}
	writeOrderedValue(buffer, value, "", true)
	return buffer.String()
}

func writeOrderedValue(buffer *bytes.Buffer, value any, indent string, pretty bool) {
	switch typed := value.(type) {
	case *orderedObject:
		if typed.len() == 0 {
			buffer.WriteString("{}")
			return
		}
		buffer.WriteByte('{')
		childIndent := indent + "  "
		for index, key := range typed.keys {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if pretty {
				buffer.WriteByte('\n')
				buffer.WriteString(childIndent)
			}
			writeJSONString(buffer, key)
			buffer.WriteByte(':')
			if pretty {
				buffer.WriteByte(' ')
			}
			writeOrderedValue(buffer, typed.values[key], childIndent, pretty)
		}
		if pretty {
			buffer.WriteByte('\n')
			buffer.WriteString(indent)
		}
		buffer.WriteByte('}')
	case []any:
		if len(typed) == 0 {
			buffer.WriteString("[]")
			return
		}
		buffer.WriteByte('[')
		childIndent := indent + "  "
		for index, item := range typed {
			if index > 0 {
				buffer.WriteByte(',')
			}
			if pretty {
				buffer.WriteByte('\n')
				buffer.WriteString(childIndent)
			}
			writeOrderedValue(buffer, item, childIndent, pretty)
		}
		if pretty {
			buffer.WriteByte('\n')
			buffer.WriteString(indent)
		}
		buffer.WriteByte(']')
	case string:
		writeJSONString(buffer, typed)
	case json.Number:
		buffer.WriteString(typed.String())
	case bool:
		if typed {
			buffer.WriteString("true")
		} else {
			buffer.WriteString("false")
		}
	case nil:
		buffer.WriteString("null")
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			buffer.WriteString("null")
			return
		}
		buffer.Write(encoded)
	}
}

// writeJSONString 与原实现的 JSON.stringify 一致：不转义 HTML 字符。
func writeJSONString(buffer *bytes.Buffer, value string) {
	encoder := json.NewEncoder(buffer)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
	// Encoder.Encode 会追加换行；从缓冲区尾部去掉它。
	raw := buffer.Bytes()
	if len(raw) > 0 && raw[len(raw)-1] == '\n' {
		buffer.Truncate(len(raw) - 1)
	}
}
