// Package filehash computes content fingerprints for clipboard file packages.
// It uses BLAKE3 (vendored under third_party/blake3) and a small on-disk cache
// keyed by path, size and modification time, so repeated copies of the same
// files do not read them again.
package filehash

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/zeebo/blake3"
)

const cacheEntryLimit = 50000

type cacheEntry struct {
	Size    int64  `json:"size"`
	ModNano int64  `json:"modNano"`
	Hash    string `json:"hash"`
}

// Cache stores content hashes on disk. A nil cache is valid and disables
// persistence.
type Cache struct {
	path    string
	mu      sync.Mutex
	entries map[string]cacheEntry
}

// NewCache loads an existing cache. A missing or corrupt file starts empty.
func NewCache(path string) *Cache {
	cache := &Cache{path: strings.TrimSpace(path), entries: make(map[string]cacheEntry)}
	if cache.path == "" {
		return cache
	}
	raw, err := os.ReadFile(cache.path)
	if err == nil {
		_ = json.Unmarshal(raw, &cache.entries)
		if cache.entries == nil {
			cache.entries = make(map[string]cacheEntry)
		}
	}
	return cache
}

// Hash returns the BLAKE3 hash of one file, reusing the cached digest when the
// file's size and modification time are unchanged.
func (c *Cache) Hash(ctx context.Context, path string) (string, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", err
	}
	if c != nil {
		c.mu.Lock()
		entry, ok := c.entries[path]
		c.mu.Unlock()
		if ok && entry.Size == info.Size() && entry.ModNano == info.ModTime().UnixNano() {
			return entry.Hash, nil
		}
	}
	hash, err := hashFile(ctx, path)
	if err != nil {
		return "", err
	}
	after, err := os.Stat(path)
	if err == nil && (after.Size() != info.Size() || after.ModTime().UnixNano() != info.ModTime().UnixNano()) {
		hash, err = hashFile(ctx, path)
		if err != nil {
			return "", err
		}
		info = after
	}
	if c != nil {
		c.mu.Lock()
		if len(c.entries) >= cacheEntryLimit {
			c.entries = make(map[string]cacheEntry)
		}
		c.entries[path] = cacheEntry{Size: info.Size(), ModNano: info.ModTime().UnixNano(), Hash: hash}
		c.mu.Unlock()
	}
	return hash, nil
}

// Save persists the cache atomically. It is a no-op without a cache path.
func (c *Cache) Save() error {
	if c == nil || c.path == "" {
		return nil
	}
	c.mu.Lock()
	raw, err := json.Marshal(c.entries)
	c.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(c.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(c.path), ".filehash-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, c.path)
}

// HashPaths hashes files in parallel while preserving input order. Unreadable
// files produce an empty hash rather than failing the whole package.
func HashPaths(ctx context.Context, cache *Cache, paths []string, workers int) []string {
	hashes := make([]string, len(paths))
	if len(paths) == 0 {
		return hashes
	}
	if workers < 1 {
		workers = runtime.NumCPU()
	}
	if workers > 8 {
		workers = 8
	}
	if workers > len(paths) {
		workers = len(paths)
	}
	type result struct {
		index int
		hash  string
	}
	jobs := make(chan int)
	results := make(chan result, len(paths))
	var group sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				hash, err := hashOne(ctx, cache, paths[index])
				if err != nil {
					hash = ""
				}
				results <- result{index: index, hash: hash}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for index := range paths {
			select {
			case <-ctx.Done():
				return
			case jobs <- index:
			}
		}
	}()
	group.Wait()
	close(results)
	for item := range results {
		hashes[item.index] = item.hash
	}
	if cache != nil {
		_ = cache.Save()
	}
	return hashes
}

func hashOne(ctx context.Context, cache *Cache, path string) (string, error) {
	if cache != nil {
		return cache.Hash(ctx, path)
	}
	return hashFile(ctx, path)
}

func hashFile(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	hasher := blake3.New()
	buffer := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		n, readErr := file.Read(buffer)
		if n > 0 {
			_, _ = hasher.Write(buffer[:n])
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
	}
	sum := hasher.Sum(nil)
	return hexString(sum), nil
}

func hexString(value []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(value)*2)
	for i, b := range value {
		out[i*2] = digits[b>>4]
		out[i*2+1] = digits[b&0x0f]
	}
	return string(out)
}

// SortNames returns lower-case base names in stable sorted order.
func SortNames(files []string) []string {
	names := make([]string, 0, len(files))
	for _, file := range files {
		name := strings.ToLower(strings.TrimSpace(filepath.Base(strings.TrimSpace(file))))
		if name != "" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// Blake3Hex returns the BLAKE3 digest of in-memory bytes.
func Blake3Hex(data []byte) string {
	sum := blake3.Sum256(data)
	return hexString(sum[:])
}
