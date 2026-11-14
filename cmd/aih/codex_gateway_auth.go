package main

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexgateway"
)

// runCodexGatewayAuth is the machine-only host-provider authentication command.
// stdout contains only the credential. Errors are closed codes, never config text.
func runCodexGatewayAuth(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) != 2 || arguments[0] != "--ai-home" || strings.TrimSpace(arguments[1]) == "" || !filepath.IsAbs(arguments[1]) {
		return fmt.Errorf("%w: codex gateway-auth --ai-home <absolute-path>", errInvalidCommand)
	}
	connection, err := codexgateway.Read(ctx, arguments[1], runtime.lookupEnv)
	if err != nil {
		return err
	}
	_, err = fmt.Fprint(runtime.stdout, connection.APIKey())
	return err
}
