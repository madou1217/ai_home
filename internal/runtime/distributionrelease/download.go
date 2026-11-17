package distributionrelease

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

// Download re-fetches the selected official release, manifest and SHA-256 sidecar
// before using info. Only a strictly newer stable version may be downloaded.
// privateDir must be caller-owned, not a symlink, and private (0700 on Unix;
// the caller must supply an equivalent private ACL on Windows). Newly downloaded
// files are 0600, not executable. Installation and restart belong to the caller.
// Existing verified artifacts are reused; invalid existing files are not removed.
func (s *Service) Download(ctx context.Context, info ReleaseInfo, privateDir string) (string, error) {
	v, err := parseVersion(info.Version, false)
	if err != nil || v.prerelease != "" || info.Repository != DefaultRepository || info.Target != s.target ||
		info.CurrentVersion != s.current.text || info.Tag != "v"+v.text || !validArtifact(info.Artifact, v.text, s.target) {
		return "", fmt.Errorf("%w: download selection identity mismatch", ErrInvalidRelease)
	}
	if !info.Available || !newerStable(v, s.current) {
		return "", ErrNoUpdate
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	release, err := s.fetchRelease(ctx, info.Tag)
	if err != nil {
		return "", err
	}
	fresh, err := s.releaseInfo(release)
	if err != nil {
		return "", err
	}
	if fresh.Tag != info.Tag || !fresh.Available {
		return "", fmt.Errorf("%w: selected release changed", ErrInvalidRelease)
	}
	artifact, err := s.fetchArtifactInfo(ctx, release, fresh.Version)
	if err != nil {
		return "", err
	}
	if artifact != info.Artifact {
		return "", fmt.Errorf("%w: selected manifest changed; check again", ErrInvalidRelease)
	}
	root, absolute, err := openPrivateDirectory(privateDir)
	if err != nil {
		return "", err
	}
	defer root.Close()
	path := filepath.Join(absolute, artifact.File)
	if existing, err := openRegular(root, artifact.File); err == nil {
		defer existing.Close()
		if err := verifyCopy(ctx, io.Discard, existing, artifact); err != nil {
			return "", fmt.Errorf("existing artifact: %w", err)
		}
		return path, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	partial := artifact.File + ".partial"
	file, err := root.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return "", ErrDownloadInProgress
	}
	if err != nil {
		return "", fmt.Errorf("create exclusive download: %w", err)
	}
	ownsPartial := true
	defer func() {
		file.Close()
		if ownsPartial {
			// A successful rename releases the name for another invocation.
			// Never remove that invocation's newly created partial on return.
			root.Remove(partial)
		}
	}()
	response, err := s.get(ctx, assetURL(info.Tag, artifact.File), "application/octet-stream")
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.ContentLength >= 0 && response.ContentLength != artifact.Bytes {
		return "", fmt.Errorf("%w: download Content-Length mismatch", ErrInvalidRelease)
	}
	if err := verifyCopy(ctx, file, response.Body, artifact); err != nil {
		return "", err
	}
	if err := file.Sync(); err != nil {
		return "", fmt.Errorf("sync verified download: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("close verified download: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	// Same-directory rename publishes only the complete verified bytes. The
	// exclusive partial serializes cooperating writers; never overwrite a file
	// that appeared while this download was in progress.
	if _, err := root.Lstat(artifact.File); !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("artifact destination appeared during download")
	}
	if err := root.Rename(partial, artifact.File); err != nil {
		return "", fmt.Errorf("publish verified download: %w", err)
	}
	ownsPartial = false
	return path, nil
}

func openPrivateDirectory(directory string) (*os.Root, string, error) {
	if directory == "" {
		return nil, "", fmt.Errorf("a private download directory is required")
	}
	absolute, err := filepath.Abs(directory)
	if err != nil {
		return nil, "", err
	}
	if err := os.MkdirAll(absolute, 0o700); err != nil {
		return nil, "", fmt.Errorf("create private download directory: %w", err)
	}
	stat, err := os.Lstat(absolute)
	if err != nil {
		return nil, "", err
	}
	if !stat.IsDir() || (runtime.GOOS != "windows" && stat.Mode().Perm()&0o077 != 0) {
		return nil, "", fmt.Errorf("download directory must be private and not a symlink")
	}
	root, err := os.OpenRoot(absolute)
	if err != nil {
		return nil, "", err
	}
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(stat, opened) {
		root.Close()
		return nil, "", fmt.Errorf("download directory changed while opening")
	}
	return root, absolute, nil
}

func openRegular(root *os.Root, name string) (*os.File, error) {
	stat, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !stat.Mode().IsRegular() {
		return nil, fmt.Errorf("artifact/cache must be a regular file, not a symlink")
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(stat, opened) {
		file.Close()
		return nil, fmt.Errorf("artifact/cache changed while opening")
	}
	return file, nil
}

func verifyCopy(ctx context.Context, output io.Writer, input io.Reader, expected ArtifactInfo) error {
	hash := sha256.New()
	reader := &contextReader{ctx: ctx, reader: input}
	n, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(reader, expected.Bytes+1))
	if err != nil {
		return fmt.Errorf("copy distribution artifact: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if n != expected.Bytes || hex.EncodeToString(hash.Sum(nil)) != expected.SHA256 {
		return fmt.Errorf("%w: artifact bytes or SHA-256 mismatch", ErrInvalidRelease)
	}
	return nil
}

type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r *contextReader) Read(buffer []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(buffer)
}
