package backupaccounts

import (
	"bytes"
	"context"
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
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

const CompatibilityExportMaxInput = 16 * 1024
const CompatibilityExportMaxOutput = 64 * 1024 * 1024

type compatibilityExportResult struct {
	Version  int                           `json:"version"`
	Document publicDocument                `json:"document"`
	Exported int                           `json:"exported"`
	Skipped  []remotebackup.SkippedAccount `json:"skipped"`
}

// ExportCompatibilityDocument is the remaining remote caller's legacy account
// projection. It shares the public file export's single document owner. It does
// not merge canonical accounts, predict identities or operate a remote target.
func ExportCompatibilityDocument(ctx context.Context, home string, input []byte) ([]byte, error) {
	invalid := errors.New("compat_export_input_invalid")
	if ctx == nil || len(input) > CompatibilityExportMaxInput {
		return nil, invalid
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	begin, err := decoder.Token()
	if err != nil || begin != json.Delim('{') {
		return nil, invalid
	}
	values := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return nil, invalid
		}
		if _, duplicate := values[name]; duplicate {
			return nil, invalid
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, invalid
		}
		values[name] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || decoder.Decode(new(any)) != io.EOF || len(values) != 2 {
		return nil, invalid
	}
	var version int
	var hostName string
	if json.Unmarshal(values["version"], &version) != nil || version != 1 || bytes.Equal(bytes.TrimSpace(values["hostName"]), []byte("null")) || json.Unmarshal(values["hostName"], &hostName) != nil || len(hostName) > 4096 || strings.IndexFunc(hostName, func(r rune) bool { return r < 0x20 || r == 0x7f }) >= 0 {
		return nil, invalid
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, errors.New("compat_export_catalog_invalid")
	}
	// Public file export intentionally permits a never-initialized HOME. This
	// remote compatibility read must instead refuse a missing/changed source;
	// otherwise a missing database could be mistaken for a deletion snapshot.
	database, err := appstate.DatabasePath(home)
	if err != nil {
		return nil, errors.New("compat_export_source_invalid")
	}
	// Normalize only Darwin's fixed system aliases. Arbitrary symlink
	// ancestors remain forbidden, and the reader uses this same admitted home.
	home = filepath.Dir(database)
	if runtime.GOOS == "darwin" {
		for _, alias := range []string{"/tmp", "/var"} {
			if home == alias || strings.HasPrefix(home, alias+"/") {
				home = "/private" + home
				break
			}
		}
	}
	database = filepath.Join(home, filepath.Base(database))
	canonical, err := filepath.EvalSymlinks(database)
	if err != nil || canonical != database {
		return nil, errors.New("compat_export_source_invalid")
	}
	before, err := os.Lstat(database)
	if err != nil || !before.Mode().IsRegular() {
		return nil, errors.New("compat_export_source_invalid")
	}
	records, err := nativeexportread.Read(ctx, home, catalog)
	if err != nil {
		return nil, err
	}
	after, err := os.Lstat(database)
	canonicalAfter, canonicalErr := filepath.EvalSymlinks(database)
	if err != nil || canonicalErr != nil || canonicalAfter != database || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return nil, errors.New("compat_export_source_invalid")
	}
	document, skipped, err := compatibilityDocument(records, hostName)
	if err != nil {
		return nil, err
	}
	result := compatibilityExportResult{Version: 1, Document: document, Exported: len(document.Accounts), Skipped: skipped}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(result) != nil || output.Len() > CompatibilityExportMaxOutput {
		clear(output.Bytes())
		return nil, errors.New("compat_export_output_limit")
	}
	if ctx.Err() != nil {
		clear(output.Bytes())
		return nil, errors.New("compat_export_cancelled")
	}
	return output.Bytes(), nil
}

// compatibilityDocument is the sole portable-document constructor used by both
// the public file export and the remote backup compatibility read port.
func compatibilityDocument(records []nativeexportread.Record, hostName string) (publicDocument, []remotebackup.SkippedAccount, error) {
	document := publicDocument{Kind: "aih-accounts", Version: 1,
		ExportedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Accounts: []nativeexportread.Record{}}
	skipped := []remotebackup.SkippedAccount{}
	if hostName == "" {
		var err error
		hostName, err = os.Hostname()
		if err != nil {
			return document, skipped, errors.New("public_export_host_unavailable")
		}
	}
	document.Source.Host = hostName
	for _, record := range records {
		if len(record.Env) == 0 && len(record.NativeAuth) == 0 {
			skipped = append(skipped, remotebackup.SkippedAccount{Provider: record.Provider, AccountRef: record.AccountRef, Reason: "credentials_missing"})
			continue
		}
		if record.Provider == "zcode" {
			record.NativeAuth = remotebackup.PortableZcodeNativeAuth(record.NativeAuth)
		}
		document.Accounts = append(document.Accounts, record)
	}
	return document, skipped, nil
}
