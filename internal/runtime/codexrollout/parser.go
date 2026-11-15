package codexrollout

import (
	"container/heap"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

type turnHeap []*Turn

func (h turnHeap) Len() int           { return len(h) }
func (h turnHeap) Less(i, j int) bool { return h[i].rank < h[j].rank }
func (h turnHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *turnHeap) Push(value any)    { *h = append(*h, value.(*Turn)) }
func (h *turnHeap) Pop() any          { old := *h; v := old[len(old)-1]; *h = old[:len(old)-1]; return v }

type parser struct {
	options             Options
	byID                map[string]*Turn
	models              map[string]string
	recent              turnHeap
	current             *Turn
	itemCount, nonempty int
}

func newParser(options Options) *parser {
	return &parser{options: options, byID: make(map[string]*Turn), models: make(map[string]string)}
}
func (p *parser) ensure(id string, at *float64) (*Turn, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		id = fmt.Sprintf("%s-tail-%d", p.options.ThreadID, len(p.byID)+1)
	}
	turn := p.byID[id]
	if turn == nil {
		if len(p.byID) >= maxTrackedTurns {
			return nil, ErrReadBudget
		}
		turn = &Turn{ID: id, Items: []map[string]any{}, ItemsView: "full", Status: "inProgress", StartedAt: at, last: at, rank: len(p.byID)}
		p.byID[id] = turn
	}
	if model := p.models[id]; model != "" {
		turn.Model = model
	}
	if at != nil {
		turn.last = at
	}
	p.current = turn
	return turn, nil
}
func (p *parser) append(turn *Turn, item map[string]any) {
	p.itemCount++
	if !turn.nonempty {
		turn.nonempty = true
		p.nonempty++
		heap.Push(&p.recent, turn)
		turn.retained = true
		if len(p.recent) > p.options.TurnLimit {
			old := heap.Pop(&p.recent).(*Turn)
			old.retained = false
			old.Items = nil
		}
	}
	if !turn.retained {
		return
	}
	item["id"] = fmt.Sprintf("item-%d", p.itemCount)
	turn.Items = append(turn.Items, item)
}
func (p *parser) apply(kind string, at *float64, raw payload) error {
	if kind == "turn_context" {
		id := strings.TrimSpace(raw.TurnID)
		m := model(raw.Model)
		if id != "" && m != "" {
			if _, exists := p.models[id]; !exists && len(p.models) >= maxTrackedTurns {
				return ErrReadBudget
			}
			p.models[id] = m
			if turn := p.byID[id]; turn != nil {
				turn.Model = m
			}
		}
		return nil
	}
	if kind != "event_msg" {
		return nil
	}
	t := raw.Type
	ensure := func(useCurrent bool) (*Turn, error) {
		if useCurrent && p.current != nil {
			if at != nil {
				p.current.last = at
			}
			return p.current, nil
		}
		id := raw.TurnID
		if useCurrent && (t == "user_message" || t == "agent_message" || t == "error") {
			id = ""
		}
		return p.ensure(id, at)
	}
	switch t {
	case "task_started":
		_, err := ensure(false)
		return err
	case "user_message":
		turn, err := ensure(true)
		if err != nil {
			return err
		}
		content := []any{}
		message := text(raw.Message)
		if message != "" {
			elements := raw.TextElements
			if len(elements) == 0 || elements[0] != '[' {
				elements = json.RawMessage("[]")
			}
			content = append(content, map[string]any{"type": "text", "text": message, "text_elements": elements})
		}
		for index, images := range [][]json.RawMessage{raw.Images, raw.LocalImages} {
			for _, image := range images {
				var object map[string]json.RawMessage
				value := text(image)
				key, typeName := "url", "image"
				if index == 1 {
					key, typeName = "path", "localImage"
				}
				if value == "" && json.Unmarshal(image, &object) == nil {
					value = strings.TrimSpace(text(object[key]))
				}
				if value != "" {
					content = append(content, map[string]any{"type": typeName, key: value})
				}
			}
		}
		if len(content) > 0 {
			p.append(turn, map[string]any{"type": "userMessage", "content": content})
		}
	case "agent_message":
		message := text(raw.Message)
		if message == "" {
			return nil
		}
		turn, err := ensure(true)
		if err != nil {
			return err
		}
		p.append(turn, map[string]any{"type": "agentMessage", "text": message, "phase": nullable(raw.Phase), "memoryCitation": nullable(raw.MemoryCitation)})
	case "exec_command_end":
		turn, err := ensure(false)
		if err != nil {
			return err
		}
		command := text(raw.Command)
		var parts []json.RawMessage
		if json.Unmarshal(raw.Command, &parts) == nil && parts != nil {
			words := make([]string, len(parts))
			for i, v := range parts {
				words[i] = text(v)
			}
			command = strings.Join(words, " ")
		}
		var exit any
		exitNumber, exitOK := number(raw.ExitCode)
		if exitOK {
			exit = exitNumber
		}
		status := strings.TrimSpace(raw.Status)
		if status != "failed" && status != "declined" && status != "inProgress" {
			status = "completed"
			if exitOK && exitNumber != 0 {
				status = "failed"
			}
		}
		source := "agent"
		switch strings.TrimSpace(raw.Source) {
		case "unified_exec_startup":
			source = "unifiedExecStartup"
		case "unified_exec_interaction":
			source = "unifiedExecInteraction"
		case "user_shell":
			source = "userShell"
		}
		var duration any
		var d map[string]json.RawMessage
		if json.Unmarshal(raw.Duration, &d) == nil && d != nil {
			sec, _ := number(d["secs"])
			nanos, _ := number(d["nanos"])
			duration = math.Floor(sec*1000 + nanos/1e6 + .5)
		}
		cwd := raw.Cwd
		if cwd == "" {
			cwd = p.options.Cwd
		}
		var processID any
		if value := text(raw.ProcessID); value != "" && value != "0" {
			processID = value
		}
		p.append(turn, map[string]any{"type": "commandExecution", "command": command, "cwd": cwd, "processId": processID, "source": source, "status": status, "commandActions": []any{}, "aggregatedOutput": truncateOutput(firstText(raw.Output, raw.FormattedOutput, raw.Stdout, raw.Stderr), p.options.MaxCommandOutputChars), "exitCode": exit, "durationMs": duration})
	case "task_complete":
		turn, err := ensure(false)
		if err != nil {
			return err
		}
		turn.Status = "completed"
		turn.CompletedAt = at
		if turn.StartedAt != nil && at != nil {
			d := math.Max(0, math.Floor((*at-*turn.StartedAt)*1000+.5))
			turn.DurationMS = &d
		}
	case "turn_aborted":
		turn, err := ensure(true)
		if err != nil {
			return err
		}
		turn.Status = "interrupted"
		turn.CompletedAt = at
	case "error":
		turn, err := ensure(true)
		if err != nil {
			return err
		}
		message := text(raw.Message)
		if message == "" {
			message = "thread failed"
		}
		turn.Status = "failed"
		turn.Error = map[string]any{"message": message}
	}
	return nil
}
func (p *parser) finish() []*Turn {
	result := make([]*Turn, len(p.recent))
	copy(result, p.recent)
	sort.Slice(result, func(i, j int) bool { return result[i].rank < result[j].rank })
	now := float64(time.Now().UnixMilli())
	if p.options.NowMS != nil {
		now = *p.options.NowMS
	}
	stale := float64(30 * 60 * 1000)
	if p.options.StaleAfterMS != nil {
		stale = *p.options.StaleAfterMS
	}
	for _, turn := range result {
		last := float64(0)
		if turn.last != nil {
			last = *turn.last
		}
		if turn.Status == "inProgress" && stale >= 0 && now-last*1000 > stale {
			turn.Status = "interrupted"
			turn.CompletedAt = &last
			start := float64(0)
			if turn.StartedAt != nil {
				start = *turn.StartedAt
			}
			d := math.Max(0, math.Floor((last-start)*1000+.5))
			turn.DurationMS = &d
		}
	}
	return result
}
