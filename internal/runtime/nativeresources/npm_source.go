package nativeresources

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	npmSourcePrefix = "npm:"
	npmMetadataMax  = 2 * 1024 * 1024
)

var npmPluginIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

type npmPackageMetadata struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}

func (s *Service) importNpmDescriptor(ctx context.Context, kind, rawSpec, provider, host string) (string, error) {
	if strings.ToLower(strings.TrimSpace(kind)) != "plugin" {
		return "", fail("native_resource_npm_kind_unsupported")
	}
	name, requested, err := parseNpmSpec(strings.TrimSpace(strings.TrimPrefix(rawSpec, npmSourcePrefix)))
	if err != nil {
		return "", err
	}
	mode, engineKey, target := npmTargetMode(provider, host)
	if mode == "" {
		return "", fail("native_resource_npm_target_unsupported")
	}
	meta, err := fetchNpmMetadata(ctx, name, requested)
	if err != nil {
		return "", err
	}
	pluginID := npmPluginID(name)
	if !npmPluginIDPattern.MatchString(pluginID) {
		return "", fail("native_resource_npm_id_invalid")
	}
	descriptor := map[string]any{
		"name":        meta.Name,
		"version":     meta.Version,
		"description": meta.Description,
		"agentPlugin": map[string]any{
			"pluginId":        pluginID,
			"manifestVersion": 1,
			"kind":            "harness",
			"engines":         map[string]any{engineKey: ">=0.0.0"},
			"mode":            mode,
			"npmPackage":      meta.Name + "@" + meta.Version,
			target:            meta.Name + "@" + meta.Version,
		},
	}
	raw, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return "", fail("native_resource_npm_descriptor_invalid")
	}
	root := s.sourceUploadRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", fail("native_resource_source_forbidden")
	}
	dir := filepath.Join(root, "npm-"+randomSuffix())
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fail("native_resource_source_forbidden")
	}
	if err := os.WriteFile(filepath.Join(dir, "package.json"), append(raw, '\n'), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return "", fail("native_resource_source_forbidden")
	}
	return dir, nil
}

func parseNpmSpec(spec string) (name, version string, err error) {
	if spec == "" {
		return "", "", fail("native_resource_npm_spec_invalid")
	}
	at := strings.LastIndex(spec, "@")
	if at > 0 {
		name = spec[:at]
		version = spec[at+1:]
	} else {
		name = spec
	}
	if strings.TrimSpace(name) == "" || strings.ContainsAny(name, " \t\r\n") {
		return "", "", fail("native_resource_npm_spec_invalid")
	}
	if version != "" && strings.ContainsAny(version, " \t\r\n") {
		return "", "", fail("native_resource_npm_spec_invalid")
	}
	return name, version, nil
}

func npmTargetMode(provider, host string) (mode, engineKey, targetField string) {
	switch {
	case strings.EqualFold(strings.TrimSpace(host), "deepseek"):
		return "dsh-profile", "deepseek", "npmPackage"
	case strings.EqualFold(strings.TrimSpace(provider), "opencode"):
		return "opencode-npm", "opencode", "opencodePackage"
	default:
		return "", "", ""
	}
}

func npmPluginID(name string) string {
	value := strings.ToLower(strings.TrimSpace(name))
	value = strings.TrimPrefix(value, "@")
	replacer := strings.NewReplacer("/", "-", ".", "-", "_", "-")
	value = replacer.Replace(value)
	for strings.Contains(value, "--") {
		value = strings.ReplaceAll(value, "--", "-")
	}
	value = strings.Trim(value, "-")
	if len(value) > 64 {
		value = value[:64]
	}
	return value
}

func fetchNpmMetadata(ctx context.Context, name, requested string) (npmPackageMetadata, error) {
	version := strings.TrimSpace(requested)
	if version == "" {
		version = "latest"
	}
	endpoint := "https://registry.npmjs.org/" + strings.TrimPrefix(name, "/") + "/" + url.PathEscape(version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return npmPackageMetadata{}, fail("native_resource_npm_spec_invalid")
	}
	client := &http.Client{Timeout: 20 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return npmPackageMetadata{}, fail("native_resource_npm_lookup_failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return npmPackageMetadata{}, fail("native_resource_npm_lookup_failed")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, npmMetadataMax+1))
	if err != nil || len(raw) > npmMetadataMax {
		return npmPackageMetadata{}, fail("native_resource_npm_lookup_failed")
	}
	var meta npmPackageMetadata
	if json.Unmarshal(raw, &meta) != nil || meta.Name == "" || meta.Version == "" {
		return npmPackageMetadata{}, fail("native_resource_npm_lookup_failed")
	}
	return meta, nil
}

func npmPackageFrom(pkg PluginPackage, field string) string {
	agentPlugin, _ := pkg.PackageJSON["agentPlugin"].(map[string]any)
	value, _ := agentPlugin[field].(string)
	return strings.TrimSpace(value)
}

func (s *Service) inspectNpmSource(ctx context.Context, rawSpec string) (SourceInspection, error) {
	name, requested, err := parseNpmSpec(strings.TrimSpace(strings.TrimPrefix(rawSpec, npmSourcePrefix)))
	if err != nil {
		return SourceInspection{}, err
	}
	meta, err := fetchNpmMetadata(ctx, name, requested)
	if err != nil {
		return SourceInspection{}, err
	}
	return SourceInspection{
		OK:          true,
		Kind:        "plugin",
		Plane:       "harness",
		ID:          npmPluginID(meta.Name),
		Version:     meta.Version,
		Description: meta.Description,
		Targets:     []string{"deepseek", "opencode"},
	}, nil
}
