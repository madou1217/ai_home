package webuisshapi

// validateRemoteToolInput is called before config/credential loading and before
// HTTP forwarding. Tool schemas are descriptions, not execution-time guards.
func validateRemoteToolInput(name string, args map[string]any) map[string]any {
	if name != "write_file" {
		return nil
	}
	if _, ok := args["expected_version"].(string); !ok {
		return remoteToolError("invalid_expected_version", "expected_version 必须提供字符串；新建文件传空字符串")
	}
	if _, ok := args["path"].(string); !ok {
		return remoteToolError("invalid_write_arguments", "path 必须为字符串")
	}
	if _, ok := args["content"].(string); !ok {
		return remoteToolError("invalid_write_arguments", "content 必须为字符串")
	}
	return nil
}
