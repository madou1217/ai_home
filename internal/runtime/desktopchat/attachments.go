package desktopchat

import (
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

var ownedReferenceName = regexp.MustCompile(`(?i)^aih-chat-[0-9a-f-]+\.txt$`)

func under(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func (bridge *Bridge) attachment(ref *fileReference) (chatruntime.AttachmentUploadInput, func(), error) {
	cleanup := func() {}
	var raw []byte
	if ref.path == "" {
		raw = []byte(ref.text)
	} else {
		path := filepath.Clean(ref.path)
		if !filepath.IsAbs(ref.path) || !ownedReferenceName.MatchString(filepath.Base(path)) || !under(bridge.tempDir, path) {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		root, rootErr := filepath.EvalSymlinks(bridge.tempDir)
		actual, pathErr := filepath.EvalSymlinks(path)
		if rootErr != nil || pathErr != nil || !under(root, actual) {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		// Keep the lexical basename in the rooted operation: resolving a terminal
		// symlink first could let an owned-looking filename target another temp file.
		relative, relErr := filepath.Rel(bridge.tempDir, path)
		if relErr != nil {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		rooted, rootErr := os.OpenRoot(root)
		if rootErr != nil {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		keepRoot := false
		defer func() {
			if !keepRoot {
				_ = rooted.Close()
			}
		}()
		info, err := rooted.Lstat(relative)
		if err != nil || !info.Mode().IsRegular() || info.Size() > chatruntime.MaxDocumentBytes {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		file, err := rooted.Open(relative)
		if err != nil {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_read_failed")
		}
		defer file.Close()
		opened, err := file.Stat()
		if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_path_invalid")
		}
		raw, err = io.ReadAll(io.LimitReader(file, chatruntime.MaxDocumentBytes+1))
		if err != nil {
			return chatruntime.AttachmentUploadInput{}, cleanup, failure("chat_file_reference_read_failed")
		}
		// Delete only the inode we read; a replaced path belongs to another operation.
		keepRoot = true
		cleanup = func() {
			defer rooted.Close()
			if current, e := rooted.Lstat(relative); e == nil && current.Mode().IsRegular() && os.SameFile(opened, current) {
				_ = rooted.Remove(relative)
			}
		}
	}
	if len(raw) > chatruntime.MaxDocumentBytes || !utf8.Valid(raw) {
		cleanup()
		return chatruntime.AttachmentUploadInput{}, func() {}, failure("chat_file_reference_read_failed")
	}
	return chatruntime.AttachmentUploadInput{Name: ref.name, MimeType: ref.mime, DataURL: "data:" + ref.mime + ";base64," + base64.StdEncoding.EncodeToString(raw)}, cleanup, nil
}
