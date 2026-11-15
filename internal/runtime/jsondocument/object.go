// Package jsondocument decodes an existing JSON object without silently losing
// numeric tokens, duplicate keys, trailing documents or malformed UTF-8.
package jsondocument

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/gowebpki/jcs"
	"io"
	"unicode/utf8"
)

var ErrInvalid = errors.New("json_document_invalid")

func Object(raw []byte) (map[string]any, error) {
	if !utf8.Valid(raw) {
		return nil, ErrInvalid
	}
	// Validate Unicode escape pairs too; encoding/json alone replaces lone
	// surrogate escapes. Ignore the canonical result to keep numeric tokens.
	if _, err := jcs.Transform(raw); err != nil {
		return nil, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	value, err := read(decoder, 0)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = decoder.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	object, ok := value.(map[string]any)
	if !ok || object == nil {
		return nil, ErrInvalid
	}
	return object, nil
}
func read(decoder *json.Decoder, depth int) (any, error) {
	if depth > 100 {
		return nil, ErrInvalid
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, container := token.(json.Delim)
	if !container {
		return token, nil
	}
	switch delim {
	case '{':
		result := map[string]any{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, ErrInvalid
			}
			if _, exists := result[name]; exists {
				return nil, ErrInvalid
			}
			value, err := read(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			result[name] = value
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim('}') {
			return nil, ErrInvalid
		}
		return result, nil
	case '[':
		result := []any{}
		for decoder.More() {
			value, err := read(decoder, depth+1)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		close, err := decoder.Token()
		if err != nil || close != json.Delim(']') {
			return nil, ErrInvalid
		}
		return result, nil
	default:
		return nil, ErrInvalid
	}
}
