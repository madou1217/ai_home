package aliasdisplay

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

//go:embed alias_display_rows.json
var embeddedSource []byte

// Provenance identifies the SDK canonical-model source and expansion policy.
// SourceHash hashes JSON.stringify(snapshot.models); SnapshotFileHash hashes the
// SDK's original snapshot module. PayloadHash separately verifies embedded rows.
// Neither is a generation of the user's canonical model_alias table.
type Provenance struct {
	Package          string `json:"package"`
	SDKVersion       string `json:"sdkVersion"`
	GeneratedAt      string `json:"generatedAt"`
	SourceHash       string `json:"sourceHash"`
	SnapshotFileHash string `json:"snapshotFileHash"`
	PolicyVersion    int    `json:"policyVersion"`
	Collation        string `json:"collation"`
}

type row struct {
	ID         string `json:"id"`
	Family     string `json:"family"`
	ReleasedAt int64  `json:"releasedAt"`
}

type source struct {
	Provenance Provenance
	Families   []string
	Rows       []row
}

// Source returns value-only provenance for a migration report. It validates the
// same immutable source as List and never exposes mutable cached rows.
func Source() (Provenance, error) {
	catalog, err := loadSource()
	if err != nil {
		return Provenance{}, err
	}
	return catalog.Provenance, nil
}

var loadSource = sync.OnceValues(func() (*source, error) {
	var doc struct {
		SchemaVersion int             `json:"schemaVersion"`
		Source        Provenance      `json:"source"`
		PayloadHash   string          `json:"payloadHash"`
		Families      json.RawMessage `json:"families"`
		Rows          json.RawMessage `json:"rows"`
	}
	if err := decodeStrict(embeddedSource, &doc); err != nil {
		return nil, fmt.Errorf("%w: decode: %v", ErrInvalidSource, err)
	}
	p := doc.Source
	if doc.SchemaVersion != 1 || p.Package != "@opencode-ai/models" || p.PolicyVersion != 1 || p.Collation != "node-localeCompare" || strings.TrimSpace(p.SDKVersion) == "" {
		return nil, fmt.Errorf("%w: unsupported provenance", ErrInvalidSource)
	}
	if _, err := time.Parse(time.RFC3339Nano, p.GeneratedAt); err != nil {
		return nil, fmt.Errorf("%w: generatedAt", ErrInvalidSource)
	}
	for _, value := range []string{p.SourceHash, p.SnapshotFileHash, doc.PayloadHash} {
		digest, err := hex.DecodeString(value)
		if err != nil || len(digest) != sha256.Size || hex.EncodeToString(digest) != value {
			return nil, fmt.Errorf("%w: invalid digest", ErrInvalidSource)
		}
	}
	// Compact the generator's original JSON rather than re-marshal strings with
	// Go's HTML escaping; this reproduces JSON.stringify({families, rows}).
	var families, rows bytes.Buffer
	if err := json.Compact(&families, doc.Families); err != nil {
		return nil, fmt.Errorf("%w: families: %v", ErrInvalidSource, err)
	}
	if err := json.Compact(&rows, doc.Rows); err != nil {
		return nil, fmt.Errorf("%w: rows: %v", ErrInvalidSource, err)
	}
	hash := sha256.New()
	hash.Write([]byte(`{"families":`))
	hash.Write(families.Bytes())
	hash.Write([]byte(`,"rows":`))
	hash.Write(rows.Bytes())
	hash.Write([]byte(`}`))
	if hex.EncodeToString(hash.Sum(nil)) != doc.PayloadHash {
		return nil, fmt.Errorf("%w: payload checksum mismatch", ErrInvalidSource)
	}
	catalog := &source{Provenance: p}
	if err := decodeStrict(doc.Families, &catalog.Families); err != nil {
		return nil, fmt.Errorf("%w: families: %v", ErrInvalidSource, err)
	}
	if err := decodeStrict(doc.Rows, &catalog.Rows); err != nil {
		return nil, fmt.Errorf("%w: rows: %v", ErrInvalidSource, err)
	}
	if len(catalog.Rows) == 0 || len(catalog.Families) == 0 {
		return nil, fmt.Errorf("%w: empty catalog", ErrInvalidSource)
	}
	knownFamilies := make(map[string]bool, len(catalog.Families))
	for _, family := range catalog.Families {
		if family == "" || family != strings.TrimSpace(family) {
			return nil, fmt.Errorf("%w: invalid family", ErrInvalidSource)
		}
		if _, duplicate := knownFamilies[family]; duplicate {
			return nil, fmt.Errorf("%w: duplicate family", ErrInvalidSource)
		}
		knownFamilies[family] = false
	}
	seen := make(map[string]bool, len(catalog.Rows))
	for _, row := range catalog.Rows {
		if row.ID == "" || row.ID != strings.TrimSpace(row.ID) || strings.Contains(row.ID, "/") || seen[row.ID] || row.ReleasedAt < -8_640_000_000_000_000 || row.ReleasedAt > 8_640_000_000_000_000 {
			return nil, fmt.Errorf("%w: invalid/duplicate model row", ErrInvalidSource)
		}
		if _, ok := knownFamilies[row.Family]; !ok {
			return nil, fmt.Errorf("%w: unknown model family", ErrInvalidSource)
		}
		seen[row.ID], knownFamilies[row.Family] = true, true
	}
	for _, used := range knownFamilies {
		if !used {
			return nil, fmt.Errorf("%w: unused model family", ErrInvalidSource)
		}
	}
	return catalog, nil
})

func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}
