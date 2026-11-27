package clipboardruntime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/application/clipboard"
)

func (s *Syncer) applyTransferSettings(settings clipboard.Settings) {
	if s == nil {
		return
	}
	lanes := settings.TransferLanes
	if lanes < 1 || lanes > 16 {
		lanes = transferLanesFromEnv()
	}
	chunkBytes := settings.TransferChunkBytes
	if chunkBytes < 256*1024 || chunkBytes > TransferMaxChunkBytes {
		chunkBytes = int64(transferChunkBytesFromEnv())
	}
	endpoints := append([]string(nil), settings.TransferEndpoints...)
	s.transferMu.Lock()
	s.transferLanes = lanes
	s.transferChunkBytes = int(chunkBytes)
	s.transferEndpoints = endpoints
	s.transferMu.Unlock()
	s.laneLimiter.SetCapacity(lanes)
}

// startChunkedTransfer runs a file package outside the 5s sync pass so large
// packages do not block metadata. The same item SHA is never sent twice at once.
func (s *Syncer) startChunkedTransfer(endpoint, managementKey string, key []byte, item clipboard.Item) {
	if s == nil || s.Service == nil || len(key) != clipboard.SyncKeyBytes || !isSHA256(item.SHA256) {
		return
	}
	itemSHA := item.SHA256
	s.transferMu.Lock()
	if s.activeTransfers == nil {
		s.activeTransfers = make(map[string]struct{})
	}
	if _, running := s.activeTransfers[itemSHA]; running {
		s.transferMu.Unlock()
		return
	}
	lanes := s.transferLanes
	chunkBytes := s.transferChunkBytes
	configuredEndpoints := append([]string(nil), s.transferEndpoints...)
	s.activeTransfers[itemSHA] = struct{}{}
	s.transferMu.Unlock()

	keyCopy := append([]byte(nil), key...)
	files := append([]string(nil), item.Files...)
	go func() {
		defer func() {
			s.transferMu.Lock()
			delete(s.activeTransfers, itemSHA)
			s.transferMu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), transferMaxDuration)
		defer cancel()
		if err := s.sendChunkedTransfer(ctx, endpoint, managementKey, keyCopy, itemSHA, files, lanes, chunkBytes, configuredEndpoints); err != nil {
			log.Printf("[clipboard-transfer] sha=%s failed: %v", itemSHA[:12], err)
			return
		}
		log.Printf("[clipboard-transfer] sha=%s complete", itemSHA[:12])
	}()
}

func (s *Syncer) sendChunkedTransfer(ctx context.Context, endpoint, managementKey string, key []byte, itemSHA string, files []string, lanes, chunkBytes int, configuredEndpoints []string) error {
	archivePath, payloadBytes, archiveSHA, err := BuildFileArchiveFile(files)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(archivePath) }()
	archiveInfo, statErr := os.Stat(archivePath)
	if statErr != nil || archiveInfo.Size() <= 0 || !isSHA256(archiveSHA) {
		return clipboard.ErrEmptyContent
	}
	archiveBytes := archiveInfo.Size()
	if archiveBytes > TransferMaxPackageBytes {
		return clipboard.ErrItemTooLarge
	}
	if chunkBytes < 256*1024 {
		chunkBytes = transferChunkBytesFromEnv()
	}
	chunkSize := int64(chunkBytes)
	chunkCount := int((archiveBytes + chunkSize - 1) / chunkSize)
	if chunkCount < 1 || chunkCount > TransferMaxChunks {
		return clipboard.ErrItemTooLarge
	}
	transferHash := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%d", itemSHA, archiveSHA, archiveBytes)))
	transferID := hex.EncodeToString(transferHash[:])
	if lanes < 1 {
		lanes = TransferDefaultLanes
	}
	endpoints := transferEndpoints(endpoint, configuredEndpoints)
	if lanes > chunkCount {
		lanes = chunkCount
	}
	log.Printf("[clipboard-transfer] sha=%s start payload=%d archive=%d chunks=%d lanes=%d endpoints=%d", itemSHA[:12], payloadBytes, archiveBytes, chunkCount, lanes, len(endpoints))

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	indexes := make(chan int)
	errCh := make(chan error, 1)
	var workers sync.WaitGroup
	for lane := 0; lane < lanes; lane++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			file, openErr := os.Open(archivePath)
			if openErr != nil {
				select {
				case errCh <- openErr:
				default:
				}
				cancel()
				return
			}
			defer func() { _ = file.Close() }()
			buffer := make([]byte, chunkSize)
			for index := range indexes {
				if err := s.bulkGate.Wait(ctx); err != nil {
					return
				}
				offset := int64(index) * chunkSize
				length := chunkSize
				if remaining := archiveBytes - offset; remaining < length {
					length = remaining
				}
				if length <= 0 {
					continue
				}
				data := buffer[:length]
				if _, readErr := file.ReadAt(data, offset); readErr != nil && readErr != io.EOF {
					select {
					case errCh <- readErr:
					default:
					}
					cancel()
					return
				}
				meta := TransferChunk{
					TransferID: transferID,
					ItemSHA:    itemSHA,
					ArchiveSHA: archiveSHA,
					ChunkIndex: index,
					ChunkCount: chunkCount,
					TotalBytes: archiveBytes,
				}
				sealed, sealErr := SealTransferChunk(key, meta, data)
				if sealErr != nil {
					select {
					case errCh <- sealErr:
					default:
					}
					cancel()
					return
				}
				meta.Sealed = sealed
				if err := s.laneLimiter.Acquire(ctx); err != nil {
					return
				}
				postErr := s.postTransferChunk(ctx, endpoints[index%len(endpoints)], endpoints, managementKey, meta)
				s.laneLimiter.Release()
				if postErr != nil {
					select {
					case errCh <- postErr:
					default:
					}
					cancel()
					return
				}
			}
		}()
	}
	for index := 0; index < chunkCount; index++ {
		select {
		case <-ctx.Done():
			close(indexes)
			workers.Wait()
			return ctx.Err()
		case indexes <- index:
		}
	}
	close(indexes)
	workers.Wait()
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

func (s *Syncer) postTransferChunk(ctx context.Context, preferred string, endpoints []string, managementKey string, chunk TransferChunk) error {
	raw, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	if len(raw) > TransferMaxChunkBytes*2 {
		return clipboard.ErrItemTooLarge
	}
	attempts := []string{preferred}
	for _, candidate := range endpoints {
		if candidate != preferred {
			attempts = append(attempts, candidate)
		}
	}
	var lastErr error
	for _, endpoint := range attempts {
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, endpoint+syncPathPrefix+"/sync/transfers", bytes.NewReader(raw))
		if reqErr != nil {
			lastErr = reqErr
			continue
		}
		req.Header.Set("Authorization", "Bearer "+managementKey)
		req.Header.Set("Content-Type", "application/json")
		resp, doErr := s.HTTPClient.Do(req)
		if doErr != nil {
			lastErr = doErr
			continue
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusAccepted {
			return nil
		}
		lastErr = fmt.Errorf("transfer chunk %d/%d failed: HTTP %d %s", chunk.ChunkIndex, chunk.ChunkCount, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("transfer chunk %d/%d failed", chunk.ChunkIndex, chunk.ChunkCount)
	}
	return lastErr
}

// transferEndpoints merges the configured profile endpoint with optional
// additional paths to the same server (SSH/frp/P2P/WireGuard/Tailscale/LAN).
// Set AIH_CLIPBOARD_TRANSFER_ENDPOINTS to a comma-separated list.
func transferEndpoints(primary string, configured []string) []string {
	primary = strings.TrimRight(strings.TrimSpace(primary), "/")
	result := make([]string, 0, 4)
	seen := map[string]struct{}{}
	appendEndpoint := func(raw string) {
		candidate := strings.TrimRight(strings.TrimSpace(raw), "/")
		if candidate == "" {
			return
		}
		parsed, err := url.Parse(candidate)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return
		}
		if _, exists := seen[candidate]; exists {
			return
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	appendEndpoint(primary)
	if len(configured) > 0 {
		for _, raw := range configured {
			appendEndpoint(raw)
		}
	} else {
		for _, raw := range strings.Split(os.Getenv("AIH_CLIPBOARD_TRANSFER_ENDPOINTS"), ",") {
			appendEndpoint(raw)
		}
	}
	if len(result) == 0 && primary != "" {
		result = append(result, primary)
	}
	return result
}

func transferChunkBytesFromEnv() int {
	raw := strings.TrimSpace(os.Getenv("AIH_CLIPBOARD_TRANSFER_CHUNK_BYTES"))
	if raw == "" {
		return TransferChunkBytes
	}
	size, err := strconv.Atoi(raw)
	if err != nil || size < 256*1024 {
		return TransferChunkBytes
	}
	if size > TransferMaxChunkBytes {
		size = TransferMaxChunkBytes
	}
	return size
}
