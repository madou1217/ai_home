package proxypoollease

import "sync"

// coreOutput discards stdout/stderr without keeping even a tail of raw output:
// core diagnostics may contain node credentials. Only fixed-pattern automaton
// states and a bind-collision signal survive Write, including across chunks.
type coreOutput struct {
	mu        sync.Mutex
	collision chan struct{}
	matched   bool
	patterns  []outputPattern
}

type outputPattern struct {
	text     string
	fallback []int
	state    int
}

func newCoreOutput() *coreOutput {
	output := &coreOutput{collision: make(chan struct{})}
	for _, text := range []string{
		"address already in use",
		"eaddrinuse",
		"only one usage of each socket address",
	} {
		pattern := outputPattern{text: text, fallback: make([]int, len(text))}
		for i, j := 1, 0; i < len(text); i++ {
			for j > 0 && text[i] != text[j] {
				j = pattern.fallback[j-1]
			}
			if text[i] == text[j] {
				j++
			}
			pattern.fallback[i] = j
		}
		output.patterns = append(output.patterns, pattern)
	}
	return output
}

func (o *coreOutput) Write(data []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.matched {
		return len(data), nil
	}
	for _, b := range data {
		if b >= 'A' && b <= 'Z' {
			b += 'a' - 'A'
		}
		for i := range o.patterns {
			pattern := &o.patterns[i]
			for pattern.state > 0 && b != pattern.text[pattern.state] {
				pattern.state = pattern.fallback[pattern.state-1]
			}
			if b == pattern.text[pattern.state] {
				pattern.state++
			}
			if pattern.state == len(pattern.text) {
				o.matched = true
				close(o.collision)
				return len(data), nil
			}
		}
	}
	return len(data), nil
}
