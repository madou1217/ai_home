package accountbrowserview

import (
	"math"
	"strings"
)

func validCommand(c Command) bool {
	if len(c.URL) > 8192 || len(c.Text) > 4096 {
		return false
	}
	switch c.Type {
	case "start", "close":
		return true
	case "navigate":
		_, err := validateNavigateURL(c.URL)
		return err == nil
	case "text":
		return c.Text != "" && !strings.ContainsRune(c.Text, 0)
	case "key":
		switch c.Key {
		case "Enter", "Tab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown", "back", "forward", "reload":
			return true
		}
	case "pointer":
		return finite(c.X) && finite(c.Y) && c.X >= 0 && c.X <= 1 && c.Y >= 0 && c.Y <= 1 && (c.Button == 0 || c.Button == 2)
	case "scroll":
		return finite(c.DeltaX) && finite(c.DeltaY) && math.Abs(c.DeltaX) <= 2000 && math.Abs(c.DeltaY) <= 2000
	}
	return false
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
