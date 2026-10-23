package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// runAccountArtifactImport is an explicit file import, not broad credential
// discovery. It uses the same Provider decoder as the server and never opens
// a local aih.db or turns an unsupported browser login into an implied feature.
func runAccountArtifactImport(ctx context.Context, providerID, filePath string, runtime commandRuntime) error {
	client, err := newAccountManagementClient(runtime)
	if err != nil {
		return err
	}
	decoder := nativeaccount.NewDecoder()
	if !decoder.Supports(providerID) {
		return fmt.Errorf("%w: 未实现该 Provider 的原生 artifact", errInvalidCommand)
	}
	document, err := readExplicitNativeArtifact(filePath)
	if err != nil {
		return err
	}
	defer clear(document)
	if _, _, err := decoder.Decode(providerID, document); err != nil {
		return fmt.Errorf("%w: 原生 artifact 无效或身份不可核验", errInvalidCommand)
	}
	result, err := client.ImportNative(ctx, providerID, document)
	if err != nil {
		return fmt.Errorf("导入原生 artifact 到目标 Server 失败: %w", err)
	}
	writeImportResult(runtime.stdout, accountImportResult{
		providerID:   result.Account.ProviderID,
		cliAccountID: result.Account.CLIAccountID.Int64(), accountRef: result.Account.AccountRef.String(),
		email: result.Account.Email, created: result.Created,
		sources: []string{filepath.Base(filePath)},
	})
	return nil
}

// readExplicitNativeArtifact rejects links/special files and checks the opened
// inode against lstat. Limits are shared with the existing management contract.
func readExplicitNativeArtifact(filePath string) ([]byte, error) {
	before, err := os.Lstat(filePath)
	if err != nil || !before.Mode().IsRegular() || before.Size() > maxTransferInputBytes {
		return nil, fmt.Errorf("%w: 原生 artifact 必须是最多 1 MiB 的普通文件", errInvalidCommand)
	}
	file, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("读取原生 artifact 失败: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, fmt.Errorf("%w: 原生 artifact 在读取时变化", errInvalidCommand)
	}
	document, err := io.ReadAll(io.LimitReader(file, maxTransferInputBytes+1))
	if err != nil || len(document) > maxTransferInputBytes {
		clear(document)
		return nil, errors.New("原生 artifact 读取失败或超出限制")
	}
	after, err := file.Stat()
	if err != nil || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		clear(document)
		return nil, errors.New("原生 artifact 在读取时变化")
	}
	return document, nil
}
