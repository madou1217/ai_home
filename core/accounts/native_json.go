package accounts

import (
	"bytes"
	"encoding/json"
	"io"
)

func validNativePayload(payload []byte) bool {
	if len(payload) == 0 || len(payload) > maxNativeCredentialBytes || rejectDuplicateJSONKeys(payload) != nil {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil || value == nil || len(value) == 0 {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF
}

// rejectDuplicateJSONKeys validates every object level, including nested arrays.
func rejectDuplicateJSONKeys(payload []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := consumeNativeJSONValue(decoder, 0); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return ErrInvalidNativeCredential
	}
	return nil
}

func consumeNativeJSONValue(decoder *json.Decoder, depth int) error {
	if depth > 64 {
		return ErrInvalidNativeCredential
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
				return ErrInvalidNativeCredential
			}
			if _, exists := seen[key]; exists {
				return ErrInvalidNativeCredential
			}
			seen[key] = struct{}{}
			if err := consumeNativeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		return consumeNativeClosing(decoder, '}')
	case '[':
		for decoder.More() {
			if err := consumeNativeJSONValue(decoder, depth+1); err != nil {
				return err
			}
		}
		return consumeNativeClosing(decoder, ']')
	default:
		return ErrInvalidNativeCredential
	}
}

func consumeNativeClosing(decoder *json.Decoder, expected json.Delim) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != expected {
		return ErrInvalidNativeCredential
	}
	return nil
}
