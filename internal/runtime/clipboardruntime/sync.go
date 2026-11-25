package clipboardruntime

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/madou1217/ai_home/application/clipboard"
)

const (
	syncNonceBytes          = 12
	syncInterval            = 5 * time.Second
	syncClientBatchMaxBytes = 6 * 1024 * 1024  // client splits push batches at 6 MiB accumulated
	syncWireMaxBytes        = 12 * 1024 * 1024 // server request/response hard ceiling
	syncMaxRoundsPerPass    = 20
	syncHTTPTimeout         = 30 * time.Second
	syncStateLastSyncAtMs   = "lastSyncAtMs"
	syncStateLastError      = "lastError"
	syncPathPrefix          = "/v1/management/webui/clipboard"
)

var (
	ErrSyncDecryptFailed = errors.New("clipboard_sync_decrypt_failed")
	ErrSyncSHAMismatch   = errors.New("clipboard_sync_sha_mismatch")
	// ErrSyncTextEncoding marks legacy items whose bytes cannot round-trip through JSON.
	ErrSyncTextEncoding = errors.New("clipboard_sync_text_encoding")
)

// SyncPayload is the plaintext JSON encrypted inside SealedSyncItem.Sealed.
type SyncPayload struct {
	OriginID     string         `json:"originId"`
	Kind         clipboard.Kind `json:"kind"`
	MIME         string         `json:"mime"`
	Text         string         `json:"text,omitempty"`
	DataBase64   string         `json:"dataBase64,omitempty"`
	Files        []string       `json:"files,omitempty"`
	Width        int            `json:"width,omitempty"`
	Height       int            `json:"height,omitempty"`
	SourceDevice string         `json:"sourceDevice,omitempty"`
	SourceApp    string         `json:"sourceApp,omitempty"`
	CreatedAtMs  int64          `json:"createdAtMs"`
}

// SealedSyncItem is one AES-256-GCM envelope on the wire: base64(nonce || ciphertext).
type SealedSyncItem struct {
	SHA256 string `json:"sha256"`
	Sealed string `json:"sealed"`
}

// SealSyncPayload encrypts payload with AES-256-GCM using a random 12-byte nonce and AAD=sha256Hex.
func SealSyncPayload(key []byte, sha256Hex string, payload SyncPayload) (SealedSyncItem, error) {
	if len(key) != clipboard.SyncKeyBytes {
		return SealedSyncItem{}, clipboard.ErrInvalidSyncKey
	}
	shaHex := strings.ToLower(strings.TrimSpace(sha256Hex))
	if shaHex == "" {
		return SealedSyncItem{}, clipboard.ErrInvalidInput
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return SealedSyncItem{}, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return SealedSyncItem{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return SealedSyncItem{}, err
	}
	nonce := make([]byte, syncNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return SealedSyncItem{}, err
	}
	// Seal appends ciphertext+tag to dst (nonce), yielding nonce||ciphertext.
	sealedBytes := gcm.Seal(nonce, nonce, plaintext, []byte(shaHex))
	return SealedSyncItem{
		SHA256: shaHex,
		Sealed: base64.StdEncoding.EncodeToString(sealedBytes),
	}, nil
}

// OpenSyncPayload decrypts an AES-256-GCM SealedSyncItem using AAD=item.SHA256.
func OpenSyncPayload(key []byte, item SealedSyncItem) (SyncPayload, error) {
	if len(key) != clipboard.SyncKeyBytes {
		return SyncPayload{}, clipboard.ErrInvalidSyncKey
	}
	shaHex := strings.ToLower(strings.TrimSpace(item.SHA256))
	if shaHex == "" || strings.TrimSpace(item.Sealed) == "" {
		return SyncPayload{}, ErrSyncDecryptFailed
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(item.Sealed))
	if err != nil {
		return SyncPayload{}, ErrSyncDecryptFailed
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return SyncPayload{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return SyncPayload{}, err
	}
	if len(raw) < syncNonceBytes+gcm.Overhead() {
		return SyncPayload{}, ErrSyncDecryptFailed
	}
	nonce := raw[:syncNonceBytes]
	ciphertext := raw[syncNonceBytes:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, []byte(shaHex))
	if err != nil {
		return SyncPayload{}, ErrSyncDecryptFailed
	}
	var payload SyncPayload
	if err := json.Unmarshal(plaintext, &payload); err != nil {
		return SyncPayload{}, ErrSyncDecryptFailed
	}
	return payload, nil
}

// BuildSyncPayload constructs a SyncPayload from a persisted clipboard.Item, reading blobs if needed.
func BuildSyncPayload(ctx context.Context, service *clipboard.Service, item clipboard.Item) (SyncPayload, error) {
	payload := SyncPayload{
		OriginID:     item.ID,
		Kind:         item.Kind,
		MIME:         item.MIME,
		Width:        item.Width,
		Height:       item.Height,
		SourceDevice: item.SourceDevice,
		SourceApp:    item.SourceApp,
		CreatedAtMs:  item.CreatedAtMs,
	}
	switch item.Kind {
	case clipboard.KindFile:
		if len(item.Files) == 0 {
			return SyncPayload{}, clipboard.ErrEmptyContent
		}
		payload.Files = append([]string(nil), item.Files...)
	case clipboard.KindImage:
		content, err := service.ReadContentForItem(ctx, item)
		if err != nil {
			return SyncPayload{}, err
		}
		if len(content.Data) == 0 {
			return SyncPayload{}, clipboard.ErrEmptyContent
		}
		if len(content.Data) > clipboard.MaxImageBytes {
			return SyncPayload{}, clipboard.ErrItemTooLarge
		}
		payload.DataBase64 = base64.StdEncoding.EncodeToString(content.Data)
	default:
		text := item.Text
		if text == "" && item.BlobPath != "" {
			content, err := service.ReadContentForItem(ctx, item)
			if err != nil {
				return SyncPayload{}, err
			}
			if len(content.Data) > clipboard.MaxTextBytes {
				return SyncPayload{}, clipboard.ErrItemTooLarge
			}
			text = string(content.Data)
		}
		if len(text) == 0 {
			return SyncPayload{}, clipboard.ErrEmptyContent
		}
		if len([]byte(text)) > clipboard.MaxTextBytes {
			return SyncPayload{}, clipboard.ErrItemTooLarge
		}
		if !utf8.ValidString(text) {
			// JSON replaces invalid bytes with U+FFFD, so the sealed payload could
			// never satisfy its recorded SHA. Skip instead of pushing a mismatch.
			return SyncPayload{}, ErrSyncTextEncoding
		}
		payload.Text = text
	}
	return payload, nil
}

// VerifyAndDecodePayload verifies the decrypted payload's canonical SHA-256 against expectedSHA
// and converts it into a clipboard.IngestInput ready for Service.Ingest.
func VerifyAndDecodePayload(expectedSHA string, payload SyncPayload, syncedAtMs int64) (clipboard.IngestInput, error) {
	want := strings.ToLower(strings.TrimSpace(expectedSHA))
	if want == "" || !payload.Kind.Valid() {
		return clipboard.IngestInput{}, clipboard.ErrInvalidInput
	}
	input := clipboard.IngestInput{
		Kind:         payload.Kind,
		MIME:         payload.MIME,
		Width:        payload.Width,
		Height:       payload.Height,
		SourceDevice: payload.SourceDevice,
		SourceApp:    payload.SourceApp,
		RemoteID:     payload.OriginID,
		SyncedAtMs:   syncedAtMs,
		ObservedAtMs: payload.CreatedAtMs,
	}
	switch payload.Kind {
	case clipboard.KindFile:
		canonical, normalized, err := canonicalizeFilesForSync(payload.Files)
		if err != nil {
			return clipboard.IngestInput{}, err
		}
		if len(canonical) == 0 {
			return clipboard.IngestInput{}, clipboard.ErrEmptyContent
		}
		if len(canonical) > clipboard.MaxTextBytes {
			return clipboard.IngestInput{}, clipboard.ErrItemTooLarge
		}
		if sha256HexBytes(canonical) != want {
			return clipboard.IngestInput{}, ErrSyncSHAMismatch
		}
		input.Files = normalized
	case clipboard.KindImage:
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(payload.DataBase64))
		if err != nil || len(data) == 0 {
			return clipboard.IngestInput{}, clipboard.ErrEmptyContent
		}
		if len(data) > clipboard.MaxImageBytes {
			return clipboard.IngestInput{}, clipboard.ErrItemTooLarge
		}
		if sha256HexBytes(data) != want {
			return clipboard.IngestInput{}, ErrSyncSHAMismatch
		}
		input.Data = data
	default:
		raw := []byte(payload.Text)
		if len(raw) == 0 {
			return clipboard.IngestInput{}, clipboard.ErrEmptyContent
		}
		if len(raw) > clipboard.MaxTextBytes {
			return clipboard.IngestInput{}, clipboard.ErrItemTooLarge
		}
		if sha256HexBytes(raw) != want {
			return clipboard.IngestInput{}, ErrSyncSHAMismatch
		}
		input.Text = payload.Text
	}
	return input, nil
}

// ProfileResolver resolves a control-plane server profile ID into its base endpoint and management key.
type ProfileResolver func(ctx context.Context, profileID string) (endpoint string, managementKey string, err error)

// Syncer synchronizes clipboard items with a configured remote AIH Server over AES-256-GCM envelopes.
type Syncer struct {
	Service        *clipboard.Service
	ResolveProfile ProfileResolver
	HTTPClient     *http.Client
	Clock          func() time.Time

	syncMu   sync.Mutex
	stateMu  sync.Mutex
	trigger  chan struct{}
	failures int
	nextTry  time.Time
	lastSync int64
	lastErr  string
	targetID string
	enabled  bool
}

// NewSyncer constructs a Syncer with sensible defaults.
func NewSyncer(service *clipboard.Service, resolver ProfileResolver, client *http.Client, clock func() time.Time) *Syncer {
	if client == nil {
		client = &http.Client{Timeout: syncHTTPTimeout}
	}
	if clock == nil {
		clock = time.Now
	}
	return &Syncer{
		Service:        service,
		ResolveProfile: resolver,
		HTTPClient:     client,
		Clock:          clock,
		trigger:        make(chan struct{}, 1),
	}
}

// Trigger requests an immediate background sync pass (non-blocking).
func (s *Syncer) Trigger() {
	if s == nil {
		return
	}
	select {
	case s.trigger <- struct{}{}:
	default:
	}
}

// Status returns the latest observed sync runtime state.
func (s *Syncer) Status() clipboard.SyncStatus {
	if s == nil {
		return clipboard.SyncStatus{}
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return clipboard.SyncStatus{
		Enabled:         s.enabled,
		TargetProfileID: s.targetID,
		LastSyncAtMs:    s.lastSync,
		LastError:       s.lastErr,
	}
}

// Run executes an initial sync check on start, then loops every 5s or on Trigger until ctx is canceled.
func (s *Syncer) Run(ctx context.Context) {
	if s == nil || s.Service == nil || ctx == nil {
		return
	}
	_ = s.SyncOnce(ctx)

	ticker := time.NewTicker(syncInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-s.trigger:
			_ = s.SyncOnce(ctx)
		case <-ticker.C:
			if s.inBackoff() {
				continue
			}
			_ = s.SyncOnce(ctx)
		}
	}
}

// SyncOnce runs one sync pass using persisted settings (no-op when disabled or target empty).
func (s *Syncer) SyncOnce(ctx context.Context) error {
	if s == nil || s.Service == nil {
		return nil
	}
	settings, err := s.Service.GetSettings(ctx)
	if err != nil {
		return err
	}
	target := strings.TrimSpace(settings.SyncTargetProfileID)
	s.stateMu.Lock()
	s.enabled = settings.SyncEnabled
	s.targetID = target
	s.stateMu.Unlock()

	if !settings.SyncEnabled || target == "" {
		return nil
	}
	return s.SyncTarget(ctx, target)
}

// SyncTarget performs one full key-pair + push + pull cycle against profileID, serialized via syncMu.
func (s *Syncer) SyncTarget(ctx context.Context, profileID string) error {
	if s == nil || s.Service == nil || s.ResolveProfile == nil {
		return errors.New("clipboard_syncer_unconfigured")
	}
	profileID = strings.TrimSpace(profileID)
	if profileID == "" {
		return errors.New("clipboard_sync_target_required")
	}

	s.syncMu.Lock()
	defer s.syncMu.Unlock()

	err := s.runSyncLocked(ctx, profileID)
	now := s.Clock()
	if err != nil {
		s.recordFailure(ctx, now, err)
		return err
	}
	s.recordSuccess(ctx, now)
	return nil
}

func (s *Syncer) runSyncLocked(ctx context.Context, profileID string) error {
	endpoint, mgmtKey, err := s.ResolveProfile(ctx, profileID)
	if err != nil {
		return err
	}
	endpoint = strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if endpoint == "" || strings.TrimSpace(mgmtKey) == "" {
		return errors.New("clipboard_sync_profile_incomplete")
	}

	localKey, localFP, err := s.Service.EnsureSyncKey(ctx)
	if err != nil {
		return err
	}
	activeKey, err := s.pairSyncKey(ctx, endpoint, mgmtKey, localKey, localFP)
	if err != nil {
		return err
	}

	if err := s.pushUnsynced(ctx, endpoint, mgmtKey, activeKey); err != nil {
		return err
	}
	if err := s.pullRemote(ctx, endpoint, mgmtKey, profileID, activeKey); err != nil {
		return err
	}
	return nil
}

func (s *Syncer) pairSyncKey(ctx context.Context, endpoint, mgmtKey string, localKey []byte, localFP string) ([]byte, error) {
	keyURL := endpoint + syncPathPrefix + "/sync/key"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, keyURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+mgmtKey)

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()

	switch resp.StatusCode {
	case http.StatusOK:
		var body struct {
			Key         string `json:"key"`
			Fingerprint string `json:"fingerprint"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body); err != nil {
			return nil, fmt.Errorf("decode target sync key: %w", err)
		}
		targetKey, err := decodeSyncKeyBase64(body.Key)
		if err != nil {
			return nil, err
		}
		if subtle.ConstantTimeCompare(targetKey, localKey) != 1 {
			adoptedFP, err := s.Service.AdoptSyncKey(ctx, targetKey)
			if err != nil {
				return nil, err
			}
			log.Printf("[clipboard-sync] adopted target sync key fingerprint=%s (previous=%s)", adoptedFP, localFP)
		}
		return targetKey, nil

	case http.StatusNotFound:
		// Target has no sync key yet: upload local key.
		payloadBytes, err := json.Marshal(map[string]string{
			"key": base64.StdEncoding.EncodeToString(localKey),
		})
		if err != nil {
			return nil, err
		}
		postReq, err := http.NewRequestWithContext(ctx, http.MethodPost, keyURL, bytes.NewReader(payloadBytes))
		if err != nil {
			return nil, err
		}
		postReq.Header.Set("Authorization", "Bearer "+mgmtKey)
		postReq.Header.Set("Content-Type", "application/json")

		postResp, err := s.HTTPClient.Do(postReq)
		if err != nil {
			return nil, err
		}
		defer func() { _ = postResp.Body.Close() }()

		switch postResp.StatusCode {
		case http.StatusOK, http.StatusCreated:
			return localKey, nil
		case http.StatusConflict:
			var conflict struct {
				Key         string `json:"key"`
				Fingerprint string `json:"fingerprint"`
			}
			if err := json.NewDecoder(io.LimitReader(postResp.Body, 4096)).Decode(&conflict); err != nil {
				return nil, fmt.Errorf("decode target sync key conflict: %w", err)
			}
			targetKey, err := decodeSyncKeyBase64(conflict.Key)
			if err != nil {
				return nil, err
			}
			adoptedFP, err := s.Service.AdoptSyncKey(ctx, targetKey)
			if err != nil {
				return nil, err
			}
			log.Printf("[clipboard-sync] sync key conflict; adopted target fingerprint=%s (previous=%s)", adoptedFP, localFP)
			return targetKey, nil
		default:
			return nil, fmt.Errorf("push sync key failed: HTTP %d", postResp.StatusCode)
		}

	default:
		return nil, fmt.Errorf("fetch target sync key failed: HTTP %d", resp.StatusCode)
	}
}

func (s *Syncer) pushUnsynced(ctx context.Context, endpoint, mgmtKey string, key []byte) error {
	itemsURL := endpoint + syncPathPrefix + "/sync/items"
	for round := 0; round < syncMaxRoundsPerPass; round++ {
		unsynced, err := s.Service.ListUnsynced(ctx, clipboard.SyncBatchMaxItems)
		if err != nil {
			return err
		}
		if len(unsynced) == 0 {
			return nil
		}

		type pendingEntry struct {
			id      string
			sealed  SealedSyncItem
			estSize int
		}
		entries := make([]pendingEntry, 0, len(unsynced))
		unbuildableIDs := make([]string, 0)
		for _, item := range unsynced {
			payload, buildErr := BuildSyncPayload(ctx, s.Service, item)
			if buildErr != nil {
				// Item cannot be synced (e.g. >1 MiB text or missing blob); skip without stalling.
				unbuildableIDs = append(unbuildableIDs, item.ID)
				continue
			}
			sealed, sealErr := SealSyncPayload(key, item.SHA256, payload)
			if sealErr != nil {
				return sealErr
			}
			estSize := len(sealed.SHA256) + len(sealed.Sealed) + 40
			if estSize > syncWireMaxBytes-1024 {
				unbuildableIDs = append(unbuildableIDs, item.ID)
				continue
			}
			entries = append(entries, pendingEntry{id: item.ID, sealed: sealed, estSize: estSize})
		}

		nowMs := s.Clock().UnixMilli()
		if len(unbuildableIDs) > 0 {
			_ = s.Service.MarkSynced(ctx, unbuildableIDs, nowMs)
		}

		// Split entries by accumulated 6 MiB and max 50 items per request.
		idx := 0
		for idx < len(entries) {
			batchSealed := make([]SealedSyncItem, 0, clipboard.SyncBatchMaxItems)
			batchIDs := make([]string, 0, clipboard.SyncBatchMaxItems)
			accBytes := 32
			for idx < len(entries) && len(batchSealed) < clipboard.SyncBatchMaxItems {
				e := entries[idx]
				if len(batchSealed) > 0 && accBytes+e.estSize > syncClientBatchMaxBytes {
					break
				}
				batchSealed = append(batchSealed, e.sealed)
				batchIDs = append(batchIDs, e.id)
				accBytes += e.estSize
				idx++
			}
			if err := s.postSyncBatch(ctx, itemsURL, mgmtKey, batchSealed); err != nil {
				return err
			}
			if err := s.Service.MarkSynced(ctx, batchIDs, s.Clock().UnixMilli()); err != nil {
				return err
			}
		}

		if len(unsynced) < clipboard.SyncBatchMaxItems {
			return nil
		}
	}
	return nil
}

// syncResponseError preserves the remote error code/message so sync failures stay
// diagnosable without reading the other server's logs.
func syncResponseError(prefix string, resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	detail := strings.TrimSpace(string(body))
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error.Code != "" {
		detail = payload.Error.Code
		if payload.Error.Message != "" {
			detail += ": " + payload.Error.Message
		}
	}
	if detail == "" {
		return fmt.Errorf("%s: HTTP %d", prefix, resp.StatusCode)
	}
	return fmt.Errorf("%s: HTTP %d %s", prefix, resp.StatusCode, detail)
}

func (s *Syncer) postSyncBatch(ctx context.Context, itemsURL, mgmtKey string, batch []SealedSyncItem) error {
	raw, err := json.Marshal(map[string]any{"items": batch})
	if err != nil {
		return err
	}
	if len(raw) > syncWireMaxBytes {
		return clipboard.ErrItemTooLarge
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, itemsURL, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+mgmtKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return syncResponseError("push sync items failed", resp)
	}
	var out struct {
		IDs map[string]string `json:"ids"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&out); err != nil {
		return fmt.Errorf("decode push sync response: %w", err)
	}
	return nil
}

func (s *Syncer) pullRemote(ctx context.Context, endpoint, mgmtKey, profileID string, key []byte) error {
	cursorKey := "cursor." + profileID
	var sinceMs int64
	if rawCursor, ok, err := s.Service.GetSyncState(ctx, cursorKey); err == nil && ok {
		if parsed, parseErr := strconv.ParseInt(strings.TrimSpace(rawCursor), 10, 64); parseErr == nil && parsed > 0 {
			sinceMs = parsed
		}
	}

	for round := 0; round < syncMaxRoundsPerPass; round++ {
		pullURL := fmt.Sprintf("%s%s/sync/items?since=%d&limit=%d",
			endpoint, syncPathPrefix, sinceMs, clipboard.SyncBatchMaxItems)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, pullURL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+mgmtKey)

		resp, err := s.HTTPClient.Do(req)
		if err != nil {
			return err
		}
		var pulled struct {
			Items  []SealedSyncItem `json:"items"`
			Cursor int64            `json:"cursor"`
		}
		decodeErr := func() error {
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("pull sync items failed: HTTP %d", resp.StatusCode)
			}
			return json.NewDecoder(io.LimitReader(resp.Body, syncWireMaxBytes)).Decode(&pulled)
		}()
		if decodeErr != nil {
			return decodeErr
		}
		if len(pulled.Items) == 0 {
			return nil
		}

		nowMs := s.Clock().UnixMilli()
		for _, sealed := range pulled.Items {
			payload, openErr := OpenSyncPayload(key, sealed)
			if openErr != nil {
				// One corrupt envelope must not block every later item.
				log.Printf("[clipboard-sync] skip unreadable item sha=%s: %v", sealed.SHA256, openErr)
				continue
			}
			input, verifyErr := VerifyAndDecodePayload(sealed.SHA256, payload, nowMs)
			if verifyErr != nil {
				log.Printf("[clipboard-sync] skip mismatched item sha=%s: %v", sealed.SHA256, verifyErr)
				continue
			}
			if _, ingestErr := s.Service.Ingest(ctx, input); ingestErr != nil {
				if errors.Is(ingestErr, clipboard.ErrItemTooLarge) || errors.Is(ingestErr, clipboard.ErrEmptyContent) {
					continue
				}
				return ingestErr
			}
		}

		if pulled.Cursor > sinceMs {
			if err := s.Service.SetSyncState(ctx, cursorKey, strconv.FormatInt(pulled.Cursor, 10)); err != nil {
				return err
			}
			sinceMs = pulled.Cursor
		} else {
			return nil
		}
		if len(pulled.Items) < clipboard.SyncBatchMaxItems {
			return nil
		}
	}
	return nil
}

func (s *Syncer) inBackoff() bool {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if s.nextTry.IsZero() {
		return false
	}
	return s.Clock().Before(s.nextTry)
}

func (s *Syncer) recordSuccess(ctx context.Context, now time.Time) {
	nowMs := now.UnixMilli()
	s.stateMu.Lock()
	s.failures = 0
	s.nextTry = time.Time{}
	s.lastSync = nowMs
	s.lastErr = ""
	s.stateMu.Unlock()

	_ = s.Service.SetSyncState(ctx, syncStateLastSyncAtMs, strconv.FormatInt(nowMs, 10))
	_ = s.Service.SetSyncState(ctx, syncStateLastError, "")
}

func (s *Syncer) recordFailure(ctx context.Context, now time.Time, err error) {
	msg := sanitizeErrorMessage(err)
	s.stateMu.Lock()
	s.failures++
	var backoff time.Duration
	switch s.failures {
	case 1:
		backoff = 5 * time.Second
	case 2:
		backoff = 30 * time.Second
	default:
		backoff = 2 * time.Minute
	}
	s.nextTry = now.Add(backoff)
	s.lastErr = msg
	s.stateMu.Unlock()

	_ = s.Service.SetSyncState(ctx, syncStateLastError, msg)
}

func decodeSyncKeyBase64(raw string) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil || len(key) != clipboard.SyncKeyBytes {
		return nil, clipboard.ErrInvalidSyncKey
	}
	return key, nil
}

func sha256HexBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func canonicalizeFilesForSync(files []string) ([]byte, []string, error) {
	seen := make(map[string]struct{}, len(files))
	out := make([]string, 0, len(files))
	for _, raw := range files {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			return nil, nil, err
		}
		abs = filepath.Clean(abs)
		if _, dup := seen[abs]; dup {
			continue
		}
		seen[abs] = struct{}{}
		out = append(out, abs)
	}
	sort.Strings(out)
	return []byte(strings.Join(out, "\n")), out, nil
}

// sanitizeErrorMessage avoids leaking credentials in URLs or headers into persisted sync state.
func sanitizeErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return fmt.Sprintf("%s: %v", urlErr.Op, urlErr.Err)
	}
	return err.Error()
}
