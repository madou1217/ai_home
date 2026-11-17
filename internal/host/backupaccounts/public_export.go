package backupaccounts

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeexportread"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

const PublicExportMaxInput = 256 * 1024

// PublicExportMaxOutput is the metadata pipe budget, including its newline.
const PublicExportMaxOutput = 64 * 1024
const maxPublicDocument = 64 * 1024 * 1024

type publicExportRequest struct {
	Version   int      `json:"version"`
	Tokens    []string `json:"tokens"`
	Provider  string   `json:"provider"`
	Directory string   `json:"directory"`
}

// PublicExportResult intentionally contains no credential or document payload.
type PublicExportResult struct {
	Version  int                           `json:"version"`
	Path     string                        `json:"path"`
	Exported int                           `json:"exported"`
	Skipped  []remotebackup.SkippedAccount `json:"skipped"`
}

type publicDocument struct {
	Kind       string `json:"kind"`
	Version    int    `json:"version"`
	ExportedAt string `json:"exportedAt"`
	Source     struct {
		Host string `json:"host"`
	} `json:"source"`
	Accounts []nativeexportread.Record `json:"accounts"`
}

// ExportPublic transfers the existing public legacy projection's read/selection
// and file ownership to Go. It does not silently replace it with the canonical
// offline export's different account set or consult a running service.
func ExportPublic(ctx context.Context, home string, input []byte) (PublicExportResult, error) {
	result := PublicExportResult{Version: 1, Skipped: []remotebackup.SkippedAccount{}}
	if len(input) > PublicExportMaxInput || ctx == nil {
		return result, errors.New("public_export_input_invalid")
	}
	wire := make(map[string]json.RawMessage)
	decoder := json.NewDecoder(bytes.NewReader(input))
	begin, err := decoder.Token()
	if err != nil || begin != json.Delim('{') {
		return result, errors.New("public_export_input_invalid")
	}
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok {
			return result, errors.New("public_export_input_invalid")
		}
		if _, exists := wire[name]; exists {
			return result, errors.New("public_export_input_invalid")
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return result, errors.New("public_export_input_invalid")
		}
		wire[name] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(wire) != 4 {
		return result, errors.New("public_export_input_invalid")
	}
	for _, key := range []string{"version", "tokens", "provider", "directory"} {
		if value, ok := wire[key]; !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return result, errors.New("public_export_input_invalid")
		}
	}
	var tokenValues []json.RawMessage
	if json.Unmarshal(wire["tokens"], &tokenValues) != nil {
		return result, errors.New("public_export_input_invalid")
	}
	for _, value := range tokenValues {
		value = bytes.TrimSpace(value)
		if len(value) == 0 || value[0] != '"' {
			return result, errors.New("public_export_input_invalid")
		}
	}
	var request publicExportRequest
	decoder = json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || request.Version != 1 || request.Tokens == nil || len(request.Tokens) > 5000 || !filepath.IsAbs(request.Directory) || strings.IndexByte(request.Directory, 0) >= 0 {
		return result, errors.New("public_export_input_invalid")
	}
	for _, token := range request.Tokens {
		if strings.IndexByte(token, 0) >= 0 {
			return result, errors.New("public_export_input_invalid")
		}
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return result, errors.New("public_export_catalog_invalid")
	}
	selectors, target, err := nativeexportread.Tokens(request.Tokens, request.Provider, catalog)
	if err != nil {
		return result, err
	}
	records, err := nativeexportread.Read(ctx, home, catalog)
	if err != nil {
		return result, err
	}
	selection, err := nativeexportread.Select(selectors, records, catalog)
	if err != nil {
		return result, err
	}
	document := publicDocument{Kind: "aih-accounts", Version: 1,
		ExportedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Accounts: []nativeexportread.Record{}}
	host, err := os.Hostname()
	if err != nil {
		return result, errors.New("public_export_host_unavailable")
	}
	document.Source.Host = host
	for _, record := range selection.Records {
		if len(record.Env) == 0 && len(record.NativeAuth) == 0 {
			result.Skipped = append(result.Skipped, remotebackup.SkippedAccount{Provider: record.Provider, AccountRef: record.AccountRef, Reason: "credentials_missing"})
			continue
		}
		if record.Provider == "zcode" {
			record.NativeAuth = remotebackup.PortableZcodeNativeAuth(record.NativeAuth)
		}
		document.Accounts = append(document.Accounts, record)
	}
	if target == "" {
		day := time.Now().UTC().Format("2006-01-02")
		target = "aih-accounts-" + day + ".json"
		if len(selection.AccountRefs) == 1 && len(document.Accounts) == 1 {
			account := document.Accounts[0]
			target = "aih-account-" + account.Provider + "-" + account.AccountRef + "-" + day + ".json"
		} else if len(selection.Providers) == 1 {
			target = "aih-accounts-" + selection.Providers[0] + "-" + day + ".json"
		}
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(request.Directory, target)
	}
	target = filepath.Clean(target)
	// Match JSON.stringify's literal HTML/Unicode preservation. Formatting and
	// map key order are not credential semantics; the document is the same v1.
	var body bytes.Buffer
	encoder := json.NewEncoder(&body)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(document); err != nil || body.Len() > maxPublicDocument {
		return result, errors.New("public_export_document_invalid")
	}
	defer clear(body.Bytes())
	if err := ctx.Err(); err != nil {
		return result, errors.New("public_export_cancelled")
	}
	result.Path, result.Exported = target, len(document.Accounts)
	// Admission precedes the first credential-file side effect. JSON.Marshal
	// uses the same default HTML escaping as cmd's stdout Encoder; add its LF.
	metadata, err := json.Marshal(result)
	if err != nil || len(metadata)+1 > PublicExportMaxOutput {
		return PublicExportResult{}, errors.New("public_export_output_limit")
	}
	if err := writePublicDocument(ctx, target, body.Bytes()); err != nil {
		return PublicExportResult{}, errors.New("public_export_output_unsafe_or_unwritable")
	}
	return result, nil
}

// pinPublicDirectory walks from a fixed filesystem root. Every component must
// be a real directory; once opened all further operations use that directory
// handle, not an unchecked absolute path. Existing permissions are not changed.
func pinPublicDirectory(directory string) (*os.Root, error) {
	if runtime.GOOS == "darwin" {
		// macOS's fixed OS aliases are normalized explicitly; arbitrary symlink
		// ancestors remain forbidden, including user-created links within /tmp.
		for _, alias := range []string{"/tmp", "/var"} {
			if directory == alias || strings.HasPrefix(directory, alias+"/") {
				directory = "/private" + directory
				break
			}
		}
	}
	volume := filepath.VolumeName(directory)
	base := volume + string(filepath.Separator)
	current, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(base, directory)
	if err != nil || strings.HasPrefix(relative, "..") {
		current.Close()
		return nil, errors.New("public_export_directory_invalid")
	}
	if relative == "." {
		return current, nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." || component == ".." {
			current.Close()
			return nil, errors.New("public_export_directory_invalid")
		}
		before, err := current.Lstat(component)
		if errors.Is(err, os.ErrNotExist) {
			if err := current.Mkdir(component, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
				current.Close()
				return nil, err
			}
			before, err = current.Lstat(component)
		}
		if err != nil || !before.IsDir() {
			current.Close()
			return nil, errors.New("public_export_directory_invalid")
		}
		child, err := current.OpenRoot(component)
		if err != nil {
			current.Close()
			return nil, err
		}
		opened, statErr := child.Stat(".")
		if statErr != nil || !os.SameFile(before, opened) {
			child.Close()
			current.Close()
			return nil, errors.New("public_export_directory_changed")
		}
		current.Close()
		current = child
	}
	return current, nil
}

func writePublicDocument(ctx context.Context, target string, body []byte) error {
	directory, err := pinPublicDirectory(filepath.Dir(target))
	if err != nil {
		return err
	}
	defer directory.Close()
	name := filepath.Base(target)
	before, err := directory.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && !before.Mode().IsRegular() {
		return errors.New("public_export_target_invalid")
	}
	exists := err == nil
	temporary := ".aih-export-" + rand.Text() + ".partial"
	file, err := directory.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	published := false
	defer func() {
		file.Close()
		if !published {
			directory.Remove(temporary)
		}
	}()
	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := file.Write(body); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	after, err := directory.Lstat(name)
	if exists {
		if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
			return errors.New("public_export_target_changed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("public_export_target_changed")
	}
	// Rename replaces the directory entry; it does not follow a raced final
	// symlink or truncate a preexisting file. No delete-then-rename fallback.
	if err := directory.Rename(temporary, name); err != nil {
		return err
	}
	published = true
	return nil
}
