// 仅用于 Node 端到端测试的独立 Go 进程：用真实适配器调用 Node 的
// 账号宿主清理契约（/v0/management/internal/account-host-cleanup）。
//
// 这个进程存在的意义是验证跨语言合同本身：JSON 字段、鉴权头、phase 语义、
// 错误分类。testdata 目录不会被 go build ./... 编译。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounthostcleanup"
)

type result struct {
	OK        bool   `json:"ok"`
	ErrorKind string `json:"error_kind,omitempty"`
	Message   string `json:"message,omitempty"`
}

func main() {
	nodeURL := os.Getenv("AIH_CLEANUP_TEST_NODE_URL")
	key := os.Getenv("AIH_CLEANUP_TEST_KEY")
	phase := os.Getenv("AIH_CLEANUP_TEST_PHASE")
	providerID := os.Getenv("AIH_CLEANUP_TEST_PROVIDER")
	goRef := os.Getenv("AIH_CLEANUP_TEST_GO_REF")
	nodeRef := os.Getenv("AIH_CLEANUP_TEST_NODE_REF")
	if nodeURL == "" || key == "" || phase == "" || providerID == "" || goRef == "" || nodeRef == "" {
		fmt.Fprintln(os.Stderr, "缺少 AIH_CLEANUP_TEST_* 环境变量")
		os.Exit(2)
	}

	client, err := accounthostcleanup.New(accounthostcleanup.Options{
		BaseURL:       nodeURL,
		ManagementKey: func() string { return key },
		NodeAccountRef: func(_ context.Context, requested string) (string, error) {
			// 记录调用方传进来的 Go 引用，保证真的走了翻译而不是恒等。
			if requested != goRef {
				return "", fmt.Errorf("unexpected go ref %s", requested)
			}
			return nodeRef, nil
		},
		Timeout: 5 * time.Second,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "client:", err)
		os.Exit(2)
	}
	account := buildAccount(providerID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	switch phase {
	case "verify":
		err = client.BeforeDelete(ctx, account)
	case "cleanup":
		err = client.AfterDelete(ctx, account)
	default:
		fmt.Fprintln(os.Stderr, "unknown phase:", phase)
		os.Exit(2)
	}
	writeResult(err)
}

func buildAccount(providerID string) accountcore.Account {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		fmt.Fprintln(os.Stderr, "catalog:", err)
		os.Exit(2)
	}
	ref, err := accountcore.ParseAccountRef(os.Getenv("AIH_CLEANUP_TEST_GO_REF"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "ref:", err)
		os.Exit(2)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		fmt.Fprintln(os.Stderr, "alias:", err)
		os.Exit(2)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
		CLIAccountID: cliAccountID,
		Enabled:      true,
		CreatedAt:    time.Unix(1, 0).UTC(),
		UpdatedAt:    time.Unix(1, 0).UTC(),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "account:", err)
		os.Exit(2)
	}
	return account
}

func writeResult(err error) {
	output := result{OK: err == nil}
	if err != nil {
		switch {
		case errors.Is(err, accountapp.ErrAccountRuntimeActive):
			output.ErrorKind = "runtime_active"
		case errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable):
			output.ErrorKind = "runtime_unverifiable"
		case errors.Is(err, accountapp.ErrAccountHostCleanupFailed):
			output.ErrorKind = "host_cleanup_failed"
		default:
			output.ErrorKind = "unknown"
		}
		output.Message = err.Error()
	}
	encoded, _ := json.Marshal(output)
	fmt.Println(string(encoded))
}
