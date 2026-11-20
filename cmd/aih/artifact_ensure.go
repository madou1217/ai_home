package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/madou1217/ai_home/internal/runtime/artifactstore"
)

// runArtifactEnsure 是 Node 启动链到 Go 构件库的私有管道：
// 只接受 __artifacts-ensure + stdin JSON，stdout 只输出 JSON。
func runArtifactEnsure(ctx context.Context, args []string, runtime commandRuntime) (bool, error) {
	if len(args) == 0 || args[0] != "__artifacts-ensure" {
		return false, nil
	}
	if len(args) == 2 && args[1] == "--capabilities" {
		_, err := fmt.Fprintln(runtime.stdout, "aih-artifactstore-v1")
		return true, err
	}
	if len(args) != 1 {
		return true, errors.New("artifacts_ensure_invalid_arguments")
	}
	raw, err := io.ReadAll(io.LimitReader(runtime.stdin, 8*1024*1024))
	if err != nil {
		return true, errors.New("artifacts_ensure_input_failed")
	}
	var request artifactstore.Request
	if err := json.Unmarshal(raw, &request); err != nil {
		return true, errors.New("artifacts_ensure_invalid_json")
	}
	response := artifactstore.Ensure(request)
	encoded, err := json.Marshal(response)
	if err != nil {
		return true, errors.New("artifacts_ensure_encode_failed")
	}
	if _, err := fmt.Fprintln(runtime.stdout, string(encoded)); err != nil {
		return true, err
	}
	return true, nil
}
