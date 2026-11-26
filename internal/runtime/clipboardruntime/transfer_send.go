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
	"os"
	"sync"

	"github.com/madou1217/ai_home/application/clipboard"
)

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
		if err := s.sendChunkedTransfer(ctx, endpoint, managementKey, keyCopy, itemSHA, files); err != nil {
			log.Printf("[clipboard-transfer] sha=%s failed: %v", itemSHA[:12], err)
			return
		}
		log.Printf("[clipboard-transfer] sha=%s complete", itemSHA[:12])
	}()
}

func (s *Syncer) sendChunkedTransfer(ctx context.Context, endpoint, managementKey string, key []byte, itemSHA string, files []string) error {
	archivePath, total, archiveSHA, err := BuildFileArchiveFile(files)
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(archivePath) }()
	if total <= 0 || !isSHA256(archiveSHA) {
		return clipboard.ErrEmptyContent
	}
	chunkBytes := int64(TransferChunkBytes)
	chunkCount := int((total + chunkBytes - 1) / chunkBytes)
	if chunkCount < 1 || chunkCount > TransferMaxChunks {
		return clipboard.ErrItemTooLarge
	}
	transferHash := sha256.Sum256([]byte(itemSHA + "|" + archiveSHA))
	transferID := hex.EncodeToString(transferHash[:])
	lanes := s.transferLanes
	if lanes < 1 {
		lanes = TransferDefaultLanes
	}
	if lanes > chunkCount {
		lanes = chunkCount
	}
	log.Printf("[clipboard-transfer] sha=%s start bytes=%d chunks=%d lanes=%d", itemSHA[:12], total, chunkCount, lanes)

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
			buffer := make([]byte, chunkBytes)
			for index := range indexes {
				if err := s.bulkGate.Wait(ctx); err != nil {
					return
				}
				offset := int64(index) * chunkBytes
				length := chunkBytes
				if remaining := total - offset; remaining < length {
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
					TotalBytes: total,
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
				if postErr := s.postTransferChunk(ctx, endpoint, managementKey, meta); postErr != nil {
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

func (s *Syncer) postTransferChunk(ctx context.Context, endpoint, managementKey string, chunk TransferChunk) error {
	raw, err := json.Marshal(chunk)
	if err != nil {
		return err
	}
	if len(raw) > TransferMaxChunkBytes*2 {
		return clipboard.ErrItemTooLarge
	}
	url := endpoint + syncPathPrefix + "/sync/transfers"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+managementKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("transfer chunk %d/%d failed: HTTP %d", chunk.ChunkIndex, chunk.ChunkCount, resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return nil
}
