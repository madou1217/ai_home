package providercli

import (
	"encoding/json"

	"github.com/madou1217/ai_home/application/providerlaunch"
)

// Rewrite only the model before selecting an account. Unmatched requests keep
// their original bytes, and all opaque tools/thinking blocks remain intact.
func rewriteClaudeModelAlias(body []byte, alias providerlaunch.ModelAlias) ([]byte, error) {
	model, err := claudeRequestModel(body)
	if err != nil {
		return nil, err
	}
	target := alias.Resolve(model)
	if target == model {
		return body, nil
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(body, &document); err != nil {
		return nil, err
	}
	document["model"], err = json.Marshal(target)
	if err != nil {
		return nil, err
	}
	return json.Marshal(document)
}
