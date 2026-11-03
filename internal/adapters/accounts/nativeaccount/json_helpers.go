package nativeaccount

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

func bytesReader(data []byte) *bytes.Reader { return bytes.NewReader(data) }

func rejectDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytesReader(data))
	if err := consumeJSONValue(decoder, 0); err != nil {
		return err
	}
	return requireJSONEOF(decoder)
}

func consumeJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return ErrInvalidNativeArtifacts
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			key, ok := keyToken.(string)
			if err != nil || !ok {
				return ErrInvalidNativeArtifacts
			}
			if _, exists := seen[key]; exists {
				return ErrInvalidNativeArtifacts
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		return closeJSONValue(decoder, '}')
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		return closeJSONValue(decoder, ']')
	default:
		return ErrInvalidNativeArtifacts
	}
}

func closeJSONValue(decoder *json.Decoder, expected json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok || delimiter != expected {
		return ErrInvalidNativeArtifacts
	}
	return nil
}

func requireJSONEOF(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); errors.Is(err, io.EOF) {
		return nil
	} else if err == nil {
		return ErrInvalidNativeArtifacts
	} else {
		return ErrInvalidNativeArtifacts
	}
}

func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func text(value any) string {
	result, _ := value.(string)
	return strings.TrimSpace(result)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstText(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := text(record[key]); value != "" {
			return value
		}
	}
	return ""
}

// consistentSecretAlias accepts token/key syntax while still rejecting
// conflicting aliases; identity component validation is intentionally separate.
func consistentSecretAlias(record map[string]any, keys ...string) (string, bool) {
	var selected string
	for _, key := range keys {
		raw, exists := record[key]
		if !exists || raw == nil || raw == "" {
			continue
		}
		candidate, isString := raw.(string)
		if !isString {
			return "", false
		}
		if len(candidate) > maxArtifactBytes || candidate != strings.TrimSpace(candidate) ||
			(strings.IndexFunc(candidate, func(character rune) bool {
				return character < 0x20 || character == 0x7f
			}) >= 0) {
			return "", false
		}
		if selected != "" && selected != candidate {
			return "", false
		}
		selected = candidate
	}
	return selected, true
}
