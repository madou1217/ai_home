package clilogin

import (
	"context"
	"runtime"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

func stubQoderDecrypt(t *testing.T) {
	t.Helper()
	previous := qoderDecrypt
	qoderDecrypt = func(provider, blob, machineID string, options qodercred.Options) (string, error) {
		return `{"uid":"qoderuser1","email":"qoder@example.com"}`, nil
	}
	t.Cleanup(func() { qoderDecrypt = previous })
}

func TestRunRegistersQoderLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	stubQoderDecrypt(t)
	script := writeFakeBinary(t, "qodercli", `mkdir -p "$QODER_CONFIG_DIR/.auth"
printf 'opaque-blob-value' > "$QODER_CONFIG_DIR/.auth/user"
printf '0123456789abcdef' > "$QODER_CONFIG_DIR/.auth/machine_id"
`)
	t.Setenv("AIH_QODER_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "qoder",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "qoder" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}
