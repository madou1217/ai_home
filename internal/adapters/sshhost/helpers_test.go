package sshhost

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// decodeUTF16LEBase64 解开 -EncodedCommand 的脚本，供断言使用。
func decodeUTF16LEBase64(t *testing.T, encoded string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		t.Fatalf("base64 解码失败: %v", err)
	}
	if len(raw)%2 != 0 {
		t.Fatalf("UTF-16LE 字节数必须为偶数: %d", len(raw))
	}
	units := make([]uint16, 0, len(raw)/2)
	for index := 0; index < len(raw); index += 2 {
		units = append(units, uint16(raw[index])|uint16(raw[index+1])<<8)
	}
	return string(utf16.Decode(units))
}

type fakeFile struct {
	data []byte
	perm os.FileMode
}

// fakeCredentialFS 是内存文件系统；只实现凭据写入与删除路径需要的操作。
type fakeWrite struct {
	path string
	data []byte
}

type fakeCredentialFS struct {
	dirs     map[string]os.FileMode
	files    map[string]*fakeFile
	writes   []fakeWrite
	removed  []string
	mkdirErr error
	writeErr error
	statErr  error
}

func newFakeCredentialFS() *fakeCredentialFS {
	return &fakeCredentialFS{dirs: map[string]os.FileMode{}, files: map[string]*fakeFile{}}
}

func (filesystem *fakeCredentialFS) MkdirAll(path string, perm os.FileMode) error {
	if filesystem.mkdirErr != nil {
		return filesystem.mkdirErr
	}
	filesystem.dirs[path] = perm
	return nil
}

func (filesystem *fakeCredentialFS) WriteFile(path string, data []byte, perm os.FileMode) error {
	if filesystem.writeErr != nil {
		return filesystem.writeErr
	}
	copied := make([]byte, len(data))
	copy(copied, data)
	filesystem.writes = append(filesystem.writes, fakeWrite{path: path, data: copied})
	filesystem.files[path] = &fakeFile{data: copied, perm: perm}
	return nil
}

func (filesystem *fakeCredentialFS) EvalSymlinks(path string) (string, error) {
	if _, found := filesystem.files[path]; found {
		return path, nil
	}
	if _, found := filesystem.dirs[path]; found {
		return path, nil
	}
	return "", os.ErrNotExist
}

func (filesystem *fakeCredentialFS) Stat(name string) (os.FileInfo, error) {
	if filesystem.statErr != nil {
		return nil, filesystem.statErr
	}
	file, found := filesystem.files[name]
	if !found {
		return nil, os.ErrNotExist
	}
	return fakeFileInfo{name: name, size: int64(len(file.data)), mode: file.perm}, nil
}

func (filesystem *fakeCredentialFS) Remove(name string) error {
	filesystem.removed = append(filesystem.removed, name)
	delete(filesystem.files, name)
	return nil
}

type fakeFileInfo struct {
	name string
	size int64
	mode os.FileMode
	dir  bool
}

func (info fakeFileInfo) Name() string       { return info.name }
func (info fakeFileInfo) Size() int64        { return info.size }
func (info fakeFileInfo) Mode() os.FileMode  { return info.mode }
func (info fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (info fakeFileInfo) IsDir() bool        { return info.dir }
func (info fakeFileInfo) Sys() any           { return nil }
