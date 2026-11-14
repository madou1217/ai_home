package desktoptranslation

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/desktopprotocol"
	"github.com/madou1217/ai_home/internal/runtime/translation"
)

// queue is latest-wins, with one executing and one pending operation. Stale operations
// may finish their transport cleanup but can never publish into a newer selection.
func (s *Service) queue(source context.Context, event map[string]any) {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	s.mu.Lock()
	if s.closed || !s.enabled || source == nil || source.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.cancelLocked()
	ctx, cancel := context.WithTimeout(s.ctx, 3*time.Minute)
	delivery, deliveryCancel := context.WithCancel(s.ctx)
	s.deliveryCancel = deliveryCancel
	op := &operation{event: event, epoch: s.epoch, ctx: ctx, cancel: cancel, delivery: delivery}
	s.pending = op
	s.mu.Unlock()
	select {
	case s.notify <- struct{}{}:
	default:
	}
}
func (s *Service) run() {
	defer close(s.workerDone)
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.notify:
			for {
				s.mu.Lock()
				op := s.pending
				s.pending = nil
				if op != nil {
					s.active = op
				}
				s.mu.Unlock()
				if op == nil {
					break
				}
				s.execute(op)
				op.cancel()
				s.mu.Lock()
				if s.active == op {
					s.active = nil
				}
				s.mu.Unlock()
			}
		}
	}
}
func (s *Service) emit(op *operation, event map[string]any) bool {
	s.controlMu.Lock()
	defer s.controlMu.Unlock()
	s.mu.Lock()
	if s.closed || s.active != op || s.epoch != op.epoch || op.ctx.Err() != nil {
		s.mu.Unlock()
		return false
	}
	s.mu.Unlock()
	event["id"] = op.event["id"]
	if generation, ok := op.event["generation"]; ok {
		event["generation"] = generation
	}
	// Native Send is a bounded enqueue, not a blocking write. It serializes with cancel.
	if err := s.launcher.SendContext(op.delivery, event); err != nil {
		// Preserve a helper-visible terminal when encoding failed; queue/child failure
		// already has an explicit launcher error and may make this enqueue impossible.
		_ = s.launcher.SendContext(op.delivery, map[string]any{"type": "error", "id": op.event["id"], "code": "translation_delivery_failed", "message": "翻译结果未能完整交付"})
		op.cancel()
		return false
	}
	return true
}
func (s *Service) execute(op *operation) {
	s.mu.Lock()
	settings := s.settings
	target := s.target
	s.mu.Unlock()
	text := strings.TrimSpace(desktopprotocol.Text(op.event["text"]))
	if text == "" || desktopprotocol.Units(text) > 8000 {
		return
	}
	source := desktopprotocol.Text(op.event["source"])
	if source == "" {
		source = "auto"
	}
	targetLanguage := desktopprotocol.Text(op.event["target"])
	if targetLanguage == "" {
		targetLanguage = settings.Target
	}
	policy := desktopprotocol.Text(op.event["targetPolicy"])
	if policy == "" {
		policy = settings.TargetPolicy
	}
	model := strings.TrimSpace(desktopprotocol.Text(op.event["model"]))
	provider := strings.TrimSpace(desktopprotocol.Text(op.event["provider"]))
	routes := selectionRoutes(settings.Routes)
	if provider == "" && model != "" {
		for _, route := range routes {
			if route.Enabled {
				provider = route.ModelProvider
				if provider == "" && settings.ExecutionTarget == "direct-provider" {
					provider = route.Provider
				}
				break
			}
		}
		if provider == "" {
			provider = settings.Provider
		}
	}
	if model != "" {
		if settings.ExecutionTarget == "aih-server" {
			routes = nil
		} else {
			routes = selectedRoutes(routes, provider, model)
		}
	} else if settings.ExecutionTarget == "aih-server" && len(routes) == 0 {
		routes = nil
	}
	if op.event["type"] == "translate-intent" {
		detectText := text
		if desktopprotocol.Units(detectText) > 4000 {
			detectText = string([]rune(detectText)[:min(4000, len([]rune(detectText)))])
		}
		detection := translation.DetectLanguage(detectText)
		intent := translation.ResolveLanguageIntent(translation.LanguageIntentInput{Source: "auto", Target: targetLanguage, Detected: detection.Code, Confidence: detection.Confidence, AllowAutoSource: translation.RoutesAllowAutoSource(routes, "selection", settings.ExecutionTarget == "aih-server"), TargetPolicy: policy})
		if intent.State == "same_language" && policy != "explicit" {
			if strings.HasPrefix(detection.Code, "zh") {
				targetLanguage = "en"
			} else {
				targetLanguage = "zh-Hans"
			}
			source = detection.Code
			policy = "explicit"
		} else if intent.State != "ready" {
			suggested := []string{}
			for _, lang := range translation.ListLanguages() {
				if lang.Code != intent.Source {
					suggested = append(suggested, lang.Code)
				}
				if len(suggested) == 3 {
					break
				}
			}
			s.emit(op, map[string]any{"type": "confirmation", "state": intent.State, "detected": detection.Code, "confidence": detection.Confidence, "target": targetLanguage, "suggestedTargets": suggested})
			return
		} else {
			source = intent.Source
			targetLanguage = intent.Target
		}
	}
	request := TranslationRequest{Text: text, Source: source, Target: targetLanguage, Policy: policy, Model: model, Provider: provider, Routes: routes, ExecutionTarget: settings.ExecutionTarget, ServerTarget: target}
	s.emit(op, map[string]any{"type": "start", "from": source, "to": targetLanguage, "model": model, "provider": provider})
	partial := false
	done, errorSent := false, false
	emit := func(event translation.StreamEvent) {
		if event.Type == "delta" && event.Content != "" {
			for _, chunk := range outputChunks(event.Content) {
				copy := event
				copy.Content = chunk
				if !s.emit(op, toMap(copy)) {
					errorSent = true
					return
				}
				partial = true
			}
			return
		}
		if event.Type == "done" {
			done = true
			if partial {
				event.Text = ""
			} else if len(outputChunks(event.Text)) > 1 {
				for _, chunk := range outputChunks(event.Text) {
					if !s.emit(op, map[string]any{"type": "delta", "content": chunk}) {
						errorSent = true
						return
					}
				}
				event.Text = ""
				partial = true
			}
		}
		if event.Type == "error" {
			if errorSent {
				return
			}
			errorSent = true
		}
		s.emit(op, toMap(event))
	}
	result := s.executor.Execute(op.ctx, request, emit)
	if !result.OK && result.Error != nil && result.Error.Retryable && !partial && settings.ExecutionTarget == "direct-provider" && s.options.Mode != "full-app" && target.Origin != "" {
		request.ExecutionTarget = "aih-server"
		result = s.executor.Execute(op.ctx, request, emit)
	}
	if op.ctx.Err() != nil {
		return
	}
	if result.OK {
		if !done && !errorSent {
			text := result.Text
			if partial {
				text = ""
			} else if len(outputChunks(text)) > 1 {
				for _, chunk := range outputChunks(text) {
					if !s.emit(op, map[string]any{"type": "delta", "content": chunk}) {
						errorSent = true
						return
					}
				}
				text = ""
			}
			completion := map[string]any{"type": "done", "usage": result.Usage}
			if !partial && text != "" {
				completion["text"] = text
			}
			s.emit(op, completion)
		}
	} else if !errorSent {
		code, message := "translation_failed", "翻译失败"
		if result.Error != nil {
			code = result.Error.Code
			message = result.Error.Message
		}
		s.emit(op, map[string]any{"type": "error", "code": code, "message": message})
	}
}

func selectionRoutes(routes []translation.Route) []translation.Route {
	result := make([]translation.Route, 0, len(routes))
	for _, route := range routes {
		if !route.Enabled {
			continue
		}
		selection := len(route.Operations) == 0
		for _, op := range route.Operations {
			selection = selection || op == "selection"
		}
		if selection {
			result = append(result, route)
		}
	}
	return result
}
func selectedRoutes(routes []translation.Route, provider, model string) []translation.Route {
	match := func(r translation.Route) bool {
		return provider == "" || r.ModelProvider == provider || r.Provider == provider
	}
	for _, r := range routes {
		if match(r) && r.Model == model {
			return []translation.Route{r}
		}
	}
	for _, r := range routes {
		if match(r) {
			r.Model = model
			return []translation.Route{r}
		}
	}
	return []translation.Route{}
}

// outputChunks budgets the JSON string representation (including Go HTML/control
// escaping), leaving room for request identity and event envelope. No byte is truncated.
func outputChunks(text string) []string {
	chunks := []string{}
	for text != "" {
		end := min(len(text), 60000)
		for end < len(text) && end > 0 && text[end]&0xc0 == 0x80 {
			end--
		}
		for {
			encoded, _ := json.Marshal(text[:end])
			if len(encoded) <= 60000 {
				break
			}
			end /= 2
			for end > 0 && text[end]&0xc0 == 0x80 {
				end--
			}
		}
		if end == 0 {
			return chunks
		}
		chunks = append(chunks, text[:end])
		text = text[end:]
	}
	return chunks
}
