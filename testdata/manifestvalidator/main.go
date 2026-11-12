// 仅用于跨语言对拍：从 stdin 逐行读取 {manifest, options}，用 Go 的安装校验
// 产生 {ok, code, message, fingerprint}。testdata 不参与 go build ./...。
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
	Manifest map[string]any `json:"manifest"`
	Options  struct {
		HostVersion string `json:"hostVersion"`
		NodeVersion string `json:"nodeVersion"`
		Target      string `json:"target"`
	} `json:"options"`
}

type response struct {
	OK          bool   `json:"ok"`
	Code        string `json:"code,omitempty"`
	Message     string `json:"message,omitempty"`
	PluginID    string `json:"pluginId,omitempty"`
	Version     string `json:"version,omitempty"`
	Fingerprint string `json:"fingerprint"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var input request
		if err := json.Unmarshal(line, &input); err != nil {
			_ = encoder.Encode(response{OK: false, Code: "fixture_invalid", Message: err.Error()})
			continue
		}
		normalized, err := pluginartifact.ValidateManifest(input.Manifest, pluginartifact.ManifestOptions{
			HostVersion: input.Options.HostVersion,
			NodeVersion: input.Options.NodeVersion,
			Target:      input.Options.Target,
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
		pluginID, _ := normalized["pluginId"].(string)
		version, _ := normalized["version"].(string)
		_ = encoder.Encode(response{
			OK:          true,
			PluginID:    pluginID,
			Version:     version,
			Fingerprint: pluginartifact.PermissionFingerprint(normalized),
		})
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "scan:", err)
		os.Exit(2)
	}
}
