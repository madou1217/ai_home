package inferenceapi

import (
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// ModelNamespaceHeader 是客户端声明的模型命名空间。
const ModelNamespaceHeader = "X-Aih-Model-Namespace"

var modelNamespacePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// ApplyModelNamespace 在裸模型名前补全请求头声明的命名空间。
func ApplyModelNamespace(header string, request inference.Request) inference.Request {
	namespace := strings.ToLower(strings.TrimSpace(header))
	if !modelNamespacePattern.MatchString(namespace) {
		return request
	}
	model := strings.TrimSpace(request.Model())
	if model == "" || strings.Contains(model, "/") {
		return request
	}
	return request.WithModel(namespace + "/" + model)
}
