package workspaceconnector

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	maxFileBytes       = 4 * 1024 * 1024
	defaultListLimit   = 200
	maxListLimit       = 1000
	defaultSearchLimit = 200
	maxSearchLimit     = 500
	defaultSearchDepth = 8
	maxSearchDepth     = 16
	maxSearchVisited   = 20000
)

type filesystem struct {
	sandbox *sandbox
}

func newFilesystem(root string) (*filesystem, error) {
	workspace, err := newSandbox(root)
	if err != nil {
		return nil, err
	}
	return &filesystem{sandbox: workspace}, nil
}

func (fs *filesystem) execute(ctx context.Context, operation string, raw json.RawMessage) (any, error) {
	switch operation {
	case remoteconnector.OperationReadFile:
		var request remoteconnector.ReadFileRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return fs.readFile(ctx, request)
	case remoteconnector.OperationWriteFile:
		var request remoteconnector.WriteFileRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return fs.writeFile(ctx, request)
	case remoteconnector.OperationListDirectory:
		var request remoteconnector.ListDirectoryRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return fs.listDirectory(ctx, request)
	case remoteconnector.OperationSearch:
		var request remoteconnector.SearchRequest
		if err := decodePayload(raw, &request); err != nil {
			return nil, err
		}
		return fs.search(ctx, request)
	default:
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeUnsupportedOperation, "operation is not implemented by this connector")
	}
}

func (fs *filesystem) readFile(ctx context.Context, request remoteconnector.ReadFileRequest) (remoteconnector.ReadFileResult, error) {
	if err := contextError(ctx); err != nil {
		return remoteconnector.ReadFileResult{}, err
	}
	target, err := fs.sandbox.resolve(request.Path, false)
	if err != nil {
		return remoteconnector.ReadFileResult{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return remoteconnector.ReadFileResult{}, fileError(err)
	}
	if info.IsDir() {
		return remoteconnector.ReadFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotAFile, "path is a directory")
	}
	if !info.Mode().IsRegular() {
		return remoteconnector.ReadFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotAFile, "path is not a regular file")
	}
	limit := request.MaxBytes
	if limit <= 0 || limit > maxFileBytes {
		limit = maxFileBytes
	}
	if info.Size() > limit {
		return remoteconnector.ReadFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeFileTooLarge, "file is larger than the read limit")
	}
	file, err := os.Open(target)
	if err != nil {
		return remoteconnector.ReadFileResult{}, fileError(err)
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return remoteconnector.ReadFileResult{}, fileError(err)
	}
	if int64(len(content)) > limit {
		return remoteconnector.ReadFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeFileTooLarge, "file is larger than the read limit")
	}
	return remoteconnector.ReadFileResult{
		Path:     displayPath(fs.sandbox.root, target),
		Content:  base64.StdEncoding.EncodeToString(content),
		Encoding: "base64",
		Version:  contentVersion(content),
		Size:     int64(len(content)),
	}, nil
}

func (fs *filesystem) writeFile(ctx context.Context, request remoteconnector.WriteFileRequest) (remoteconnector.WriteFileResult, error) {
	if err := contextError(ctx); err != nil {
		return remoteconnector.WriteFileResult{}, err
	}
	if request.Encoding != "" && !strings.EqualFold(request.Encoding, "base64") {
		return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "write encoding must be base64")
	}
	content, err := base64.StdEncoding.DecodeString(strings.TrimSpace(request.Content))
	if err != nil {
		return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "write content is not valid base64")
	}
	if len(content) > maxFileBytes {
		return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeFileTooLarge, "write content is larger than the file limit")
	}
	target, err := fs.sandbox.resolve(request.Path, true)
	if err != nil {
		return remoteconnector.WriteFileResult{}, err
	}
	if target == fs.sandbox.root {
		return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotAFile, "cannot write the workspace root")
	}
	parent := filepath.Dir(target)
	parentInfo, err := os.Stat(parent)
	if err != nil {
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	if !parentInfo.IsDir() {
		return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotADirectory, "parent path is not a directory")
	}
	mode := os.FileMode(0o644)
	info, statErr := os.Stat(target)
	switch {
	case statErr == nil:
		if info.IsDir() {
			return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotAFile, "path is a directory")
		}
		if !info.Mode().IsRegular() {
			return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotAFile, "path is not a regular file")
		}
		mode = info.Mode().Perm()
		if strings.TrimSpace(request.ExpectedVersion) == "" {
			return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeVersionConflict, "file already exists; expectedVersion is required")
		}
		current, readErr := readBounded(target, maxFileBytes)
		if readErr != nil {
			return remoteconnector.WriteFileResult{}, readErr
		}
		if contentVersion(current) != strings.TrimSpace(request.ExpectedVersion) {
			return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeVersionConflict, "file changed since it was read")
		}
	case errors.Is(statErr, os.ErrNotExist):
		if strings.TrimSpace(request.ExpectedVersion) != "" {
			return remoteconnector.WriteFileResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeVersionConflict, "file does not exist")
		}
	default:
		return remoteconnector.WriteFileResult{}, fileError(statErr)
	}
	if err := contextError(ctx); err != nil {
		return remoteconnector.WriteFileResult{}, err
	}
	temp, err := os.CreateTemp(parent, ".aih-write-*")
	if err != nil {
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	tempName := temp.Name()
	defer func() { _ = os.Remove(tempName) }()
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	if err := temp.Close(); err != nil {
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	if err := os.Chmod(tempName, mode); err != nil {
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	if err := os.Rename(tempName, target); err != nil {
		return remoteconnector.WriteFileResult{}, fileError(err)
	}
	return remoteconnector.WriteFileResult{
		Path: displayPath(fs.sandbox.root, target), Version: contentVersion(content), Size: int64(len(content)),
	}, nil
}

func (fs *filesystem) listDirectory(ctx context.Context, request remoteconnector.ListDirectoryRequest) (remoteconnector.ListDirectoryResult, error) {
	if err := contextError(ctx); err != nil {
		return remoteconnector.ListDirectoryResult{}, err
	}
	target, err := fs.sandbox.resolve(request.Path, false)
	if err != nil {
		return remoteconnector.ListDirectoryResult{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return remoteconnector.ListDirectoryResult{}, fileError(err)
	}
	if !info.IsDir() {
		return remoteconnector.ListDirectoryResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotADirectory, "path is not a directory")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return remoteconnector.ListDirectoryResult{}, fileError(err)
	}
	result := remoteconnector.ListDirectoryResult{
		Path:    displayPath(fs.sandbox.root, target),
		Entries: make([]remoteconnector.DirectoryEntry, 0, min(len(entries), limit)),
	}
	for _, entry := range entries {
		if err := contextError(ctx); err != nil {
			return remoteconnector.ListDirectoryResult{}, err
		}
		if len(result.Entries) >= limit {
			result.Truncated = true
			break
		}
		item := remoteconnector.DirectoryEntry{Name: entry.Name(), Type: "other"}
		if entry.Type()&os.ModeSymlink != 0 {
			item.Type = "symlink"
		} else if entry.IsDir() {
			item.Type = "dir"
		} else {
			fileInfo, infoErr := entry.Info()
			if infoErr != nil {
				continue
			}
			item.Type = "file"
			item.Size = fileInfo.Size()
			item.ModTime = fileInfo.ModTime().UnixMilli()
		}
		result.Entries = append(result.Entries, item)
	}
	return result, nil
}

func (fs *filesystem) search(ctx context.Context, request remoteconnector.SearchRequest) (remoteconnector.SearchResult, error) {
	if err := contextError(ctx); err != nil {
		return remoteconnector.SearchResult{}, err
	}
	query := strings.TrimSpace(request.Query)
	if query == "" || len(query) > 128 {
		return remoteconnector.SearchResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidQuery, "search query must be between 1 and 128 bytes")
	}
	start, err := fs.sandbox.resolve(request.Path, false)
	if err != nil {
		return remoteconnector.SearchResult{}, err
	}
	info, err := os.Stat(start)
	if err != nil {
		return remoteconnector.SearchResult{}, fileError(err)
	}
	if !info.IsDir() {
		return remoteconnector.SearchResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeNotADirectory, "search path is not a directory")
	}
	limit := request.MaxResults
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		limit = maxSearchLimit
	}
	depthLimit := request.MaxDepth
	if depthLimit <= 0 {
		depthLimit = defaultSearchDepth
	}
	if depthLimit > maxSearchDepth {
		depthLimit = maxSearchDepth
	}
	needle := strings.ToLower(query)
	result := remoteconnector.SearchResult{Matches: make([]remoteconnector.SearchMatch, 0, limit)}
	visited := 0
	walkErr := filepath.WalkDir(start, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if err := contextError(ctx); err != nil {
			return err
		}
		visited++
		if visited > maxSearchVisited {
			result.Truncated = true
			return filepath.SkipAll
		}
		if path == start {
			return nil
		}
		relative, relErr := filepath.Rel(start, path)
		if relErr != nil {
			return nil
		}
		if entry.IsDir() {
			name := entry.Name()
			if name == ".git" || name == "node_modules" {
				return filepath.SkipDir
			}
			if strings.Count(filepath.ToSlash(relative), "/") >= depthLimit {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if len(result.Matches) >= limit {
			result.Truncated = true
			return filepath.SkipAll
		}
		display := filepath.ToSlash(relative)
		if !strings.Contains(strings.ToLower(display), needle) {
			return nil
		}
		match := remoteconnector.SearchMatch{Path: display, Type: "file"}
		if info, infoErr := entry.Info(); infoErr == nil {
			match.Size = info.Size()
			if info.IsDir() {
				match.Type = "dir"
			}
		}
		result.Matches = append(result.Matches, match)
		return nil
	})
	if walkErr != nil {
		if err := contextError(ctx); err != nil {
			return remoteconnector.SearchResult{}, err
		}
		return remoteconnector.SearchResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "search could not complete")
	}
	return result, nil
}

func decodePayload(raw json.RawMessage, target any) error {
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, target); err != nil {
			return remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "operation payload is not valid JSON")
		}
	}
	return nil
}

func readBounded(path string, limit int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fileError(err)
	}
	defer func() { _ = file.Close() }()
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, fileError(err)
	}
	if int64(len(content)) > limit {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeFileTooLarge, "file is larger than the file limit")
	}
	return content, nil
}

func contentVersion(content []byte) string {
	sum := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func contextError(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeRequestTimeout, "request was cancelled")
	}
	return nil
}

func fileError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, os.ErrNotExist):
		return remoteconnector.NewProtocolError(remoteconnector.CodePathNotFound, "path does not exist")
	case errors.Is(err, os.ErrPermission):
		return remoteconnector.NewProtocolError(remoteconnector.CodePermissionDenied, "workspace path is not permitted")
	case errors.Is(err, os.ErrExist):
		return remoteconnector.NewProtocolError(remoteconnector.CodeVersionConflict, "path already exists")
	default:
		return remoteconnector.NewProtocolError(remoteconnector.CodeInternal, "workspace file operation failed")
	}
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
