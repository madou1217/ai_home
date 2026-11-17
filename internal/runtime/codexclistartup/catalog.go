package codexclistartup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
)

const maxFile = 8 << 20

var errCatalog = errors.New("codex_cli_startup_catalog_publication_failed")
var familyPattern = regexp.MustCompile(`(?i)^(gpt-\d+(?:\.\d+)?)(?:-|$)`)
var modelSetting = regexp.MustCompile(`^model\s*=\s*["']([^"']+)["']\s*$`)

func readBounded(path string) ([]byte, bool) {
	// The descriptor is verified after open. O_NONBLOCK closes the POSIX
	// regular-file-to-FIFO race without rejecting existing symlinked homes.
	// Windows ignores this flag; the caller also has a hard worker deadline.
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxFile {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(file, maxFile+1))
	return data, err == nil && len(data) <= maxFile
}
func projectCatalog(ctx context.Context, r request) ([]string, error) {
	home := trim(r.env.codexHome)
	if home == "" {
		base := r.env.home
		if base == "" {
			base = r.env.userProfile
		}
		if base = trim(base); base != "" {
			home = filepath.Join(base, ".codex")
		}
	}
	if home == "" {
		return nil, nil
	}
	config, ok := readBounded(filepath.Join(home, "config.toml"))
	if !ok {
		return nil, nil
	}
	model := ""
	for i, raw := range r.args {
		arg := trim(raw)
		if arg == "-m" || arg == "--model" {
			if i+1 < len(r.args) {
				model = trim(r.args[i+1])
			}
			break
		}
		if strings.HasPrefix(arg, "--model=") {
			model = trim(strings.TrimPrefix(arg, "--model="))
			break
		}
	}
	if model == "" {
		for _, line := range strings.Split(string(config), "\n") {
			line = trim(line)
			if strings.HasPrefix(line, "[") {
				break
			}
			if match := modelSetting.FindStringSubmatch(line); match != nil {
				model = trim(match[1])
				break
			}
		}
	}
	if model == "" || trim(r.aiHomeDir) == "" {
		return nil, nil
	}
	cache, ok := readBounded(filepath.Join(home, "models_cache.json"))
	if !ok {
		return nil, nil
	}
	value, err := parseOrdered(cache)
	if err != nil {
		return nil, nil
	}
	root, _ := value.(object)
	models, _ := root.get("models").([]any)
	if len(models) == 0 {
		return nil, nil
	}
	bySlug := map[string]any{}
	var ids []string
	for _, m := range models {
		slug := modelSlug(m)
		if slug == model {
			return nil, nil
		}
		if slug != "" {
			if _, exists := bySlug[slug]; !exists {
				bySlug[slug] = m
				ids = append(ids, slug)
			}
		}
	}
	ids = append(ids, model)
	projected := make([]any, 0, len(ids))
	for _, id := range ids {
		if exact, found := bySlug[id]; found {
			projected = append(projected, exact)
			continue
		}
		template := models[0]
		if family := modelFamily(id); family != "" {
			for _, candidate := range models {
				if modelFamily(modelSlug(candidate)) == family {
					template = candidate
					break
				}
			}
		}
		projected = append(projected, cloneModel(template, id))
	}
	content := appendJSON(nil, object{{"models", projected}})
	content = append(content, '\n')
	if len(content) > 2*maxFile {
		return nil, errCatalog
	}
	if ctx.Err() != nil {
		return nil, errors.New("codex_cli_startup_cancelled")
	}
	directory := filepath.Join(trim(r.aiHomeDir), "run", "codex", "model-catalogs")
	path, err := publish(directory, content)
	if err != nil {
		return nil, errCatalog
	}
	quoted := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(path)
	return []string{"-c", `model_catalog_json="` + quoted + `"`}, nil
}
func modelSlug(value any) string {
	obj, _ := value.(object)
	value = obj.get("slug")
	if value == nil || value == false || value == float64(0) {
		return ""
	}
	if s, ok := value.(string); ok {
		return trim(s)
	}
	// Valid Codex metadata uses strings; retain JSON.parse's common scalar coercion.
	if b, ok := value.(bool); ok {
		return strconv.FormatBool(b)
	}
	if n, ok := value.(float64); ok {
		return string(appendNumber(nil, n))
	}
	return "[object Object]"
}
func modelFamily(id string) string {
	match := familyPattern.FindStringSubmatch(trim(id))
	if match == nil {
		return ""
	}
	return strings.ToLower(match[1])
}
func cloneModel(template any, id string) object {
	source, _ := template.(object)
	out := append(object(nil), source...)
	for _, item := range []field{{"slug", id}, {"display_name", id}, {"description", "AIH gateway model " + id}} {
		out.set(item.key, item.value)
	}
	for _, item := range []field{{"base_instructions", "You are a coding agent. Follow the user instructions and use the available tools to complete the task safely and accurately."}, {"shell_type", "shell_command"}, {"visibility", "list"}} {
		if _, ok := source.get(item.key).(string); ok {
			item.value = source.get(item.key)
		}
		out.set(item.key, item.value)
	}
	out.set("supported_in_api", source.get("supported_in_api") != false)
	levels, ok := source.get("supported_reasoning_levels").([]any)
	if !ok {
		levels = []any{}
	}
	out.set("supported_reasoning_levels", levels)
	for _, key := range []string{"service_tiers", "additional_speed_tiers"} {
		out.set(key, []any{})
	}
	for _, key := range []string{"default_service_tier", "availability_nux", "upgrade"} {
		out.set(key, nil)
	}
	return out
}

func publish(directory string, content []byte) (string, error) {
	hash := sha256.Sum256(content)
	path := filepath.Join(directory, hex.EncodeToString(hash[:8])+".json")
	if existing, ok := readBounded(path); ok && bytes.Equal(existing, content) {
		return path, nil
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", err
	}
	temp, err := os.CreateTemp(directory, ".codex-model-catalog-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	if _, err := temp.Write(content); err != nil {
		temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(temp.Name(), path); err != nil {
		if existing, ok := readBounded(path); !ok || !bytes.Equal(existing, content) {
			return "", err
		}
	}
	return path, nil
}
