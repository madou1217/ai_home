package aihserver

import (
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/agy/codeassist"
)

// 模型刷新和推理共享同一账号转发表；重启恢复不需要上游请求。
func newAgyModelWires(aiHomeDir string) *codeassist.ModelWireStore {
	return codeassist.NewModelWireStore(filepath.Join(aiHomeDir, "run", "agy-model-wires.json"))
}
