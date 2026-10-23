package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
)

const maxTransferInputBytes = 1024 * 1024

// ensureExportPathAvailable 在下载敏感正文前拒绝所有已有文件和链接。
func ensureExportPathAvailable(path string) error {
	_, err := os.Lstat(path)
	switch {
	case err == nil:
		return fmt.Errorf("%w: 输出文件已存在: %s", errInvalidCommand, path)
	case errors.Is(err, os.ErrNotExist):
		return nil
	default:
		return fmt.Errorf("检查输出文件失败: %w", err)
	}
}

// writeSensitiveFile 使用 O_EXCL 和 0600，失败时只清理本次新建的残缺文件。
func writeSensitiveFile(path string, document []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%w: 输出文件已存在: %s", errInvalidCommand, path)
		}
		return fmt.Errorf("创建敏感导出文件失败: %w", err)
	}
	_, writeErr := io.Copy(file, bytes.NewReader(document))
	syncErr := file.Sync()
	closeErr := file.Close()
	resultErr := errors.Join(writeErr, syncErr, closeErr)
	if resultErr == nil {
		return nil
	}
	removeErr := os.Remove(path)
	return fmt.Errorf("写入敏感导出文件失败: %w", errors.Join(resultErr, removeErr))
}

// readTransferInput 读取不超过 Server 合同上限的显式输入文件。
func readTransferInput(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("打开迁移输入文件失败: %w", err)
	}
	document, readErr := io.ReadAll(io.LimitReader(file, maxTransferInputBytes+1))
	closeErr := file.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		return nil, fmt.Errorf("读取迁移输入文件失败: %w", err)
	}
	if len(document) > maxTransferInputBytes {
		return nil, fmt.Errorf("%w: 迁移输入文件过大，最大 1 MiB", errInvalidCommand)
	}
	return document, nil
}
