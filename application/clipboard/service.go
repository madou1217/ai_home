package clipboard

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

// Service coordinates clipboard domain rules, deduplication, settings, and retention.
type Service struct {
	store    Store
	blobs    BlobStore
	clock    Clock
	probe    RuntimeProbe
	hostname func() (string, error)
	platform string
}

// NewService constructs a clipboard Service.
func NewService(store Store, blobs BlobStore, clock Clock) (*Service, error) {
	if store == nil || blobs == nil {
		return nil, fmt.Errorf("%w: store and blobs are required", ErrInvalidInput)
	}
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		store:    store,
		blobs:    blobs,
		clock:    clock,
		hostname: os.Hostname,
		platform: runtime.GOOS,
	}, nil
}

// SetRuntimeProbe attaches an optional live runtime probe (capture/sync/transports).
func (s *Service) SetRuntimeProbe(probe RuntimeProbe) {
	if s != nil {
		s.probe = probe
	}
}

// EnsureDevice guarantees a stable local deviceId in clipboard_settings and upserts clipboard_devices.
func (s *Service) EnsureDevice(ctx context.Context) (Device, error) {
	nowMs := s.clock().UnixMilli()
	deviceID, found, err := s.store.GetSetting(ctx, SettingDeviceID)
	if err != nil {
		return Device{}, err
	}
	deviceID = strings.TrimSpace(deviceID)
	if !found || deviceID == "" {
		persisted, err := s.store.SetSettingIfAbsent(ctx, SettingDeviceID, uuid.NewString(), nowMs)
		if err != nil {
			return Device{}, err
		}
		deviceID = strings.TrimSpace(persisted)
	}
	name := "unknown"
	if s.hostname != nil {
		if h, hErr := s.hostname(); hErr == nil && strings.TrimSpace(h) != "" {
			name = strings.TrimSpace(h)
		}
	}
	device := Device{
		ID:           deviceID,
		Name:         name,
		Platform:     s.platform,
		LastSeenAtMs: nowMs,
	}
	if err := s.store.UpsertDevice(ctx, device); err != nil {
		return Device{}, err
	}
	return device, nil
}

// Ingest validates, canonicalizes, hashes, stores blobs when needed, and idempotently upserts an item.
func (s *Service) Ingest(ctx context.Context, input IngestInput) (IngestResult, error) {
	if input.Kind != "" && !input.Kind.Valid() {
		return IngestResult{}, ErrInvalidKind
	}
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return IngestResult{}, err
	}
	maxItemBytes := settings.MaxItemBytes
	if maxItemBytes <= 0 || maxItemBytes > MaxImageBytes {
		maxItemBytes = MaxImageBytes
	}

	nowMs := input.ObservedAtMs
	if nowMs <= 0 {
		nowMs = s.clock().UnixMilli()
	}

	sourceDevice := strings.TrimSpace(input.SourceDevice)
	if sourceDevice == "" {
		if dev, devErr := s.EnsureDevice(ctx); devErr == nil {
			sourceDevice = dev.ID
		}
	}

	item := Item{
		ID:           uuid.NewString(),
		SourceDevice: sourceDevice,
		SourceApp:    strings.TrimSpace(input.SourceApp),
		RemoteID:     strings.TrimSpace(input.RemoteID),
		SyncedAtMs:   input.SyncedAtMs,
		CreatedAtMs:  nowMs,
		LastSeenAtMs: nowMs,
		SeenCount:    1,
	}

	mime := strings.TrimSpace(input.MIME)
	lowerMIME := strings.ToLower(mime)

	switch {
	case input.Kind == KindFile || len(input.Files) > 0:
		normalized, normErr := normalizeFilePaths(input.Files)
		if normErr != nil {
			return IngestResult{}, normErr
		}
		if len(normalized) == 0 {
			return IngestResult{}, ErrEmptyContent
		}
		canonical := []byte(strings.Join(normalized, "\n"))
		textLimit := minInt64(MaxTextBytes, maxItemBytes)
		if int64(len(canonical)) > textLimit {
			return IngestResult{}, ErrItemTooLarge
		}
		item.Kind = KindFile
		if mime == "" {
			mime = "text/uri-list"
		}
		item.MIME = mime
		item.SHA256 = sha256Hex(canonical)
		item.ByteSize = int64(len(canonical))
		item.Files = normalized
		item.Preview = buildFilePreview(normalized)

	case input.Kind == KindImage || strings.HasPrefix(lowerMIME, "image/") || (len(input.Data) > 0 && input.Text == ""):
		if len(input.Data) == 0 {
			return IngestResult{}, ErrEmptyContent
		}
		imageLimit := minInt64(MaxImageBytes, maxItemBytes)
		if int64(len(input.Data)) > imageLimit {
			return IngestResult{}, ErrItemTooLarge
		}
		item.Kind = KindImage
		if mime == "" {
			mime = detectImageMIME(input.Data)
		}
		item.MIME = mime
		item.SHA256 = sha256Hex(input.Data)
		item.ByteSize = int64(len(input.Data))
		item.Width = input.Width
		item.Height = input.Height
		item.Thumbnail = input.Thumbnail
		if len(item.Thumbnail) == 0 || item.Width == 0 || item.Height == 0 {
			if thumb, w, h, thumbErr := GenerateThumbnail(input.Data); thumbErr == nil {
				if item.Width == 0 {
					item.Width = w
				}
				if item.Height == 0 {
					item.Height = h
				}
				if len(item.Thumbnail) == 0 {
					item.Thumbnail = thumb
				}
			}
		}
		item.Preview = buildImagePreview(mime, item.Width, item.Height, item.ByteSize)
		relPath, writeErr := s.blobs.Write(item.SHA256, input.Data)
		if writeErr != nil {
			return IngestResult{}, writeErr
		}
		item.BlobPath = relPath

	default:
		text := input.Text
		if text == "" && len(input.Data) > 0 {
			text = string(input.Data)
		}
		if len(text) == 0 {
			return IngestResult{}, ErrEmptyContent
		}
		// Legacy clipboard bridges can hand over CP1252 bytes; normalize before
		// hashing so stored text is valid UTF-8 and survives JSON sync unchanged.
		text = NormalizeText(text)
		rawBytes := []byte(text)
		textLimit := minInt64(MaxTextBytes, maxItemBytes)
		if int64(len(rawBytes)) > textLimit {
			return IngestResult{}, ErrItemTooLarge
		}
		kind := deriveTextKind(input.Kind, lowerMIME, text)
		item.Kind = kind
		if mime == "" {
			if kind == KindLink && strings.Contains(text, "\n") {
				mime = "text/uri-list"
			} else {
				mime = "text/plain; charset=utf-8"
			}
		}
		item.MIME = mime
		item.SHA256 = sha256Hex(rawBytes)
		item.ByteSize = int64(len(rawBytes))
		item.Preview = buildTextPreview(text, MaxPreviewRunes)
		if len(rawBytes) <= InlineTextMaxBytes {
			item.Text = text
		} else {
			relPath, writeErr := s.blobs.Write(item.SHA256, rawBytes)
			if writeErr != nil {
				return IngestResult{}, writeErr
			}
			item.BlobPath = relPath
		}
	}

	persisted, deduplicated, err := s.store.UpsertItem(ctx, item)
	if err != nil {
		return IngestResult{}, err
	}
	return IngestResult{Item: persisted, Deduplicated: deduplicated}, nil
}

// List returns lightweight history items ordered by pinned DESC, last_seen_at_ms DESC.
func (s *Service) List(ctx context.Context, filter ListFilter) ([]Item, error) {
	if filter.Kind != "" && !filter.Kind.Valid() {
		return nil, ErrInvalidKind
	}
	if filter.Limit <= 0 {
		filter.Limit = DefaultListLimit
	}
	if filter.Limit > MaxListLimit {
		filter.Limit = MaxListLimit
	}
	return s.store.ListItems(ctx, filter)
}

// Get retrieves an item by exact ID.
func (s *Service) Get(ctx context.Context, id string) (Item, error) {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" {
		return Item{}, ErrNotFound
	}
	item, found, err := s.store.GetItemByID(ctx, trimmed)
	if err != nil {
		return Item{}, err
	}
	if !found {
		return Item{}, ErrNotFound
	}
	return item, nil
}

// ResolveSelector resolves either a 1-based "#index" (over pinned DESC, last_seen_at_ms DESC, deleted=0),
// an exact ID, or a unique ID prefix (length >= 6).
func (s *Service) ResolveSelector(ctx context.Context, selector string) (Item, error) {
	trimmed := strings.TrimSpace(selector)
	if trimmed == "" {
		return Item{}, ErrNotFound
	}
	if strings.HasPrefix(trimmed, "#") {
		idx, err := strconv.Atoi(strings.TrimPrefix(trimmed, "#"))
		if err != nil || idx < 1 {
			return Item{}, fmt.Errorf("%w: invalid index selector %q", ErrInvalidInput, selector)
		}
		item, found, err := s.store.GetItemByIndex(ctx, idx)
		if err != nil {
			return Item{}, err
		}
		if !found {
			return Item{}, ErrNotFound
		}
		return item, nil
	}
	item, found, err := s.store.GetItemByID(ctx, trimmed)
	if err != nil {
		return Item{}, err
	}
	if found {
		return item, nil
	}
	if len(trimmed) >= 6 {
		item, found, err = s.store.GetItemByPrefix(ctx, trimmed)
		if err != nil {
			return Item{}, err
		}
		if found {
			return item, nil
		}
	}
	return Item{}, ErrNotFound
}

// ReadContent loads the exact payload bytes for an item (inline text, blob file, or newline-joined file paths).
func (s *Service) ReadContent(ctx context.Context, item Item) (Content, error) {
	result := Content{
		Item: item,
		MIME: item.MIME,
	}
	switch item.Kind {
	case KindFile:
		if result.MIME == "" {
			result.MIME = "text/uri-list"
		}
		result.Data = []byte(strings.Join(item.Files, "\n"))
		return result, nil
	case KindImage:
		if result.MIME == "" {
			result.MIME = "application/octet-stream"
		}
		if item.BlobPath == "" {
			return Content{}, ErrNotFound
		}
		absPath, err := s.blobs.ResolvePath(item.BlobPath)
		if err != nil {
			return Content{}, err
		}
		data, err := s.blobs.Read(item.BlobPath)
		if err != nil {
			return Content{}, err
		}
		result.Data = data
		result.AbsoluteBlobPath = absPath
		return result, nil
	default:
		if result.MIME == "" {
			result.MIME = "text/plain; charset=utf-8"
		}
		if item.BlobPath != "" {
			absPath, err := s.blobs.ResolvePath(item.BlobPath)
			if err != nil {
				return Content{}, err
			}
			data, err := s.blobs.Read(item.BlobPath)
			if err != nil {
				return Content{}, err
			}
			result.Data = data
			result.AbsoluteBlobPath = absPath
			return result, nil
		}
		result.Data = []byte(item.Text)
		return result, nil
	}
}

// SetPinned toggles pinned state on an item.
func (s *Service) SetPinned(ctx context.Context, id string, pinned bool) (Item, error) {
	item, found, err := s.store.SetPinned(ctx, strings.TrimSpace(id), pinned)
	if err != nil {
		return Item{}, err
	}
	if !found {
		return Item{}, ErrNotFound
	}
	return item, nil
}

// Delete soft-deletes an item, retaining its blob so ON CONFLICT(sha256) can resurrect it.
func (s *Service) Delete(ctx context.Context, id string) error {
	deleted, err := s.store.SoftDelete(ctx, strings.TrimSpace(id), s.clock().UnixMilli())
	if err != nil {
		return err
	}
	if !deleted {
		return ErrNotFound
	}
	return nil
}

// Clear soft-deletes active items (unpinned only unless includePinned is true).
func (s *Service) Clear(ctx context.Context, includePinned bool) (int, error) {
	return s.store.SoftDeleteAll(ctx, includePinned, s.clock().UnixMilli())
}

// Prune hard-deletes soft-deleted rows older than 7 days plus expired/overflow unpinned rows,
// and removes any orphaned blob files.
func (s *Service) Prune(ctx context.Context) (PruneResult, error) {
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return PruneResult{}, err
	}
	nowMs := s.clock().UnixMilli()
	retentionCutoffMs := nowMs - int64(settings.RetentionDays)*int64(24*time.Hour/time.Millisecond)
	softDeleteCutoffMs := nowMs - int64(SoftDeleteRetentionDays)*int64(24*time.Hour/time.Millisecond)

	storeRes, err := s.store.Prune(ctx, retentionCutoffMs, settings.MaxItems, softDeleteCutoffMs)
	if err != nil {
		return PruneResult{}, err
	}
	removedBlobs := 0
	for _, relPath := range storeRes.OrphanBlobPaths {
		if relPath == "" {
			continue
		}
		if delErr := s.blobs.Delete(relPath); delErr == nil {
			removedBlobs++
		}
	}
	return PruneResult{
		ExpiredItems:      storeRes.ExpiredItems,
		OverflowItems:     storeRes.OverflowItems,
		PurgedSoftDeleted: storeRes.PurgedSoftDeleted,
		RemovedBlobs:      removedBlobs,
	}, nil
}

// GetSettings loads clipboard settings merged with defaults.
func (s *Service) GetSettings(ctx context.Context) (Settings, error) {
	raw, err := s.store.GetAllSettings(ctx)
	if err != nil {
		return Settings{}, err
	}
	settings := DefaultSettings()
	if v, ok := raw[SettingCaptureEnabled]; ok {
		if parsed, parseErr := strconv.ParseBool(strings.TrimSpace(v)); parseErr == nil {
			settings.CaptureEnabled = parsed
		}
	}
	if v, ok := raw[SettingSyncEnabled]; ok {
		if parsed, parseErr := strconv.ParseBool(strings.TrimSpace(v)); parseErr == nil {
			settings.SyncEnabled = parsed
		}
	}
	if v, ok := raw[SettingSyncTargetProfileID]; ok {
		settings.SyncTargetProfileID = strings.TrimSpace(v)
	}
	if v, ok := raw[SettingRetentionDays]; ok {
		if parsed, parseErr := strconv.Atoi(strings.TrimSpace(v)); parseErr == nil && parsed > 0 {
			settings.RetentionDays = parsed
		}
	}
	if v, ok := raw[SettingMaxItems]; ok {
		if parsed, parseErr := strconv.Atoi(strings.TrimSpace(v)); parseErr == nil && parsed > 0 {
			settings.MaxItems = parsed
		}
	}
	if v, ok := raw[SettingMaxItemBytes]; ok {
		if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(v), 10, 64); parseErr == nil && parsed > 0 {
			settings.MaxItemBytes = parsed
		}
	}
	return settings, nil
}

// UpdateSettings validates and persists partial settings updates.
func (s *Service) UpdateSettings(ctx context.Context, patch SettingsPatch) (Settings, error) {
	nowMs := s.clock().UnixMilli()
	if patch.RetentionDays != nil {
		if *patch.RetentionDays < 1 || *patch.RetentionDays > 3650 {
			return Settings{}, fmt.Errorf("%w: retentionDays must be between 1 and 3650", ErrInvalidInput)
		}
		if err := s.store.SetSetting(ctx, SettingRetentionDays, strconv.Itoa(*patch.RetentionDays), nowMs); err != nil {
			return Settings{}, err
		}
	}
	if patch.MaxItems != nil {
		if *patch.MaxItems < 10 || *patch.MaxItems > 50000 {
			return Settings{}, fmt.Errorf("%w: maxItems must be between 10 and 50000", ErrInvalidInput)
		}
		if err := s.store.SetSetting(ctx, SettingMaxItems, strconv.Itoa(*patch.MaxItems), nowMs); err != nil {
			return Settings{}, err
		}
	}
	if patch.MaxItemBytes != nil {
		if *patch.MaxItemBytes < 1024 || *patch.MaxItemBytes > MaxImageBytes {
			return Settings{}, fmt.Errorf("%w: maxItemBytes must be between 1024 and %d", ErrInvalidInput, MaxImageBytes)
		}
		if err := s.store.SetSetting(ctx, SettingMaxItemBytes, strconv.FormatInt(*patch.MaxItemBytes, 10), nowMs); err != nil {
			return Settings{}, err
		}
	}
	if patch.CaptureEnabled != nil {
		if err := s.store.SetSetting(ctx, SettingCaptureEnabled, strconv.FormatBool(*patch.CaptureEnabled), nowMs); err != nil {
			return Settings{}, err
		}
	}
	if patch.SyncEnabled != nil {
		if err := s.store.SetSetting(ctx, SettingSyncEnabled, strconv.FormatBool(*patch.SyncEnabled), nowMs); err != nil {
			return Settings{}, err
		}
	}
	if patch.SyncTargetProfileID != nil {
		if err := s.store.SetSetting(ctx, SettingSyncTargetProfileID, strings.TrimSpace(*patch.SyncTargetProfileID), nowMs); err != nil {
			return Settings{}, err
		}
	}
	return s.GetSettings(ctx)
}

// Status returns the consolidated clipboard status view.
func (s *Service) Status(ctx context.Context) (Status, error) {
	device, err := s.EnsureDevice(ctx)
	if err != nil {
		return Status{}, err
	}
	settings, err := s.GetSettings(ctx)
	if err != nil {
		return Status{}, err
	}
	total, pinned, err := s.store.CountItems(ctx)
	if err != nil {
		return Status{}, err
	}
	devices, err := s.store.ListDevices(ctx)
	if err != nil {
		return Status{}, err
	}

	fingerprint := ""
	if keyRaw, found, keyErr := s.store.GetSetting(ctx, SettingSyncKey); keyErr == nil && found && strings.TrimSpace(keyRaw) != "" {
		if decoded, decErr := base64.StdEncoding.DecodeString(strings.TrimSpace(keyRaw)); decErr == nil && len(decoded) > 0 {
			sum := sha256.Sum256(decoded)
			fingerprint = hex.EncodeToString(sum[:8])
		}
	}

	captureStatus := CaptureStatus{
		Enabled:   settings.CaptureEnabled,
		Supported: false,
		Running:   false,
	}
	syncStatus := SyncStatus{
		Enabled:         settings.SyncEnabled,
		TargetProfileID: settings.SyncTargetProfileID,
	}
	if v, ok, _ := s.store.GetSyncState(ctx, "lastSyncAtMs"); ok {
		if ms, parseErr := strconv.ParseInt(strings.TrimSpace(v), 10, 64); parseErr == nil {
			syncStatus.LastSyncAtMs = ms
		}
	}
	if v, ok, _ := s.store.GetSyncState(ctx, "lastError"); ok {
		syncStatus.LastError = strings.TrimSpace(v)
	}
	transports := []TransportStatus{}
	if s.probe != nil {
		captureStatus = s.probe.CaptureStatus()
		captureStatus.Enabled = settings.CaptureEnabled
		liveSync := s.probe.SyncStatus()
		if liveSync.LastSyncAtMs > syncStatus.LastSyncAtMs {
			syncStatus.LastSyncAtMs = liveSync.LastSyncAtMs
		}
		if liveSync.LastError != "" {
			syncStatus.LastError = liveSync.LastError
		}
		if t := s.probe.Transports(); t != nil {
			transports = t
		}
	}

	return Status{
		Platform:       s.platform,
		Capture:        captureStatus,
		Sync:           syncStatus,
		DeviceID:       device.ID,
		DeviceName:     device.Name,
		KeyFingerprint: fingerprint,
		Transports:     transports,
		ItemCount:      total,
		PinnedCount:    pinned,
		Devices:        devices,
	}, nil
}

// ThumbnailDataURL encodes raw thumbnail bytes into a data URL for list/detail responses.
func ThumbnailDataURL(thumbnail []byte) string {
	if len(thumbnail) == 0 {
		return ""
	}
	mime := detectImageMIME(thumbnail)
	return "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(thumbnail)
}

// SyncKeyFingerprint returns the lowercase hex of the first 8 bytes of SHA-256(key).
func SyncKeyFingerprint(key []byte) string {
	if len(key) == 0 {
		return ""
	}
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:8])
}

// GetSyncKey retrieves the persisted 32-byte sync key if configured.
func (s *Service) GetSyncKey(ctx context.Context) ([]byte, string, bool, error) {
	raw, found, err := s.store.GetSetting(ctx, SettingSyncKey)
	if err != nil {
		return nil, "", false, err
	}
	trimmed := strings.TrimSpace(raw)
	if !found || trimmed == "" {
		return nil, "", false, nil
	}
	key, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(key) != SyncKeyBytes {
		return nil, "", false, ErrInvalidSyncKey
	}
	return key, SyncKeyFingerprint(key), true, nil
}

// EnsureSyncKey returns the existing 32-byte sync key or generates and stores one atomically.
func (s *Service) EnsureSyncKey(ctx context.Context) ([]byte, string, error) {
	key, fp, found, err := s.GetSyncKey(ctx)
	if err != nil {
		return nil, "", err
	}
	if found {
		return key, fp, nil
	}
	generated := make([]byte, SyncKeyBytes)
	if _, err := rand.Read(generated); err != nil {
		return nil, "", fmt.Errorf("generate sync key: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(generated)
	persistedEncoded, err := s.store.SetSettingIfAbsent(ctx, SettingSyncKey, encoded, s.clock().UnixMilli())
	if err != nil {
		return nil, "", err
	}
	persisted, err := base64.StdEncoding.DecodeString(strings.TrimSpace(persistedEncoded))
	if err != nil || len(persisted) != SyncKeyBytes {
		return nil, "", ErrInvalidSyncKey
	}
	return persisted, SyncKeyFingerprint(persisted), nil
}

// SetSyncKeyIfAbsent stores key when absent; returns nil error if stored or equal,
// or ErrSyncKeyConflict alongside the existing key and fingerprint when a different key exists.
func (s *Service) SetSyncKeyIfAbsent(ctx context.Context, key []byte) ([]byte, string, error) {
	if len(key) != SyncKeyBytes {
		return nil, "", ErrInvalidSyncKey
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	persistedEncoded, err := s.store.SetSettingIfAbsent(ctx, SettingSyncKey, encoded, s.clock().UnixMilli())
	if err != nil {
		return nil, "", err
	}
	persisted, err := base64.StdEncoding.DecodeString(strings.TrimSpace(persistedEncoded))
	if err != nil || len(persisted) != SyncKeyBytes {
		return nil, "", ErrInvalidSyncKey
	}
	fp := SyncKeyFingerprint(persisted)
	if subtle.ConstantTimeCompare(persisted, key) != 1 {
		return persisted, fp, ErrSyncKeyConflict
	}
	return persisted, fp, nil
}

// AdoptSyncKey replaces the local sync key with key and returns its fingerprint.
func (s *Service) AdoptSyncKey(ctx context.Context, key []byte) (string, error) {
	if len(key) != SyncKeyBytes {
		return "", ErrInvalidSyncKey
	}
	encoded := base64.StdEncoding.EncodeToString(key)
	if err := s.store.SetSetting(ctx, SettingSyncKey, encoded, s.clock().UnixMilli()); err != nil {
		return "", err
	}
	return SyncKeyFingerprint(key), nil
}

// ListUnsynced returns active items not yet synced, oldest first.
func (s *Service) ListUnsynced(ctx context.Context, limit int) ([]Item, error) {
	if limit <= 0 || limit > SyncBatchMaxItems {
		limit = SyncBatchMaxItems
	}
	return s.store.ListUnsyncedItems(ctx, limit)
}

// MarkSynced records synced_at_ms on unsynced items.
func (s *Service) MarkSynced(ctx context.Context, ids []string, atMs int64) error {
	if len(ids) == 0 {
		return nil
	}
	if atMs <= 0 {
		atMs = s.clock().UnixMilli()
	}
	return s.store.MarkItemsSynced(ctx, ids, atMs)
}

// ItemsSince returns active full items with last_seen_at_ms > sinceMs, oldest first.
func (s *Service) ItemsSince(ctx context.Context, sinceMs int64, limit int) ([]Item, error) {
	if limit <= 0 || limit > SyncBatchMaxItems {
		limit = SyncBatchMaxItems
	}
	return s.store.ListItemsSince(ctx, sinceMs, limit)
}

// ReadContentForItem loads raw payload bytes for an item.
func (s *Service) ReadContentForItem(ctx context.Context, item Item) (Content, error) {
	return s.ReadContent(ctx, item)
}

// GetSyncState reads a value from clipboard_sync_state.
func (s *Service) GetSyncState(ctx context.Context, key string) (string, bool, error) {
	return s.store.GetSyncState(ctx, key)
}

// SetSyncState writes a value into clipboard_sync_state.
func (s *Service) SetSyncState(ctx context.Context, key string, value string) error {
	return s.store.SetSyncState(ctx, key, value, s.clock().UnixMilli())
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func minInt64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func normalizeFilePaths(files []string) ([]string, error) {
	seen := make(map[string]struct{}, len(files))
	out := make([]string, 0, len(files))
	for _, raw := range files {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			return nil, fmt.Errorf("%w: invalid file path %q: %v", ErrInvalidInput, trimmed, err)
		}
		abs = filepath.Clean(abs)
		if _, dup := seen[abs]; dup {
			continue
		}
		seen[abs] = struct{}{}
		out = append(out, abs)
	}
	sort.Strings(out)
	return out, nil
}

func deriveTextKind(explicit Kind, lowerMIME string, text string) Kind {
	if explicit == KindLink {
		return KindLink
	}
	if strings.HasPrefix(lowerMIME, "text/uri-list") {
		return KindLink
	}
	if explicit == "" || explicit == KindText {
		if isSingleLineHTTPURL(text) {
			return KindLink
		}
	}
	return KindText
}

func isSingleLineHTTPURL(text string) bool {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || strings.ContainsAny(trimmed, "\r\n\t ") {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	return (scheme == "http" || scheme == "https") && parsed.Host != ""
}

func detectImageMIME(data []byte) string {
	if len(data) >= 8 &&
		data[0] == 0x89 && data[1] == 0x50 && data[2] == 0x4e && data[3] == 0x47 &&
		data[4] == 0x0d && data[5] == 0x0a && data[6] == 0x1a && data[7] == 0x0a {
		return "image/png"
	}
	if len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff {
		return "image/jpeg"
	}
	if len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP" {
		return "image/webp"
	}
	if len(data) >= 6 && (string(data[0:6]) == "GIF87a" || string(data[0:6]) == "GIF89a") {
		return "image/gif"
	}
	detected := http.DetectContentType(data)
	if strings.HasPrefix(detected, "image/") {
		return detected
	}
	return "image/png"
}

func buildTextPreview(text string, maxRunes int) string {
	var b strings.Builder
	b.Grow(minInt(len(text), maxRunes*2))
	prevSpace := true
	count := 0
	for _, r := range text {
		if unicode.IsSpace(r) {
			if !prevSpace && count < maxRunes {
				b.WriteByte(' ')
				count++
			}
			prevSpace = true
			continue
		}
		prevSpace = false
		if count >= maxRunes {
			break
		}
		b.WriteRune(r)
		count++
	}
	return strings.TrimSpace(b.String())
}

func buildFilePreview(files []string) string {
	if len(files) == 0 {
		return ""
	}
	first := filepath.Base(files[0])
	if len(files) == 1 {
		return buildTextPreview(first, MaxPreviewRunes)
	}
	return buildTextPreview(fmt.Sprintf("%s (+%d files)", first, len(files)-1), MaxPreviewRunes)
}

func buildImagePreview(mime string, width, height int, byteSize int64) string {
	format := strings.ToUpper(strings.TrimPrefix(strings.ToLower(mime), "image/"))
	if format == "" {
		format = "IMAGE"
	}
	sizeLabel := formatByteSize(byteSize)
	if width > 0 && height > 0 {
		return fmt.Sprintf("Image %dx%d (%s, %s)", width, height, format, sizeLabel)
	}
	return fmt.Sprintf("Image (%s, %s)", format, sizeLabel)
}

func formatByteSize(n int64) string {
	switch {
	case n >= 1024*1024:
		return fmt.Sprintf("%.1f MiB", float64(n)/(1024*1024))
	case n >= 1024:
		return fmt.Sprintf("%.1f KiB", float64(n)/1024)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
