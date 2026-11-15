package remotebackup

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
)

// Go's struct decoder accepts null for primitives and fills absent values with
// zero. Check required fields and exact JSON types before projecting the schema.
func validateRepositoryManifestShape(raw []byte) error {
	bad := func() error { return errors.New("backup_manifest_invalid") }
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil || top == nil {
		return bad()
	}
	var revision json.Number
	if len(top["revision"]) == 0 || top["revision"][0] == '"' || bytes.Equal(top["revision"], []byte("null")) {
		return bad()
	}
	if err := json.Unmarshal(top["revision"], &revision); err != nil {
		return bad()
	}
	v, e := strconv.ParseInt(string(revision), 10, 64)
	if e != nil || v < 0 || v > 9007199254740991 {
		return bad()
	}
	var entries map[string]json.RawMessage
	if len(top["accounts"]) == 0 || json.Unmarshal(top["accounts"], &entries) != nil || entries == nil {
		return bad()
	}
	for _, rawEntry := range entries {
		var item map[string]json.RawMessage
		if json.Unmarshal(rawEntry, &item) != nil || item == nil {
			return bad()
		}
		for _, name := range []string{"provider"} {
			var value string
			if len(item[name]) == 0 || item[name][0] != '"' || json.Unmarshal(item[name], &value) != nil {
				return bad()
			}
		}
		if value, ok := item["deleted"]; ok && !bytes.Equal(value, []byte("true")) && !bytes.Equal(value, []byte("false")) {
			return bad()
		}
		if old, ok := item["legacy"]; ok {
			if _, exists := item["bytes"]; exists {
				return bad()
			}
			if _, exists := item["objectSha256"]; exists {
				return bad()
			}
			if bytes.Equal(old, []byte("null")) {
				return bad()
			}
			var legacy map[string]json.RawMessage
			if json.Unmarshal(old, &legacy) != nil || legacy == nil {
				return bad()
			}
			for _, name := range []string{"provider", "sha256", "bytes", "deleted"} {
				if len(legacy[name]) == 0 {
					return bad()
				}
			}
			if !bytes.Equal(legacy["deleted"], []byte("true")) {
				return bad()
			}
		} else {
			var hash string
			if len(item["objectSha256"]) == 0 || item["objectSha256"][0] != '"' || json.Unmarshal(item["objectSha256"], &hash) != nil {
				return bad()
			}
			var size int
			if len(item["bytes"]) == 0 || bytes.Equal(item["bytes"], []byte("null")) || json.Unmarshal(item["bytes"], &size) != nil {
				return bad()
			}
		}
	}
	if skipped, ok := top["skipped"]; ok {
		var refs []string
		if bytes.Equal(skipped, []byte("null")) || json.Unmarshal(skipped, &refs) != nil {
			return bad()
		}
	}
	return nil
}
