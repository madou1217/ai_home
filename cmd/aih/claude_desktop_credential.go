package main

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/claudedesktopcredential"
)

// This private command is a read-only credential pipe, independent of provider
// composition, the server and Desktop configuration publication.
func runClaudeDesktopCredential(ctx context.Context, args []string, runtime commandRuntime) error {
	if len(args) != 2 || args[0] != "--ai-home-dir" {
		return fmt.Errorf("%s: desktop_credential_arguments_invalid", claudedesktopcredential.Command)
	}
	bounded, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	credential, err := claudedesktopcredential.Resolve(bounded, args[1])
	if err != nil {
		return err
	}
	return json.NewEncoder(runtime.stdout).Encode(credential)
}
