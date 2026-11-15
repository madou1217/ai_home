package remotebackup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/gowebpki/jcs"
	"sort"
	"unicode/utf8"
)

type RepositoryManifest struct {
	Kind           string                     `json:"kind"`
	Version        int                        `json:"version"`
	ObjectEncoding string                     `json:"objectEncoding"`
	Source         ManifestSource             `json:"source"`
	Revision       int                        `json:"revision"`
	Accounts       map[string]RepositoryEntry `json:"accounts"`
	Skipped        []string                   `json:"skipped,omitempty"`
}
type RepositoryResult struct {
	Manifest                     RepositoryManifest
	Uploaded, Unchanged, Deleted int
	Incomplete                   []string
}

func repositoryFormat() ([]byte, error) {
	b, e := canonicalRepository(repositoryLayout)
	return append(b, '\n'), e
}
func parseRepositoryManifest(raw []byte) (*RepositoryManifest, error) {
	if err := validateRepositoryManifestShape(raw); err != nil {
		return nil, err
	}
	var m RepositoryManifest
	if !utf8.Valid(raw) {
		return nil, errors.New("backup_manifest_invalid")
	}
	canonical, err := jcs.Transform(raw)
	if err != nil {
		return nil, errors.New("backup_manifest_invalid")
	}
	if !bytes.Equal(raw, append(canonical, '\n')) {
		return nil, errors.New("backup_manifest_encoding_mismatch")
	}

	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, errors.New("backup_manifest_invalid")
	}
	if m.Kind != ManifestKind || m.Version != 2 || m.ObjectEncoding != repositoryLayout.ObjectEncoding {
		return nil, errors.New("backup_manifest_unsupported")
	}
	if m.Revision < 0 || m.Accounts == nil || len(m.Accounts) > repositoryLayout.MaxAccounts {
		return nil, errors.New("backup_manifest_invalid")
	}
	for ref, entry := range m.Accounts {
		if !validAccountRefPattern.MatchString(ref) || !validProviderPattern.MatchString(entry.Provider) || entry.Provider == "." || entry.Provider == ".." {
			return nil, errors.New("backup_manifest_invalid")
		}
		if entry.Legacy != nil {
			old := entry.Legacy
			if !entry.Deleted || entry.ObjectSHA256 != "" || entry.Bytes != 0 || !old.Deleted || old.Provider != entry.Provider || !sha256HexPattern.MatchString(old.SHA256) || old.Bytes <= 0 || old.Bytes > repositoryLayout.MaxObjectBytes {
				return nil, errors.New("backup_manifest_invalid")
			}
			continue
		}
		if _, err := objectPath(entry.ObjectSHA256); err != nil {
			return nil, err
		}
		if entry.Bytes <= 0 || entry.Bytes > repositoryLayout.MaxObjectBytes {
			return nil, errors.New("backup_manifest_invalid")
		}
	}
	totalBytes := 0
	for _, entry := range m.Accounts {
		if !entry.Deleted {
			totalBytes += entry.Bytes
		}
	}
	if totalBytes > repositoryLayout.MaxSnapshotBytes {
		return nil, errors.New("backup_snapshot_too_large")
	}
	for _, ref := range m.Skipped {
		if !validAccountRefPattern.MatchString(ref) {
			return nil, errors.New("backup_manifest_invalid")
		}
	}
	return &m, nil
}
func strictLegacyManifest(raw []byte) (*Manifest, error) {
	if !utf8.Valid(raw) {
		return nil, errors.New("backup_manifest_invalid")
	}
	var m Manifest
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &m); err != nil {
		return nil, errors.New("backup_manifest_invalid")
	}
	if m.Kind != ManifestKind || m.Version != 1 {
		return nil, errors.New("backup_manifest_unsupported")
	}
	if m.Accounts == nil || m.Revision < 0 || len(m.Accounts) > repositoryLayout.MaxAccounts {
		return nil, errors.New("backup_manifest_invalid")
	}
	for ref, e := range m.Accounts {
		if !validAccountRefPattern.MatchString(ref) || !validProviderPattern.MatchString(e.Provider) || e.Provider == "." || e.Provider == ".." || !sha256HexPattern.MatchString(e.SHA256) || e.Bytes <= 0 || e.Bytes > repositoryLayout.MaxObjectBytes {
			return nil, errors.New("backup_manifest_invalid")
		}
	}
	return &m, nil
}
func SyncRepository(ctx context.Context, strategy Strategy, accounts []AccountRecord, skipped []SkippedAccount, full bool, host string) (result RepositoryResult, resultErr error) {
	transport, ok := strategy.(RepositoryTransport)
	if !ok {
		return result, errors.New("backup_repository_transport_unsupported")
	}
	objects := map[string]RepositoryObject{}
	for _, record := range accounts {
		if _, ok := objects[record.AccountRef]; ok {
			return result, errors.New("backup_duplicate_account_ref")
		}
		o, e := createRepositoryObject(record)
		if e != nil {
			return result, e
		}
		objects[record.AccountRef] = o
	}
	if len(objects) > repositoryLayout.MaxAccounts {
		return result, errors.New("backup_too_many_accounts")
	}
	skipSet := map[string]bool{}
	for _, skip := range skipped {
		if !validAccountRefPattern.MatchString(skip.AccountRef) {
			return result, errors.New("backup_export_incomplete")
		}
		if _, exists := objects[skip.AccountRef]; exists {
			return result, errors.New("backup_export_ambiguous")
		}
		skipSet[skip.AccountRef] = true
	}
	scope, err := transport.BeginRepository(ctx)
	if err != nil {
		return result, err
	}
	defer func() {
		if e := scope.Release(context.Background()); e != nil {
			resultErr = errors.Join(e, resultErr)
		}
	}()
	format, err := repositoryFormat()
	if err != nil {
		return result, err
	}
	marker, markerFound, err := scope.Read(ctx, repositoryLayout.FormatPath, repositoryLayout.MaxManifestBytes)
	if err != nil {
		return result, err
	}
	raw, found, err := scope.Read(ctx, repositoryLayout.ManifestPath, repositoryLayout.MaxManifestBytes)
	if err != nil {
		return result, err
	}
	if found && !markerFound {
		return result, errors.New("backup_repository_format_missing")
	}
	if markerFound && !bytes.Equal(marker, format) {
		return result, errors.New("backup_repository_format_unsupported")
	}
	if markerFound && !found {
		return result, errors.New("backup_repository_initialization_required")
	}

	var previous RepositoryManifest
	if found {
		m, e := parseRepositoryManifest(raw)
		if e != nil {
			return result, e
		}
		previous = *m
	} else {
		legacyRaw, legacyFound, e := scope.Read(ctx, ManifestFileName, repositoryLayout.MaxManifestBytes)
		if e != nil {
			return result, e
		}
		var legacy *Manifest
		if legacyFound {
			legacy, e = strictLegacyManifest(legacyRaw)
			if e != nil {
				return result, e
			}
		}
		previous, e = migrateLegacyRepository(ctx, scope, legacy)
		if e != nil {
			return result, e
		}
	}
	next := map[string]RepositoryEntry{}
	for ref, o := range objects {
		created, e := scope.PutImmutable(ctx, o.Path, o.Content, full)
		if e != nil {
			return result, e
		}
		if created {
			result.Uploaded++
		} else {
			result.Unchanged++
		}
		next[ref] = o.Entry
	}
	for ref := range skipSet {
		if _, exists := objects[ref]; exists {
			return result, errors.New("backup_export_ambiguous")
		}
		if prior, exists := previous.Accounts[ref]; exists {
			next[ref] = prior
		}
		result.Incomplete = append(result.Incomplete, ref)
	}
	sort.Strings(result.Incomplete)
	for ref, prior := range previous.Accounts {
		if _, exists := next[ref]; exists {
			continue
		}
		if !prior.Deleted {
			result.Deleted++
		}
		prior.Deleted = true
		next[ref] = prior
	}
	if len(next) > repositoryLayout.MaxAccounts {
		return result, errors.New("backup_too_many_accounts")
	}
	for ref, entry := range next {
		if entry.Deleted {
			continue
		}
		p, _ := objectPath(entry.ObjectSHA256)
		data, found, e := scope.Read(ctx, p, repositoryLayout.MaxObjectBytes)
		if e != nil {
			return result, e
		}
		if !found {
			return result, errors.New("backup_object_missing")
		}
		if _, e = verifyRepositoryObject(data, ref, entry); e != nil {
			return result, e
		}
	}
	totalBytes := 0
	for _, entry := range next {
		if !entry.Deleted {
			totalBytes += entry.Bytes
		}
	}
	if totalBytes > repositoryLayout.MaxSnapshotBytes {
		return result, errors.New("backup_snapshot_too_large")
	}
	oldComp, _ := canonicalRepository(previous.Accounts)
	newComp, e := canonicalRepository(next)
	if e != nil {
		return result, e
	}
	oldSkip, _ := canonicalRepository(previous.Skipped)
	newSkip, _ := canonicalRepository(result.Incomplete)
	changed := !found || full || !bytes.Equal(oldComp, newComp) || !bytes.Equal(oldSkip, newSkip)
	result.Manifest = RepositoryManifest{Kind: ManifestKind, Version: 2, ObjectEncoding: repositoryLayout.ObjectEncoding, Source: ManifestSource{Host: host}, Revision: previous.Revision, Accounts: next, Skipped: result.Incomplete}
	if host == "" {
		result.Manifest.Source = previous.Source
	}
	if changed {
		result.Manifest.Revision++
	}
	encoded, e := canonicalRepository(result.Manifest)
	if e != nil {
		return result, e
	}
	encoded = append(encoded, '\n')
	if _, e = parseRepositoryManifest(encoded); e != nil {
		return result, e
	}
	if len(encoded) > repositoryLayout.MaxManifestBytes {
		return result, errors.New("backup_manifest_too_large")
	}
	if changed {
		hash := digestBytes(encoded)
		if _, e = scope.PutImmutable(ctx, repositoryLayout.ManifestsPrefix+hash+".json", encoded); e != nil {
			return result, e
		}
		previousHash := ""
		if found {
			previousHash = digestBytes(raw)
		}
		intent, e := canonicalRepository(map[string]any{"kind": "aih-backup-publish-intent", "version": 2, "manifestSha256": hash, "previousSha256": previousHash})
		if e != nil {
			return result, e
		}
		if e = scope.Journal(ctx, append(intent, '\n')); e != nil {
			return result, e
		}
		if !markerFound {
			if _, e = scope.PutImmutable(ctx, repositoryLayout.FormatPath, format); e != nil {
				scope.Retain()
				return result, e
			}
		}
		if e = scope.Publish(ctx, repositoryLayout.ManifestPath, encoded); e != nil {
			scope.Retain()
			return result, e
		}
	}
	return result, nil
}
