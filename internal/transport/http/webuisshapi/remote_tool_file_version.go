package webuisshapi

import "errors"

var errRemoteFileTooLarge = errors.New("文件过大（超过 512 KiB 读取上限）；不能用截断内容生成版本或覆盖原文件")

// completeRemoteFile is shared by the remote dialects. Versions identify a
// complete file, never a bounded preview. Both edit_file and write_file rely on
// that invariant when they compare the version immediately before replacing.
func completeRemoteFile(content []byte, truncated bool) ([]byte, string, error) {
	if truncated || len(content) > remoteReadMaxBytes {
		return nil, "", errRemoteFileTooLarge
	}
	return content, versionOfContent(content), nil
}
