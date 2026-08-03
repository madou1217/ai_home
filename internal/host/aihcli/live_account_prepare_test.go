package aihcli

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

const (
	realCLIPrepareEnv  = "AIH_REAL_CLI_PREPARE"
	realCLIProviderEnv = "AIH_REAL_CLI_PROVIDER"
	realCLIHomeEnv     = "AIH_REAL_CLI_HOME"
	// realCLIAccountIDEnv 显式保留人工验收所针对的 Provider 内数字别名。
	realCLIAccountIDEnv = "AIH_REAL_CLI_ACCOUNT_ID"
	maxRealArtifact     = 1 << 20
)

// TestPrepareRealAccountDatabase 把显式 stdin 官方 artifact 注册到一个空临时 aih.db。
//
// 本辅助入口只为人工授权的真实 CLI smoke 准备隔离数据库。它不读取旧数据库，
// 不修改正式 AIH_HOME，也不会输出凭据或公开资料。
func TestPrepareRealAccountDatabase(t *testing.T) {
	if os.Getenv(realCLIPrepareEnv) != "1" {
		t.Skip("设置 AIH_REAL_CLI_PREPARE=1 后才允许准备真实 CLI 临时数据库")
	}

	providerID := os.Getenv(realCLIProviderEnv)
	aiHomeDir := requireEmptyRealCLIHome(t, os.Getenv(realCLIHomeEnv))
	artifacts := readRealCLIArtifacts(t, os.Stdin)
	defer clear(artifacts)

	credential, _, err := nativeaccount.NewDecoder().Decode(providerID, artifacts)
	if err != nil {
		t.Fatalf("解码真实 %s 官方 artifact 失败: %v", providerID, err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("创建 Provider Catalog 失败: %v", err)
	}
	cliAccountID := resolveRealCLIAccountID(t)
	registeredAt := time.Now().UTC().Truncate(time.Millisecond)
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: cliAccountID,
		CreatedAt:    registeredAt,
	})
	if err != nil {
		t.Fatalf("创建真实账号临时身份失败: %v", err)
	}
	registration, err := accountapp.NewRegistration(account, credential, registeredAt)
	if err != nil {
		t.Fatalf("创建真实账号临时注册命令失败: %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("创建真实 CLI 临时数据库失败: %v", err)
	}
	defer func() {
		if closeErr := store.Close(); closeErr != nil {
			t.Errorf("关闭真实 CLI 临时数据库失败: %v", closeErr)
		}
	}()
	if err := store.Register(context.Background(), registration); err != nil {
		t.Fatalf("注册真实 CLI 临时账号失败: %v", err)
	}

	t.Logf(
		"real_cli_account_ready provider=%s cli_account_id=%d account_ref=%s database=%s",
		providerID,
		cliAccountID.Int64(),
		account.Ref(),
		filepath.Join(aiHomeDir, sqliteaccount.DatabaseFileName),
	)
}

// resolveRealCLIAccountID 解析人工验收账号别名；缺省保持原有账号 1 行为。
func resolveRealCLIAccountID(t *testing.T) accountcore.CLIAccountID {
	t.Helper()

	rawValue := os.Getenv(realCLIAccountIDEnv)
	if rawValue == "" {
		rawValue = "1"
	}
	value, err := strconv.ParseInt(rawValue, 10, 64)
	if err != nil || strconv.FormatInt(value, 10) != rawValue {
		t.Fatalf("%s 必须是规范正整数", realCLIAccountIDEnv)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(value)
	if err != nil {
		t.Fatalf("创建临时账号别名失败: %v", err)
	}
	return cliAccountID
}

// requireEmptyRealCLIHome 只接受调用方新建的空目录，避免覆盖任何现有数据库。
func requireEmptyRealCLIHome(t *testing.T, value string) string {
	t.Helper()

	if value == "" || value != strings.TrimSpace(value) {
		t.Fatalf("%s 必须指定空临时目录", realCLIHomeEnv)
	}
	absolute, err := filepath.Abs(value)
	if err != nil || absolute == string(filepath.Separator) {
		t.Fatalf("%s 不是安全临时目录", realCLIHomeEnv)
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.IsDir() {
		t.Fatalf("%s 必须指向已存在目录", realCLIHomeEnv)
	}
	entries, err := os.ReadDir(absolute)
	if err != nil || len(entries) != 0 {
		t.Fatalf("%s 必须指向空目录", realCLIHomeEnv)
	}
	return absolute
}

// readRealCLIArtifacts 有界读取一次官方 artifact envelope，并拒绝空输入。
func readRealCLIArtifacts(t *testing.T, reader io.Reader) []byte {
	t.Helper()

	data, err := io.ReadAll(io.LimitReader(reader, maxRealArtifact+1))
	if err != nil {
		t.Fatalf("读取真实 CLI artifact 失败: %v", err)
	}
	if len(data) == 0 || len(data) > maxRealArtifact {
		clear(data)
		t.Fatal("真实 CLI artifact 为空或超过安全上限")
	}
	return data
}
