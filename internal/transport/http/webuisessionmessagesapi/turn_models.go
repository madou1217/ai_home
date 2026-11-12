package webuisessionmessagesapi

import "encoding/json"

// decorateTurnModels mirrors Node decorateMessagesWithTurnModels:
// user messages in the same turn receive the assistant model once seen.
func decorateTurnModels(messages []json.RawMessage) []json.RawMessage {
	turnModel := ""
	turnHasAssistant := false
	userIndexes := []int{}
	for index := 0; index < len(messages); index++ {
		var message map[string]any
		if json.Unmarshal(messages[index], &message) != nil {
			continue
		}
		role, _ := message["role"].(string)
		model, _ := message["model"].(string)
		if role == "user" {
			if turnHasAssistant {
				turnModel = ""
				turnHasAssistant = false
				userIndexes = nil
			}
			userIndexes = append(userIndexes, index)
			if model != "" {
				turnModel = model
			}
			if turnModel != "" && model == "" {
				message["model"] = turnModel
				raw, _ := json.Marshal(message)
				messages[index] = raw
			}
			continue
		}
		if role != "assistant" {
			continue
		}
		turnHasAssistant = true
		if model != "" {
			turnModel = model
		}
		if turnModel == "" {
			continue
		}
		if model == "" {
			message["model"] = turnModel
			raw, _ := json.Marshal(message)
			messages[index] = raw
		}
		for _, userIndex := range userIndexes {
			var user map[string]any
			if json.Unmarshal(messages[userIndex], &user) != nil {
				continue
			}
			if existing, _ := user["model"].(string); existing != "" {
				continue
			}
			user["model"] = turnModel
			raw, _ := json.Marshal(user)
			messages[userIndex] = raw
		}
	}
	return messages
}
