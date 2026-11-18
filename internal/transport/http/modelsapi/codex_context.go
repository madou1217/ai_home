package modelsapi

import "context"

// applyContextWindows only joins exact IDs. Provider-specific aliases and
// unknown models must not borrow another model's compaction policy.
func (handler *Handler) applyContextWindows(ctx context.Context, catalog *codexModelList) error {
	if handler.contextWindows == nil {
		return nil
	}
	windows, err := handler.contextWindows.ReadContextWindows(ctx)
	for index := range catalog.Models {
		model := &catalog.Models[index]
		if window, found := windows[model.Slug]; found && window.IsValid() {
			model.ContextWindow = window.Tokens
			model.MaxContextWindow = window.MaximumTokens
			model.AutoCompactTokenLimit = window.AutoCompactTokens
		}
	}
	return err
}
