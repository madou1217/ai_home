// Package clipboard implements the clipboard manager domain model, rules, and service.
package clipboard

import (
	"errors"
	"strings"
)

// Kind identifies the canonical clipboard item category.
type Kind string

const (
	KindText  Kind = "text"
	KindLink  Kind = "link"
	KindImage Kind = "image"
	KindFile  Kind = "file"
)

const (
	// InlineTextMaxBytes is the threshold up to which text is stored inline in SQLite.
	InlineTextMaxBytes = 256 * 1024
	// MaxTextBytes is the maximum accepted UTF-8 text payload size (1 MiB).
	MaxTextBytes = 1024 * 1024
	// MaxImageBytes is the maximum accepted binary image payload size (8 MiB).
	MaxImageBytes = 8 * 1024 * 1024
	// MaxRequestBytes leaves room for double base64 (payload + sealed envelope)
	// of an 8 MiB image: ~8 MiB -> ~10.7 MiB JSON -> ~14.2 MiB sealed.
	MaxRequestBytes = 20 * 1024 * 1024
	// MaxPreviewRunes is the maximum single-line preview length.
	MaxPreviewRunes = 240
	// MaxImagePixels caps decoded dimensions before thumbnailing (decompression bombs).
	MaxImagePixels = 50_000_000
	// DetailTextPreviewBytes caps text returned by GET /items/{id}; full text is fetched via /content.
	DetailTextPreviewBytes = 64 * 1024

	DefaultRetentionDays      = 30
	DefaultMaxItems           = 500
	DefaultMaxItemBytes       = MaxImageBytes
	DefaultQuickOrbitPosition = "bottom"
	SoftDeleteRetentionDays   = 7
	DefaultListLimit          = 50
	MaxListLimit              = 200
	SyncKeyBytes              = 32
	SyncBatchMaxItems         = 50

	QuickOrbitPositionBottom = "bottom"
	QuickOrbitPositionLeft   = "left"
	QuickOrbitPositionRight  = "right"
)

// Setting keys stored in clipboard_settings.
const (
	SettingCaptureEnabled      = "captureEnabled"
	SettingSyncEnabled         = "syncEnabled"
	SettingSyncTargetProfileID = "syncTargetProfileId"
	SettingRetentionDays       = "retentionDays"
	SettingMaxItems            = "maxItems"
	SettingMaxItemBytes        = "maxItemBytes"
	SettingQuickOrbitPosition  = "quickOrbitPosition"
	SettingTransferLanes       = "transferLanes"
	SettingTransferChunkBytes  = "transferChunkBytes"
	SettingTransferEndpoints   = "transferEndpoints"
	SettingDeviceID            = "deviceId"
	SettingSyncKey             = "syncKey"
)

var (
	ErrNotMaterialized = errors.New("clipboard_content_not_materialized")
	ErrInvalidInput    = errors.New("clipboard_invalid_input")
	ErrEmptyContent    = errors.New("clipboard_empty_content")
	ErrItemTooLarge    = errors.New("clipboard_item_too_large")
	ErrInvalidKind     = errors.New("clipboard_invalid_kind")
	ErrNotFound        = errors.New("clipboard_item_not_found")
	ErrSyncKeyMissing  = errors.New("clipboard_sync_key_missing")
	ErrSyncKeyConflict = errors.New("clipboard_sync_key_conflict")
	ErrInvalidSyncKey  = errors.New("clipboard_invalid_sync_key")
)

// Valid reports whether the kind is a known canonical value.
func (k Kind) Valid() bool {
	switch k {
	case KindText, KindLink, KindImage, KindFile:
		return true
	default:
		return false
	}
}

// ParseKind parses a case-insensitive kind string.
func ParseKind(raw string) (Kind, error) {
	trimmed := Kind(strings.ToLower(strings.TrimSpace(raw)))
	if !trimmed.Valid() {
		return "", ErrInvalidKind
	}
	return trimmed, nil
}

// Item is a persisted clipboard history entry.
type Item struct {
	ID             string   `json:"id"`
	SHA256         string   `json:"sha256"`
	Kind           Kind     `json:"kind"`
	MIME           string   `json:"mime"`
	Text           string   `json:"text,omitempty"`
	BlobPath       string   `json:"blobPath,omitempty"`
	ByteSize       int64    `json:"byteSize"`
	Width          int      `json:"width,omitempty"`
	Height         int      `json:"height,omitempty"`
	Preview        string   `json:"preview"`
	PerceptualHash string   `json:"perceptualHash,omitempty"`
	Thumbnail      []byte   `json:"-"`
	Files          []string `json:"files,omitempty"`
	FileHashes     []string `json:"fileHashes,omitempty"`
	SourceDevice   string   `json:"sourceDevice,omitempty"`
	SourceApp      string   `json:"sourceApp,omitempty"`
	Pinned         bool     `json:"pinned"`
	Deleted        bool     `json:"deleted"`
	DeletedAtMs    int64    `json:"deletedAtMs,omitempty"`
	SeenCount      int      `json:"seenCount"`
	CreatedAtMs    int64    `json:"createdAtMs"`
	LastSeenAtMs   int64    `json:"lastSeenAtMs"`
	SyncedAtMs     int64    `json:"syncedAtMs,omitempty"`
	RemoteID       string   `json:"remoteId,omitempty"`
	// Materialized is false for synced index-only stubs; the full content is
	// fetched on demand when the user actually pastes the item.
	Materialized bool   `json:"materialized"`
	RemoteSource string `json:"remoteSource,omitempty"`
}

// Device identifies a host participating in clipboard history.
type Device struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Platform     string `json:"platform"`
	LastSeenAtMs int64  `json:"lastSeenAtMs"`
}

// NormalizeQuickOrbitPosition validates and canonicalizes the Quick Orbit anchor position.
func NormalizeQuickOrbitPosition(raw string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case QuickOrbitPositionBottom:
		return QuickOrbitPositionBottom, true
	case QuickOrbitPositionLeft:
		return QuickOrbitPositionLeft, true
	case QuickOrbitPositionRight:
		return QuickOrbitPositionRight, true
	default:
		return "", false
	}
}

// Settings holds persisted user configuration for the clipboard subsystem.
type Settings struct {
	CaptureEnabled      bool     `json:"captureEnabled"`
	SyncEnabled         bool     `json:"syncEnabled"`
	SyncTargetProfileID string   `json:"syncTargetProfileId"`
	RetentionDays       int      `json:"retentionDays"`
	MaxItems            int      `json:"maxItems"`
	MaxItemBytes        int64    `json:"maxItemBytes"`
	QuickOrbitPosition  string   `json:"quickOrbitPosition"`
	TransferLanes       int      `json:"transferLanes"`
	TransferChunkBytes  int64    `json:"transferChunkBytes"`
	TransferEndpoints   []string `json:"transferEndpoints"`
}

// DefaultSettings returns the canonical opt-in defaults.
func DefaultSettings() Settings {
	return Settings{
		CaptureEnabled:      false,
		SyncEnabled:         false,
		SyncTargetProfileID: "",
		RetentionDays:       DefaultRetentionDays,
		MaxItems:            DefaultMaxItems,
		MaxItemBytes:        DefaultMaxItemBytes,
		QuickOrbitPosition:  DefaultQuickOrbitPosition,
	}
}

// SettingsPatch applies partial updates to Settings.
type SettingsPatch struct {
	CaptureEnabled      *bool     `json:"captureEnabled,omitempty"`
	SyncEnabled         *bool     `json:"syncEnabled,omitempty"`
	SyncTargetProfileID *string   `json:"syncTargetProfileId,omitempty"`
	RetentionDays       *int      `json:"retentionDays,omitempty"`
	MaxItems            *int      `json:"maxItems,omitempty"`
	MaxItemBytes        *int64    `json:"maxItemBytes,omitempty"`
	QuickOrbitPosition  *string   `json:"quickOrbitPosition,omitempty"`
	TransferLanes       *int      `json:"transferLanes,omitempty"`
	TransferChunkBytes  *int64    `json:"transferChunkBytes,omitempty"`
	TransferEndpoints   *[]string `json:"transferEndpoints,omitempty"`
}

// CaptureStatus reports local OS clipboard capture readiness.
type CaptureStatus struct {
	Enabled   bool   `json:"enabled"`
	Supported bool   `json:"supported"`
	Running   bool   `json:"running"`
	Reason    string `json:"reason,omitempty"`
}

// SyncStatus reports background relay sync state.
type SyncStatus struct {
	Enabled         bool   `json:"enabled"`
	TargetProfileID string `json:"targetProfileId,omitempty"`
	LastSyncAtMs    int64  `json:"lastSyncAtMs,omitempty"`
	LastError       string `json:"lastError,omitempty"`
}

// TransportStatus describes read-only local transport availability (e.g. WireGuard/Tailscale).
type TransportStatus struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Detail    string `json:"detail,omitempty"`
}

// Status aggregates device, capture, sync, and store state.
type Status struct {
	Platform           string            `json:"platform"`
	Capture            CaptureStatus     `json:"capture"`
	Sync               SyncStatus        `json:"sync"`
	DeviceID           string            `json:"deviceId"`
	DeviceName         string            `json:"deviceName"`
	KeyFingerprint     string            `json:"keyFingerprint"`
	Transports         []TransportStatus `json:"transports"`
	ItemCount          int               `json:"itemCount"`
	PinnedCount        int               `json:"pinnedCount"`
	Devices            []Device          `json:"devices,omitempty"`
	QuickOrbitPosition string            `json:"quickOrbitPosition"`
}

// IngestInput is the normalized ingestion request shared by capture, API, and sync.
// MaterializedFile is one file payload transferred on demand.
type MaterializedFile struct {
	Name string
	Data []byte
}

type IngestInput struct {
	Kind           Kind
	MIME           string
	Text           string
	Data           []byte
	Files          []string
	FileHashes     []string
	PerceptualHash string
	Width          int
	Height         int
	Thumbnail      []byte
	SourceDevice   string
	SourceApp      string
	RemoteID       string
	SyncedAtMs     int64
	ObservedAtMs   int64
	// Lazy marks a synced index-only item with no content.
	Lazy bool
	// SHA256 is the sender's content id for lazy/full synced items.
	SHA256 string
	// Preview/ByteSize describe a lazy item (Thumbnail above is reused).
	Preview        string
	ByteSize       int64
	SourceEndpoint string
	RemoteSource   string
	// FilePayload carries materialized file bytes for on-demand transfers.
	FilePayload []MaterializedFile
}

// IngestResult reports the upserted item and whether it matched an existing SHA-256.
type IngestResult struct {
	Item         Item `json:"item"`
	Deduplicated bool `json:"deduplicated"`
}

// ListFilter filters list queries.
type ListFilter struct {
	Limit          int
	BeforeMs       int64
	Kind           Kind
	Query          string
	IncludeDeleted bool
}

// Content holds raw payload bytes and optional local blob path for an item.
type Content struct {
	Item             Item
	MIME             string
	Data             []byte
	AbsoluteBlobPath string
}

// PruneResult summarizes rows and blob files removed by retention cleanup.
type PruneResult struct {
	ExpiredItems      int `json:"expiredItems"`
	OverflowItems     int `json:"overflowItems"`
	PurgedSoftDeleted int `json:"purgedSoftDeleted"`
	RemovedBlobs      int `json:"removedBlobs"`
}

// PruneStoreResult is returned by Store.Prune before blob file deletion.
type PruneStoreResult struct {
	ExpiredItems      int
	OverflowItems     int
	PurgedSoftDeleted int
	OrphanBlobPaths   []string
}
