// 仅用于跨语言对拍：从 stdin 逐行读取插件包路径与校验参数，用 Go 的
// inspectArtifact 产生 {ok, code, message}。testdata 不参与 go build ./...。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

type request struct {
	File          string `json:"file"`
	AIHomeDir     string `json:"aiHomeDir"`
	RequireSigned bool   `json:"requireSigned"`
	HostVersion   string `json:"hostVersion"`
	NodeVersion   string `json:"nodeVersion"`
	Target        string `json:"target"`
}

type response struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}
		var input request
		if err := json.Unmarshal(scanner.Bytes(), &input); err != nil {
			_ = encoder.Encode(response{OK: false, Code: "fixture_invalid", Message: err.Error()})
			continue
		}
		_, err := pluginartifact.Inspect(input.File, input.AIHomeDir, pluginartifact.AcceptOptions{
			HostVersion:   input.HostVersion,
			NodeVersion:   input.NodeVersion,
			Target:        input.Target,
			RequireSigned: input.RequireSigned,
		})
		if err != nil {
			result := response{OK: false}
			if coded, ok := pluginerr.From(err); ok {
				result.Code = coded.Code
				result.Message = coded.Error()
			} else {
				result.Code = "plugin_error"
				result.Message = err.Error()
			}
			_ = encoder.Encode(result)
			continue
		}
		_ = encoder.Encode(response{OK: true})
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "scan:", err)
		os.Exit(2)
	}
}
