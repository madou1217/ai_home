package remotebackup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

func verifyLegacyObject(raw []byte, ref string, entry ManifestEntry) (map[string]any, error) {
	var rec map[string]any
	if len(raw) != entry.Bytes {
		return rec, errors.New("backup_object_bytes_mismatch")
	}
	if !utf8.Valid(raw) {
		return rec, errors.New("backup_object_invalid")
	}
	var doc AccountDocument
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&doc); err != nil {
		return rec, err
	}
	if doc.Kind != AccountDocumentKind || doc.Version != 1 || len(doc.Accounts) != 1 {
		return rec, errors.New("backup_object_invalid")
	}
	typed := doc.Accounts[0]
	if typed.AccountRef != ref || typed.Provider != entry.Provider {
		return rec, errors.New("backup_object_identity_mismatch")
	}
	// Hash the complete raw record, not the typed projection (which discards unknown keys).
	var envelope struct {
		Accounts []json.RawMessage `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return rec, err
	}
	var value any
	d = json.NewDecoder(bytes.NewReader(envelope.Accounts[0]))
	d.UseNumber()
	if err := d.Decode(&value); err != nil {
		return rec, err
	}
	stable, err := StableStringify(value)
	if err != nil {
		return rec, err
	}
	if digestBytes([]byte(stable)) != entry.SHA256 {
		canonical, e := canonicalRepository(value)
		if e != nil || digestBytes(canonical) != entry.SHA256 {
			return rec, errors.New("backup_object_hash_mismatch")
		}
	}
	rec, ok := value.(map[string]any)
	if !ok {
		return nil, errors.New("backup_object_invalid")
	}
	return rec, nil
}
func migrateLegacyRepository(ctx context.Context, scope RepositoryScope, old *Manifest) (RepositoryManifest, error) {
	m := RepositoryManifest{Kind: ManifestKind, Version: 2, ObjectEncoding: repositoryLayout.ObjectEncoding, Accounts: map[string]RepositoryEntry{}}
	if old == nil {
		return m, nil
	}
	m.Revision = old.Revision
	m.Source = old.Source
	for ref, entry := range old.Accounts {
		p, e := AccountRelativePath(entry.Provider, ref)
		if e != nil {
			return m, e
		}
		raw, found, e := scope.Read(ctx, p, repositoryLayout.MaxObjectBytes)
		if e != nil {
			return m, e
		}
		if !found && entry.Deleted {
			copyEntry := entry
			m.Accounts[ref] = RepositoryEntry{Provider: entry.Provider, Deleted: true, Legacy: &copyEntry}
			continue
		}
		if !found {
			return m, errors.New("backup_object_missing")
		}
		rec, e := verifyLegacyObject(raw, ref, entry)
		if e != nil {
			return m, e
		}
		object, e := createRepositoryValue(entry.Provider, ref, rec)
		if e != nil {
			return m, e
		}
		if _, e = scope.PutImmutable(ctx, object.Path, object.Content); e != nil {
			return m, e
		}
		object.Entry.Deleted = entry.Deleted
		m.Accounts[ref] = object.Entry
	}
	return m, nil
}
