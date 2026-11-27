package clipboardruntime

import (
	"archive/zip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
)

const (
	// TransferChunkBytes is the plaintext size of one parallel transfer chunk.
	TransferChunkBytes = 2 << 20
	// TransferDefaultLanes is the default number of parallel chunk connections.
	TransferDefaultLanes = 4
	// TransferMaxChunkBytes bounds a single client chunk.
	TransferMaxChunkBytes = 8 << 20
	// TransferMaxChunks bounds one package so corrupt manifests cannot exhaust disk.
	TransferMaxChunks = 4096
	// TransferMaxPackageBytes bounds the assembled archive.
	TransferMaxPackageBytes = 4 << 30
	// TransferThresholdBytes switches file packages to chunked transfer.
	TransferThresholdBytes = 24 << 20
	transferMaxDuration    = 2 * time.Hour
)

// TransferChunk is one AES-GCM sealed slice of a file-package archive.
type TransferChunk struct {
	TransferID string `json:"transferId"`
	ItemSHA    string `json:"itemSha"`
	ArchiveSHA string `json:"archiveSha"`
	ChunkIndex int    `json:"chunkIndex"`
	ChunkCount int    `json:"chunkCount"`
	TotalBytes int64  `json:"totalBytes"`
	Sealed     string `json:"sealed"`
}

func (c TransferChunk) aad() []byte {
	value := fmt.Sprintf("%s|%s|%s|%d|%d|%d", c.TransferID, c.ItemSHA, c.ArchiveSHA, c.ChunkIndex, c.ChunkCount, c.TotalBytes)
	return []byte(value)
}

func (c TransferChunk) validate() error {
	if !validTransferID(c.TransferID) || !isSHA256(c.ItemSHA) || !isSHA256(c.ArchiveSHA) {
		return clipboard.ErrInvalidInput
	}
	if c.ChunkIndex < 0 || c.ChunkCount < 1 || c.ChunkCount > TransferMaxChunks || c.ChunkIndex >= c.ChunkCount {
		return clipboard.ErrInvalidInput
	}
	if c.TotalBytes < 0 || c.TotalBytes > TransferMaxPackageBytes {
		return clipboard.ErrItemTooLarge
	}
	return nil
}

func validTransferID(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) < 16 || len(value) > 96 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func isSHA256(value string) bool {
	v := strings.ToLower(strings.TrimSpace(value))
	if len(v) != 64 {
		return false
	}
	_, err := hex.DecodeString(v)
	return err == nil
}

// SealTransferChunk encrypts one package slice with AAD binding transfer,
// item, archive, index and count.
func SealTransferChunk(key []byte, meta TransferChunk, data []byte) (string, error) {
	if len(key) != clipboard.SyncKeyBytes || meta.validate() != nil || len(data) == 0 {
		return "", clipboard.ErrInvalidInput
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, data, meta.aad())
	return base64.StdEncoding.EncodeToString(sealed), nil
}

// OpenTransferChunk decrypts and authenticates one package slice.
func OpenTransferChunk(key []byte, meta TransferChunk, sealed string) ([]byte, error) {
	if len(key) != clipboard.SyncKeyBytes || meta.validate() != nil || strings.TrimSpace(sealed) == "" {
		return nil, ErrSyncDecryptFailed
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sealed))
	if err != nil {
		return nil, ErrSyncDecryptFailed
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(raw) < 12+gcm.Overhead() {
		return nil, ErrSyncDecryptFailed
	}
	data, err := gcm.Open(nil, raw[:12], raw[12:], meta.aad())
	if err != nil {
		return nil, ErrSyncDecryptFailed
	}
	return data, nil
}

// FilePackageBytes estimates the payload size of a file package.
func FilePackageBytes(files []string) int64 {
	var total int64
	for _, raw := range files {
		info, err := os.Stat(strings.TrimSpace(raw))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		total += info.Size()
	}
	return total
}

// ShouldChunkFilePackage reports whether a package should use parallel chunks.
func ShouldChunkFilePackage(files []string) bool {
	var total int64
	for _, raw := range files {
		info, err := os.Stat(strings.TrimSpace(raw))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		total += info.Size()
		// The single-envelope archive skips members over 16 MiB; even a
		// package below the total threshold must use chunks in that case.
		if info.Size() > 16<<20 {
			return true
		}
	}
	return total > TransferThresholdBytes
}

// BuildFileArchiveFile writes a package zip to a temporary file and returns its
// SHA-256. It streams every file so the archive can be much larger than memory.
func BuildFileArchiveFile(files []string) (archivePath string, total int64, archiveSHA string, err error) {
	file, err := os.CreateTemp("", "aih-clip-archive-*.zip")
	if err != nil {
		return "", 0, "", err
	}
	archivePath = file.Name()
	cleanup := func() {
		_ = file.Close()
		_ = os.Remove(archivePath)
	}
	hasher := sha256.New()
	writer := zip.NewWriter(io.MultiWriter(file, hasher))
	used := make(map[string]struct{}, len(files))
	added := 0
	for _, raw := range files {
		path := strings.TrimSpace(raw)
		if path == "" || clipboard.IsIgnoredClipboardFile(path) {
			continue
		}
		info, statErr := os.Stat(path)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		total += info.Size()
		if total > TransferMaxPackageBytes {
			_ = writer.Close()
			cleanup()
			return "", 0, "", clipboard.ErrItemTooLarge
		}
		name := filepath.Base(path)
		base := name
		for index := 2; ; index++ {
			if _, exists := used[name]; !exists {
				break
			}
			ext := filepath.Ext(base)
			name = fmt.Sprintf("%s-%d%s", strings.TrimSuffix(base, ext), index, ext)
		}
		used[name] = struct{}{}
		entry, createErr := writer.Create(name)
		if createErr != nil {
			_ = writer.Close()
			cleanup()
			return "", 0, "", createErr
		}
		source, openErr := os.Open(path)
		if openErr != nil {
			continue
		}
		_, copyErr := io.Copy(entry, source)
		_ = source.Close()
		if copyErr != nil {
			_ = writer.Close()
			cleanup()
			return "", 0, "", copyErr
		}
		added++
	}
	if added == 0 {
		_ = writer.Close()
		cleanup()
		return "", 0, "", clipboard.ErrEmptyContent
	}
	if err := writer.Close(); err != nil {
		cleanup()
		return "", 0, "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(archivePath)
		return "", 0, "", err
	}
	return archivePath, total, hex.EncodeToString(hasher.Sum(nil)), nil
}

// BulkGate lets interactive metadata/content traffic pause bulk chunk workers.
// In-flight chunks are at most a couple of MiB, so the priority switch is quick.
type BulkGate struct {
	mu       sync.Mutex
	priority int
}

func (g *BulkGate) BeginPriority() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.priority++
	g.mu.Unlock()
}

func (g *BulkGate) EndPriority() {
	if g == nil {
		return
	}
	g.mu.Lock()
	if g.priority > 0 {
		g.priority--
	}
	g.mu.Unlock()
}

func (g *BulkGate) Wait(ctx context.Context) error {
	if g == nil {
		return nil
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		g.mu.Lock()
		active := g.priority > 0
		g.mu.Unlock()
		if !active {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

type transferJob struct {
	dir      string
	meta     TransferChunk
	received map[int]bool
}

// TransferReceiver assembles parallel chunks and atomically upgrades a file
// stub once the whole archive has been authenticated.
type TransferReceiver struct {
	service   *clipboard.Service
	mu        sync.Mutex
	jobs      map[string]*transferJob
	completed map[string]time.Time
}

func NewTransferReceiver(service *clipboard.Service) *TransferReceiver {
	return &TransferReceiver{
		service:   service,
		jobs:      make(map[string]*transferJob),
		completed: make(map[string]time.Time),
	}
}

// Accept stores one chunk and returns true when the package is complete.
func (r *TransferReceiver) Accept(ctx context.Context, meta TransferChunk, sealed string, key []byte) (bool, error) {
	if r == nil || r.service == nil {
		return false, clipboard.ErrInvalidInput
	}
	if err := meta.validate(); err != nil {
		return false, err
	}
	data, err := OpenTransferChunk(key, meta, sealed)
	if err != nil {
		return false, err
	}
	if len(data) == 0 || len(data) > TransferMaxChunkBytes {
		return false, clipboard.ErrItemTooLarge
	}
	transferID := strings.ToLower(strings.TrimSpace(meta.TransferID))

	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	for id, at := range r.completed {
		if now.Sub(at) > 10*time.Minute {
			delete(r.completed, id)
		}
	}
	if _, done := r.completed[transferID]; done {
		return true, nil
	}
	job := r.jobs[transferID]
	if job == nil {
		dir, mkErr := os.MkdirTemp("", "aih-clip-transfer-")
		if mkErr != nil {
			return false, mkErr
		}
		job = &transferJob{dir: dir, meta: meta, received: make(map[int]bool)}
		r.jobs[transferID] = job
	} else if job.meta.ItemSHA != meta.ItemSHA || job.meta.ArchiveSHA != meta.ArchiveSHA ||
		job.meta.ChunkCount != meta.ChunkCount || job.meta.TotalBytes != meta.TotalBytes {
		return false, fmt.Errorf("%w: transfer metadata changed", clipboard.ErrInvalidInput)
	}
	chunkPath := filepath.Join(job.dir, fmt.Sprintf("chunk-%06d", meta.ChunkIndex))
	if err := os.WriteFile(chunkPath, data, 0o600); err != nil {
		return false, err
	}
	job.received[meta.ChunkIndex] = true
	if len(job.received) < job.meta.ChunkCount {
		return false, nil
	}

	archivePath := filepath.Join(job.dir, "archive.zip")
	archive, err := os.OpenFile(archivePath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return false, err
	}
	hasher := sha256.New()
	var written int64
	for index := 0; index < job.meta.ChunkCount; index++ {
		part := filepath.Join(job.dir, fmt.Sprintf("chunk-%06d", index))
		source, openErr := os.Open(part)
		if openErr != nil {
			_ = archive.Close()
			return false, openErr
		}
		copied, copyErr := io.Copy(io.MultiWriter(archive, hasher), source)
		_ = source.Close()
		if copyErr != nil {
			_ = archive.Close()
			return false, copyErr
		}
		written += copied
	}
	if err := archive.Close(); err != nil {
		return false, err
	}
	if written != job.meta.TotalBytes {
		return false, fmt.Errorf("%w: transfer size mismatch", clipboard.ErrInvalidInput)
	}
	if !strings.EqualFold(hex.EncodeToString(hasher.Sum(nil)), job.meta.ArchiveSHA) {
		return false, fmt.Errorf("%w: transfer archive sha mismatch", clipboard.ErrInvalidInput)
	}
	stub, found, err := r.service.GetBySHA(ctx, job.meta.ItemSHA)
	if err != nil {
		return false, err
	}
	if !found {
		return false, clipboard.ErrNotFound
	}
	if _, err := r.service.IngestArchive(ctx, stub, archivePath); err != nil {
		return false, err
	}
	_ = os.RemoveAll(job.dir)
	delete(r.jobs, transferID)
	r.completed[transferID] = now
	return true, nil
}

// transferLanesFromEnv keeps transfer concurrency controllable without a UI:
// AIH_CLIPBOARD_TRANSFER_LANES=1..16, defaulting to four parallel connections.
func transferLanesFromEnv() int {
	raw := strings.TrimSpace(os.Getenv("AIH_CLIPBOARD_TRANSFER_LANES"))
	if raw == "" {
		return TransferDefaultLanes
	}
	lanes, err := strconv.Atoi(raw)
	if err != nil || lanes < 1 {
		return TransferDefaultLanes
	}
	if lanes > 16 {
		lanes = 16
	}
	return lanes
}
