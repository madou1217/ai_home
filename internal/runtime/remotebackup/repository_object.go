package remotebackup

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"unicode/utf8"

	"github.com/gowebpki/jcs"
	"github.com/madou1217/ai_home/contracts/backuprepository"
)

var repositoryLayout = backuprepository.Contract

type RepositoryEntry struct {
	Provider     string         `json:"provider"`
	ObjectSHA256 string         `json:"objectSha256,omitempty"`
	Bytes        int            `json:"bytes,omitempty"`
	Deleted      bool           `json:"deleted,omitempty"`
	Legacy       *ManifestEntry `json:"legacy,omitempty"` // Unavailable tombstones only; never restored.
}
type RepositoryObject struct {
	Content []byte
	Path    string
	Entry   RepositoryEntry
}

func digestBytes(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }
func objectPath(hash string) (string, error) {
	if !sha256HexPattern.MatchString(hash) {
		return "", errors.New("backup_invalid_object_hash")
	}
	return repositoryLayout.ObjectsPrefix + hash + ".json", nil
}
func validateRepositoryNumbers(value any, depth int) error {
	if depth > 100 {
		return errors.New("backup_json_depth")
	}
	switch v := value.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(v), 64)
		if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || (math.Trunc(f) == f && math.Abs(f) > 9007199254740991) {
			return errors.New("backup_unsafe_number")
		}
	case map[string]any:
		for _, item := range v {
			if err := validateRepositoryNumbers(item, depth+1); err != nil {
				return err
			}
		}
	case []any:
		for _, item := range v {
			if err := validateRepositoryNumbers(item, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}
func validRepositoryStrings(value reflect.Value, depth int) error {
	if depth > 100 {
		return errors.New("backup_json_depth")
	}
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Interface, reflect.Pointer:
		if !value.IsNil() {
			return validRepositoryStrings(value.Elem(), depth+1)
		}
	case reflect.String:
		if !utf8.ValidString(value.String()) {
			return errors.New("backup_invalid_unicode")
		}
	case reflect.Map:
		iter := value.MapRange()
		for iter.Next() {
			if e := validRepositoryStrings(iter.Key(), depth+1); e != nil {
				return e
			}
			if e := validRepositoryStrings(iter.Value(), depth+1); e != nil {
				return e
			}
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < value.Len(); i++ {
			if e := validRepositoryStrings(value.Index(i), depth+1); e != nil {
				return e
			}
		}
	case reflect.Struct:
		for i := 0; i < value.NumField(); i++ {
			if e := validRepositoryStrings(value.Field(i), depth+1); e != nil {
				return e
			}
		}
	}
	return nil
}
func canonicalRepository(value any) ([]byte, error) {
	if err := validRepositoryStrings(reflect.ValueOf(value), 0); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var v any
	if err = decoder.Decode(&v); err != nil {
		return nil, err
	}
	if err = validateRepositoryNumbers(v, 0); err != nil {
		return nil, err
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return nil, fmt.Errorf("backup_invalid_json: %w", err)
	}
	return canonical, nil
}
func createRepositoryObject(record AccountRecord) (RepositoryObject, error) {
	return createRepositoryValue(record.Provider, record.AccountRef, record)
}
func createRepositoryValue(provider, ref string, record any) (RepositoryObject, error) {
	if !validAccountRefPattern.MatchString(ref) || provider == "." || provider == ".." {
		return RepositoryObject{}, errors.New("backup_object_identity_mismatch")
	}
	if _, err := AccountRelativePath(provider, ref); err != nil {
		return RepositoryObject{}, err
	}
	canonical, err := canonicalRepository(map[string]any{"kind": AccountDocumentKind, "version": 1, "accounts": []any{record}})
	if err != nil {
		return RepositoryObject{}, err
	}
	content := append(canonical, '\n')
	if len(content) > repositoryLayout.MaxObjectBytes {
		return RepositoryObject{}, errors.New("backup_object_too_large")
	}
	hash := digestBytes(content)
	p, _ := objectPath(hash)
	return RepositoryObject{Content: content, Path: p, Entry: RepositoryEntry{Provider: provider, ObjectSHA256: hash, Bytes: len(content)}}, nil
}
func verifyRepositoryObject(content []byte, ref string, entry RepositoryEntry) (AccountRecord, error) {
	var record AccountRecord
	if len(content) != entry.Bytes || len(content) > repositoryLayout.MaxObjectBytes {
		return record, errors.New("backup_object_bytes_mismatch")
	}
	if digestBytes(content) != entry.ObjectSHA256 {
		return record, errors.New("backup_object_hash_mismatch")
	}
	canonical, err := jcs.Transform(content)
	if err != nil {
		return record, errors.New("backup_object_invalid")
	}
	if !bytes.Equal(content, append(canonical, '\n')) {
		return record, errors.New("backup_object_encoding_mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var generic any
	if err = decoder.Decode(&generic); err != nil {
		return record, err
	}
	if err = validateRepositoryNumbers(generic, 0); err != nil {
		return record, err
	}
	var doc AccountDocument
	decoder = json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err = decoder.Decode(&doc); err != nil {
		return record, err
	}
	if doc.Kind != AccountDocumentKind || doc.Version != 1 || len(doc.Accounts) != 1 {
		return record, errors.New("backup_object_invalid")
	}
	record = doc.Accounts[0]
	if record.AccountRef != ref || record.Provider != entry.Provider {
		return record, errors.New("backup_object_identity_mismatch")
	}
	return record, nil
}
