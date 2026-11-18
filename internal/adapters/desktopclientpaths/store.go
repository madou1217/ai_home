// Package desktopclientpaths owns the complete desktop-client-paths cache key.
// Cache records are launch hints, never process identity or permission to stop.
package desktopclientpaths

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountmaintenance"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const key = "desktop-client-paths"

var errInvalid = errors.New("desktop_cache_record_invalid")
var errNoChange = errors.New("desktop_cache_no_change")

type Request struct {
	Intent               string `json:"intent"`
	Operation            string `json:"operation"`
	AIHomeDir            string `json:"aiHomeDir"`
	Provider             string `json:"provider"`
	ExecutablePath       string `json:"executablePath,omitempty"`
	ExpectedRecordSHA256 string `json:"expectedRecordSha256,omitempty"`
}
type Record struct {
	ClientName     string `json:"clientName"`
	ExecutablePath string `json:"executablePath"`
	BundlePath     string `json:"bundlePath"`
}
type Result struct {
	OK             bool    `json:"ok"`
	Found          bool    `json:"found"`
	Changed        bool    `json:"changed"`
	Platform       string  `json:"platform"`
	Reason         string  `json:"reason"`
	Record         *Record `json:"record"`
	RecordSHA256   string  `json:"recordSha256"`
	OutcomeUnknown bool    `json:"outcomeUnknown"`
}

func safeText(s string) bool {
	if s == "" || s != strings.TrimSpace(s) || len(s) > 8192 || !utf8.ValidString(s) {
		return false
	}
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 32 || r == 127 })
}

// Object rejects duplicate keys, null, nonobjects, invalid UTF-8 and trailing input.
// RawMessage preserves unknown metadata and numeric tokens during leaf updates.
func Object(raw []byte) (map[string]json.RawMessage, error) {
	if len(raw) > 1024*1024 || !utf8.Valid(raw) {
		return nil, errInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	if token, err := d.Token(); err != nil || token != json.Delim('{') {
		return nil, errInvalid
	}
	out := map[string]json.RawMessage{}
	for d.More() {
		token, err := d.Token()
		if err != nil {
			return nil, errInvalid
		}
		name, ok := token.(string)
		if !ok {
			return nil, errInvalid
		}
		if _, exists := out[name]; exists {
			return nil, errInvalid
		}
		var value json.RawMessage
		if d.Decode(&value) != nil {
			return nil, errInvalid
		}
		out[name] = value
	}
	if token, err := d.Token(); err != nil || token != json.Delim('}') {
		return nil, errInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errInvalid
	}
	return out, nil
}

func platformConfig(provider string) (*providers.DesktopPlatform, string) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, ""
	}
	definition, ok := catalog.Get(provider)
	if !ok || definition.ID != provider || definition.CLI == nil || definition.CLI.DesktopClient == nil {
		return nil, ""
	}
	client := definition.CLI.DesktopClient
	switch runtime.GOOS {
	case "darwin":
		return client.MacOS, "macos"
	case "win32", "windows":
		return client.Windows, "windows"
	case "linux":
		return client.Linux, "linux"
	}
	return nil, ""
}

func Validate(request Request) bool {
	if request.Intent != key || !safeText(request.AIHomeDir) || !filepath.IsAbs(request.AIHomeDir) || filepath.Clean(request.AIHomeDir) != request.AIHomeDir {
		return false
	}
	config, _ := platformConfig(request.Provider)
	if config == nil {
		return false
	}
	switch request.Operation {
	case "get":
		return request.ExecutablePath == "" && request.ExpectedRecordSHA256 == ""
	case "remember":
		_, err := pathRecord(request.ExecutablePath, config.ClientName)
		return err == nil && request.ExpectedRecordSHA256 == ""
	case "forget":
		decoded, err := hex.DecodeString(request.ExpectedRecordSHA256)
		return request.ExecutablePath == "" && err == nil && len(decoded) == sha256.Size && strings.ToLower(request.ExpectedRecordSHA256) == request.ExpectedRecordSHA256
	}
	return false
}

func pathRecord(executable, clientName string) (*Record, error) {
	if !safeText(executable) || !filepath.IsAbs(executable) || filepath.Clean(executable) != executable || !safeText(clientName) {
		return nil, errInvalid
	}
	record := &Record{ClientName: clientName, ExecutablePath: executable}
	if runtime.GOOS == "darwin" {
		before, after, ok := strings.Cut(executable, "/Contents/MacOS/")
		if !ok || !strings.HasSuffix(before, ".app") || strings.Contains(before, ".app/Contents/") || after == "" || strings.Contains(after, "/") {
			return nil, errInvalid
		}
		record.BundlePath = before
	}
	return record, nil
}

func leaf(root map[string]json.RawMessage, provider, platform string) (map[string]json.RawMessage, map[string]json.RawMessage, *Record, string, error) {
	providerFields := map[string]json.RawMessage{}
	if raw, exists := root[provider]; exists {
		var err error
		providerFields, err = Object(raw)
		if err != nil {
			return nil, nil, nil, "", err
		}
	}
	raw, exists := providerFields[platform]
	if !exists {
		return providerFields, nil, nil, "", nil
	}
	fields, err := Object(raw)
	if err != nil {
		return nil, nil, nil, "", err
	}
	var record Record
	for name, target := range map[string]*string{"clientName": &record.ClientName, "executablePath": &record.ExecutablePath, "bundlePath": &record.BundlePath} {
		value, exists := fields[name]
		if !exists && name == "bundlePath" {
			continue
		}
		if !exists || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || json.Unmarshal(value, target) != nil {
			return nil, nil, nil, "", errInvalid
		}
	}
	expected, err := pathRecord(record.ExecutablePath, record.ClientName)
	if err != nil || record.BundlePath != expected.BundlePath {
		return nil, nil, nil, "", errInvalid
	}
	encoded, err := json.Marshal(fields)
	if err != nil {
		return nil, nil, nil, "", errInvalid
	}
	hash := sha256.Sum256(encoded)
	return providerFields, fields, &record, hex.EncodeToString(hash[:]), nil
}

func failure(result Result, err error) Result {
	result.OK = false
	result.Found = false
	result.Changed = false
	result.Record = nil
	result.RecordSHA256 = ""
	result.Reason = "desktop_cache_unavailable"
	if errors.Is(err, errInvalid) {
		result.Reason = "desktop_cache_record_invalid"
	} else if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		result.Reason = "desktop_cache_cancelled"
	} else if coded, ok := pluginerr.From(err); ok {
		switch coded.Code {
		case accountmaintenance.CodeBusy, accountmaintenance.CodeInProgress:
			result.Reason = coded.Code
		}
	} else if strings.Contains(strings.ToLower(err.Error()), "locked") || strings.Contains(strings.ToLower(err.Error()), "busy") {
		result.Reason = "desktop_cache_busy"
	}
	return result
}

// inspectPaths rejects symlink/hardlink files and records existing identities.
// Rechecks reduce replacement windows; SQLite pathname opens are not atomic bindings.
func inspectPaths(root string) (map[string]os.FileInfo, error) {
	// Reject symlinks in every existing ancestor, not just the final root.
	for parent := root; ; parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return nil, errInvalid
		}
		if parent == filepath.Dir(parent) {
			break
		}
	}
	state := map[string]os.FileInfo{}
	directories := map[string]bool{".": true, "run": true, "run/maintenance": true}
	names := []string{".", "run", "run/maintenance", "run/maintenance/oauth-rekey.lock"}
	for _, base := range []string{"aih.db", "run/maintenance/access.sqlite"} {
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			names = append(names, base+suffix)
		}
	}
	for _, name := range names {
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(name)))
		if errors.Is(err, os.ErrNotExist) {
			state[name] = nil
			continue
		}
		if err != nil {
			return nil, err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return nil, errInvalid
		}
		if directories[name] {
			if !info.IsDir() {
				return nil, errInvalid
			}
		} else if !info.Mode().IsRegular() || hardlinks(info) > 1 {
			return nil, errInvalid
		}
		state[name] = info
	}
	for _, base := range []string{"aih.db", "run/maintenance/access.sqlite"} {
		if state[base] == nil {
			for _, suffix := range []string{"-wal", "-shm", "-journal"} {
				if state[base+suffix] != nil {
					return nil, errInvalid
				}
			}
		}
	}
	// Validate the nearest existing parent as well when the requested root is absent.
	if state["."] == nil {
		for parent := filepath.Dir(root); ; parent = filepath.Dir(parent) {
			info, err := os.Lstat(parent)
			if errors.Is(err, os.ErrNotExist) {
				if parent == filepath.Dir(parent) {
					return nil, errInvalid
				}
				continue
			}
			if err != nil {
				return nil, err
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, errInvalid
			}
			break
		}
	}
	return state, nil
}

func hardlinks(info os.FileInfo) uint64 {
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return 0
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0
	}
	field := value.FieldByName("Nlink")
	if field.IsValid() && field.CanUint() {
		return field.Uint()
	}
	// Windows FileInfo does not expose Nlink; this is not a Windows hardlink guarantee.
	return 0
}

func sameBinding(before, after map[string]os.FileInfo) error {
	for name, info := range before {
		current := after[name]
		if info != nil && (current == nil || !os.SameFile(info, current)) {
			return errInvalid
		}
		if info == nil && current != nil && strings.HasPrefix(name, "aih.db") {
			return errInvalid
		}
	}
	return nil
}

func Execute(ctx context.Context, request Request) Result {
	result := Result{Platform: runtime.GOOS}
	if !Validate(request) {
		result.Reason = "desktop_cache_request_invalid"
		return result
	}
	if err := ctx.Err(); err != nil {
		return failure(result, err)
	}
	_, platform := platformConfig(request.Provider)
	database := businessdb.Path(request.AIHomeDir)
	before, err := inspectPaths(request.AIHomeDir)
	if err != nil {
		return failure(result, err)
	}
	// Only a root with no business or coordination state qualifies as fresh.
	if request.Operation == "get" && before["aih.db"] == nil && before["run"] == nil {
		fresh := true
		for name, info := range before {
			if name != "." && info != nil {
				fresh = false
			}
		}
		if fresh {
			after, err := inspectPaths(request.AIHomeDir)
			if err != nil {
				return failure(result, err)
			}
			if err := sameBinding(before, after); err != nil {
				return failure(result, err)
			}
			for name, info := range after {
				if name != "." && info != nil {
					return failure(result, errInvalid)
				}
			}
			result.OK = true
			result.Reason = "missing"
			return result
		}
	}
	lease, err := accountmaintenance.Acquire(ctx, request.AIHomeDir)
	if err != nil {
		return failure(result, err)
	}
	defer lease.Close()
	after, err := inspectPaths(request.AIHomeDir)
	if err != nil {
		return failure(result, err)
	}
	if err := sameBinding(before, after); err != nil {
		return failure(result, err)
	}
	if err := businessdb.CheckReady(ctx, database); err != nil {
		return failure(result, err)
	}
	if request.Operation == "get" && after["aih.db"] != nil {
		db, err := appstate.OpenReadOnly(ctx, database)
		if err != nil {
			return failure(result, err)
		}
		rows, schemaErr := db.QueryContext(ctx, "SELECT key,value,updated_at FROM app_kv LIMIT 0")
		if rows != nil {
			_ = rows.Close()
		}
		closeErr := db.Close()
		if schemaErr != nil {
			return failure(result, errInvalid)
		}
		if closeErr != nil {
			return failure(result, closeErr)
		}
	}
	read := func(current string, found bool) (map[string]json.RawMessage, error) {
		if !found {
			return map[string]json.RawMessage{}, nil
		}
		return Object([]byte(current))
	}
	if request.Operation == "get" {
		current, found, err := appstate.ReadKV(ctx, database, key)
		if err != nil {
			return failure(result, err)
		}
		root, err := read(current, found)
		if err != nil {
			return failure(result, err)
		}
		_, _, record, hash, err := leaf(root, request.Provider, platform)
		if err != nil {
			return failure(result, err)
		}
		result.OK = true
		result.Record = record
		result.RecordSHA256 = hash
		result.Found = record != nil
		if !result.Found {
			result.Reason = "missing"
		}
		return result
	}
	mutationPlanned := false
	err = appstate.UpdateKV(ctx, database, key, func(current string, found bool) (string, error) {
		root, err := read(current, found)
		if err != nil {
			return "", err
		}
		providerFields, fields, record, hash, err := leaf(root, request.Provider, platform)
		if err != nil {
			return "", err
		}
		result.Record = record
		result.RecordSHA256 = hash
		result.Found = record != nil
		if request.Operation == "forget" {
			if record == nil {
				result.Reason = "missing"
				return "", errNoChange
			}
			if hash != request.ExpectedRecordSHA256 {
				result.Reason = "record_changed"
				return "", errNoChange
			}
			delete(providerFields, platform)
			result.Record = nil
			result.RecordSHA256 = ""
			result.Found = false
		} else {
			next, err := pathRecord(request.ExecutablePath, func() string { c, _ := platformConfig(request.Provider); return c.ClientName }())
			if err != nil {
				return "", err
			}
			if fields == nil {
				fields = map[string]json.RawMessage{}
			}
			prior, _ := json.Marshal(fields)
			for name, value := range map[string]string{"clientName": next.ClientName, "executablePath": next.ExecutablePath, "bundlePath": next.BundlePath} {
				fields[name], _ = json.Marshal(value)
			}
			encoded, _ := json.Marshal(fields)
			result.Record = next
			result.Found = true
			sum := sha256.Sum256(encoded)
			result.RecordSHA256 = hex.EncodeToString(sum[:])
			if bytes.Equal(prior, encoded) {
				return "", errNoChange
			}
			providerFields[platform] = encoded
		}
		if len(providerFields) == 0 {
			delete(root, request.Provider)
		} else {
			root[request.Provider], _ = json.Marshal(providerFields)
		}
		encoded, err := json.Marshal(root)
		if err != nil || len(encoded) > 1024*1024 {
			return "", errInvalid
		}
		mutationPlanned = true
		return string(encoded), nil
	})
	if errors.Is(err, errNoChange) {
		result.OK = true
		return result
	}
	if err != nil {
		result.OutcomeUnknown = mutationPlanned
		return failure(result, err)
	}
	result.OK = true
	result.Changed = true
	return result
}