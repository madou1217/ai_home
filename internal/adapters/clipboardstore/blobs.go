package clipboardstore

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const blobRelativePrefix = "clipboard/blobs/"

var errInvalidBlobPath = errors.New("clipboard_invalid_blob_path")

// BlobStore persists binary/large clipboard payloads under <aiHome>/clipboard/blobs/<sha256>.
type BlobStore struct {
	aiHomeDir string
	blobsDir  string
}

// NewBlobStore creates a BlobStore rooted at aiHomeDir.
func NewBlobStore(aiHomeDir string) (*BlobStore, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("clipboard_blob_home_required")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("解析 AIH 目录失败: %w", err)
	}
	return &BlobStore{
		aiHomeDir: absRoot,
		blobsDir:  filepath.Join(absRoot, "clipboard", "blobs"),
	}, nil
}

// Write stores data at clipboard/blobs/<sha256Hex> with mode 0600 and returns the relative path.
func (b *BlobStore) Write(sha256Hex string, data []byte) (string, error) {
	hexName := strings.ToLower(strings.TrimSpace(sha256Hex))
	if !isValidSHA256Hex(hexName) {
		return "", fmt.Errorf("%w: invalid sha256", errInvalidBlobPath)
	}
	if err := os.MkdirAll(b.blobsDir, 0o700); err != nil {
		return "", fmt.Errorf("创建剪贴板 blob 目录失败: %w", err)
	}
	relPath := blobRelativePrefix + hexName
	targetPath := filepath.Join(b.blobsDir, hexName)
	if info, err := os.Stat(targetPath); err == nil && !info.IsDir() && info.Size() == int64(len(data)) {
		return relPath, nil
	}
	tmp, err := os.CreateTemp(b.blobsDir, ".tmp-"+hexName+"-*")
	if err != nil {
		return "", fmt.Errorf("创建剪贴板临时 blob 文件失败: %w", err)
	}
	tmpName := tmp.Name()
	success := false
	defer func() {
		if !success {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return "", fmt.Errorf("设置剪贴板 blob 权限失败: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		return "", fmt.Errorf("写入剪贴板 blob 失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("关闭剪贴板 blob 失败: %w", err)
	}
	if err := os.Rename(tmpName, targetPath); err != nil {
		return "", fmt.Errorf("提交剪贴板 blob 失败: %w", err)
	}
	success = true
	return relPath, nil
}

// ResolvePath validates a relative blob path and returns its absolute on-disk path.
func (b *BlobStore) ResolvePath(relativePath string) (string, error) {
	normalized := strings.ReplaceAll(strings.TrimSpace(relativePath), `\`, "/")
	if normalized == "" || strings.HasPrefix(normalized, "/") || strings.Contains(normalized, "..") {
		return "", errInvalidBlobPath
	}
	cleaned := path.Clean(normalized)
	if !strings.HasPrefix(cleaned, blobRelativePrefix) {
		return "", errInvalidBlobPath
	}
	name := strings.TrimPrefix(cleaned, blobRelativePrefix)
	if strings.Contains(name, "/") || !isValidSHA256Hex(name) {
		return "", errInvalidBlobPath
	}
	absPath := filepath.Join(b.blobsDir, name)
	relCheck, err := filepath.Rel(b.blobsDir, absPath)
	if err != nil || relCheck != name {
		return "", errInvalidBlobPath
	}
	return absPath, nil
}

// Read returns the raw bytes of a stored blob.
func (b *BlobStore) Read(relativePath string) ([]byte, error) {
	absPath, err := b.ResolvePath(relativePath)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(absPath)
}

// Delete removes a blob file; missing files are ignored.
func (b *BlobStore) Delete(relativePath string) error {
	absPath, err := b.ResolvePath(relativePath)
	if err != nil {
		return err
	}
	if err := os.Remove(absPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func isValidSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}
