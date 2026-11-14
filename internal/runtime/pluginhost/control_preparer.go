package pluginhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	plugincontrol "github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/pluginartifact"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

var instanceIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)

// ControlPreparerOptions 配置本地 Go RuntimePreparer 与控制状态解析参数。
type ControlPreparerOptions struct {
	AIHomeDir   string
	HostVersion string
	NodeVersion string
	Reader      ControlStateReader
	Runtime     *Runtime
	OnAudit     func(operation string, details map[string]any)
	Now         func() time.Time
}

type pendingAudit struct {
	operation string
	details   map[string]any
	at        time.Time
}

// ControlPreparer 直接在 Go 进程内实现 plugincontrol.RuntimePreparer（prepare / activate / discard）、
// DesiredPlugins 解析与 Doctor 诊断，取代原 Node /v0/plugins/internal/* 控制回调。
type ControlPreparer struct {
	aiHomeDir   string
	hostVersion string
	nodeVersion string
	reader      ControlStateReader
	runtime     *Runtime
	onAudit     func(operation string, details map[string]any)
	now         func() time.Time

	mu      sync.Mutex
	pending map[string]pendingAudit
}

// NewControlPreparer 构造本地控制面准备器。
func NewControlPreparer(options ControlPreparerOptions) (*ControlPreparer, error) {
	if options.Runtime == nil {
		return nil, errors.New("ControlPreparer 缺少 Runtime")
	}
	reader := options.Reader
	if reader == nil {
		var err error
		reader, err = NewSQLiteControlStateReader(options.AIHomeDir)
		if err != nil {
			return nil, err
		}
	}
	hostVersion := strings.TrimSpace(options.HostVersion)
	if hostVersion == "" {
		hostVersion = "1.0.0"
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &ControlPreparer{
		aiHomeDir:   strings.TrimSpace(options.AIHomeDir),
		hostVersion: hostVersion,
		nodeVersion: strings.TrimSpace(options.NodeVersion),
		reader:      reader,
		runtime:     options.Runtime,
		onAudit:     options.OnAudit,
		now:         nowFn,
		pending:     make(map[string]pendingAudit),
	}, nil
}

// DesiredPlugins 解析当前已启用实例的宿主运行规格列表（任何解析失败只视作局部错误或返回错误）。
func (p *ControlPreparer) DesiredPlugins(ctx context.Context) ([]PluginSpec, error) {
	doc, err := p.loadStateDoc(ctx)
	if err != nil {
		return nil, err
	}
	return buildHostPluginsFromDoc(doc)
}

// Prepare 执行与 Node control.prepareInstance + runtime.prepare 逐字对齐的校验、候选构建与宿主预热。
func (p *ControlPreparer) Prepare(ctx context.Context, request plugincontrol.PrepareRequest) (plugincontrol.PreparedCandidate, error) {
	if request.Operation != plugincontrol.OperationEnable && request.Operation != plugincontrol.OperationDisable {
		return plugincontrol.PreparedCandidate{}, pluginerr.New(CodeOperationInvalid, "未知 operation")
	}
	doc, err := p.loadStateDoc(ctx)
	if err != nil {
		return plugincontrol.PreparedCandidate{}, err
	}
	if doc.revision != request.ExpectedRevision {
		return plugincontrol.PreparedCandidate{}, pluginerr.New(
			CodeRevisionConflict,
			fmt.Sprintf("配置已被修改（当前 revision %d）", doc.revision),
		)
	}

	inputMap := map[string]any{}
	if len(strings.TrimSpace(string(request.Input))) > 0 {
		if err := json.Unmarshal(request.Input, &inputMap); err != nil {
			return plugincontrol.PreparedCandidate{}, pluginerr.New(CodeStateInvalid, "请求载荷必须是 JSON 对象")
		}
	}

	var auditDetails map[string]any
	switch request.Operation {
	case plugincontrol.OperationEnable:
		auditDetails, err = p.mutateEnable(&doc, inputMap)
	case plugincontrol.OperationDisable:
		auditDetails, err = p.mutateDisable(&doc, inputMap)
	}
	if err != nil {
		return plugincontrol.PreparedCandidate{}, err
	}

	plugins, err := buildHostPluginsFromDoc(doc)
	if err != nil {
		return plugincontrol.PreparedCandidate{}, err
	}

	prepared, err := p.runtime.Prepare(ctx, plugins)
	if err != nil {
		return plugincontrol.PreparedCandidate{}, err
	}

	doc.revision = request.ExpectedRevision + 1
	candidateBytes, err := doc.marshal()
	if err != nil {
		_ = p.runtime.Discard(context.Background(), prepared.Ticket, "candidate_marshal_failed")
		return plugincontrol.PreparedCandidate{}, pluginerr.New(CodeStateInvalid, err.Error())
	}

	p.mu.Lock()
	p.prunePendingLocked()
	p.pending[prepared.Ticket] = pendingAudit{
		operation: string(request.Operation),
		details:   auditDetails,
		at:        p.now(),
	}
	p.mu.Unlock()

	contribs := make([]json.RawMessage, 0, len(prepared.Contributions))
	for _, id := range prepared.Contributions {
		encoded, _ := json.Marshal(id)
		contribs = append(contribs, encoded)
	}

	return plugincontrol.PreparedCandidate{
		Ticket:        prepared.Ticket,
		Generation:    prepared.Generation,
		Candidate:     candidateBytes,
		Contributions: contribs,
	}, nil
}

// Activate 在 Go 完成控制状态 CAS 提交后激活宿主候选代次，并触发审计回调。
func (p *ControlPreparer) Activate(ctx context.Context, ticket string, revision int64) (plugincontrol.ActivationResult, error) {
	status, err := p.runtime.Activate(ctx, ticket, revision)
	if err != nil {
		return plugincontrol.ActivationResult{}, err
	}
	p.mu.Lock()
	auditEntry, ok := p.pending[ticket]
	delete(p.pending, ticket)
	p.mu.Unlock()
	if ok && p.onAudit != nil && auditEntry.details != nil {
		p.onAudit(auditEntry.operation, auditEntry.details)
	}
	return plugincontrol.ActivationResult{
		Generation: status.ActiveGeneration,
		State:      string(status.State),
	}, nil
}

// Discard 在提交失败或请求取消时释放候选代次。
func (p *ControlPreparer) Discard(ctx context.Context, ticket string, reason string) error {
	p.mu.Lock()
	delete(p.pending, ticket)
	p.mu.Unlock()
	return p.runtime.Discard(ctx, ticket, reason)
}

// Doctor 执行控制面与运行时的健康诊断（清单、制品、入口文件、权限、依赖图、运行时状态）。
func (p *ControlPreparer) Doctor(ctx context.Context) DoctorReport {
	report := DoctorReport{
		OK:           true,
		Issues:       []DoctorIssue{},
		Warnings:     []DoctorIssue{},
		Capabilities: map[string]int{},
		Installed:    []DoctorInstalledSummary{},
		Runtime:      p.runtime.Status(ctx),
	}
	doc, err := p.loadStateDoc(ctx)
	if err != nil {
		report.OK = false
		report.ControlStateError = err.Error()
		report.Issues = append(report.Issues, DoctorIssue{
			Code:   firstNonEmpty(errorCode(err), CodeStateUnavailable),
			Detail: err.Error(),
		})
		return report
	}
	report.Revision = doc.revision

	for _, item := range doc.installedMaps {
		pluginID := stringField(item, "pluginId")
		version := stringField(item, "version")
		digest := stringField(item, "digest")
		artifact := stringField(item, "artifact")
		directory := stringField(item, "directory")
		manifest, _ := item["manifest"].(map[string]any)
		sigValue := item["signature"]
		if sigValue == nil {
			sigValue = map[string]any{"status": "unsigned"}
		}
		summary := DoctorInstalledSummary{
			PluginID:  pluginID,
			Version:   version,
			Digest:    digest,
			Signature: sigValue,
		}
		if manifest != nil {
			summary.Permissions = manifest["permissions"]
			if _, vErr := pluginartifact.ValidateManifest(manifest, pluginartifact.ManifestOptions{
				HostVersion: p.hostVersion,
				NodeVersion: p.nodeVersion,
			}); vErr != nil {
				report.Issues = append(report.Issues, DoctorIssue{
					Code:     firstNonEmpty(errorCode(vErr), CodeManifestInvalid),
					PluginID: pluginID,
					Detail:   vErr.Error(),
				})
			}
			for _, contrib := range mapSlice(manifest, "contributes") {
				capName := stringField(contrib, "capability")
				if capName != "" {
					report.Capabilities[capName]++
				}
			}
			entryRel := stringField(manifest, "entry")
			if directory != "" && entryRel != "" {
				entryPath := joinManifestEntry(directory, entryRel)
				if _, statErr := os.Stat(entryPath); statErr != nil {
					report.Issues = append(report.Issues, DoctorIssue{
						Code:     "plugin_extracted_missing",
						PluginID: pluginID,
						Detail:   entryPath,
					})
				}
			}
		}
		if artifact != "" {
			if _, statErr := os.Stat(artifact); statErr != nil {
				report.Issues = append(report.Issues, DoctorIssue{
					Code:     "plugin_artifact_missing",
					PluginID: pluginID,
					Detail:   artifact,
				})
			}
		}
		sig, _ := item["signature"].(map[string]any)
		if stringField(sig, "status") != "signed" {
			report.Warnings = append(report.Warnings, DoctorIssue{
				Code:     "plugin_signature_unsigned",
				PluginID: pluginID,
				Detail:   "插件包未签名（完整性由摘要保证，来源不可验证）",
			})
		}
		report.Installed = append(report.Installed, summary)
	}

	for _, inst := range doc.instances {
		instID := stringField(inst, "instanceId")
		pluginID := stringField(inst, "pluginId")
		version := stringField(inst, "version")
		enabled, _ := inst["enabled"].(bool)
		matched := findInstalledRecord(doc.installedMaps, pluginID, version)
		if matched == nil {
			report.Issues = append(report.Issues, DoctorIssue{
				Code:       "plugin_instance_artifact_missing",
				InstanceID: instID,
			})
			continue
		}
		manifest, _ := matched["manifest"].(map[string]any)
		if enabled && hasDeclaredPermissions(manifest) {
			if stringField(inst, "permissionsAcceptedFingerprint") != pluginartifact.PermissionFingerprint(manifest) {
				report.Issues = append(report.Issues, DoctorIssue{
					Code:       CodePermissionsUnacknowledged,
					InstanceID: instID,
					PluginID:   pluginID,
				})
			}
		}
	}

	if report.Runtime.State == StateDegraded {
		detail := ""
		if report.Runtime.LastError != nil {
			detail = report.Runtime.LastError.Message
		}
		report.Issues = append(report.Issues, DoctorIssue{
			Code:        "plugin_runtime_degraded",
			Detail:      detail,
			Diagnostics: report.Runtime.Diagnostics,
		})
	}
	for _, descErr := range report.Runtime.DescriptorErrors {
		report.Warnings = append(report.Warnings, DoctorIssue{
			Code:   firstNonEmpty(descErr.Code, "provider_descriptor_rejected"),
			Detail: descErr.Detail,
		})
	}
	report.OK = len(report.Issues) == 0
	return report
}

func (p *ControlPreparer) mutateEnable(doc *rawControlDoc, input map[string]any) (map[string]any, error) {
	pluginID := stringField(input, "pluginId")
	if pluginID == "" {
		return nil, pluginerr.New(CodePluginIDRequired, "")
	}
	reqVersion := stringField(input, "version")
	target, err := selectInstalledMap(doc.installedMaps, pluginID, reqVersion)
	if err != nil {
		return nil, err
	}
	manifest, _ := target["manifest"].(map[string]any)
	fingerprint := pluginartifact.PermissionFingerprint(manifest)

	instanceID := stringField(input, "instanceId")
	if instanceID == "" {
		instanceID = pluginID
	}
	if !instanceIDPattern.MatchString(instanceID) {
		return nil, pluginerr.New(CodeInstanceIDInvalid, "")
	}

	existing := findInstanceRecord(doc.instances, instanceID)
	if existing != nil && stringField(existing, "pluginId") != pluginID {
		return nil, pluginerr.New(CodeInstanceConflict, fmt.Sprintf("实例 %s 属于其他插件", instanceID))
	}

	alreadyAccepted := existing != nil &&
		stringField(existing, "pluginId") == pluginID &&
		stringField(existing, "version") == stringField(target, "version") &&
		stringField(existing, "permissionsAcceptedFingerprint") == fingerprint &&
		existing["permissionsAcceptedAt"] != nil

	acceptPerm, _ := input["acceptPermissions"].(bool)
	if hasDeclaredPermissions(manifest) && !acceptPerm && !alreadyAccepted {
		return nil, pluginerr.New(
			CodePermissionsUnacknowledged,
			fmt.Sprintf("插件 %s 申请了权限，启用时需要确认（acceptPermissions）", pluginID),
		)
	}

	var rawConfig any
	if val, exists := input["configuration"]; exists {
		rawConfig = val
	} else if existing != nil {
		rawConfig = existing["configuration"]
	}
	validatedCfg, err := validateInstanceConfiguration(manifest, rawConfig)
	if err != nil {
		return nil, err
	}

	nowMs := p.now().UnixMilli()
	createdAt := any(nowMs)
	if existing != nil && existing["createdAt"] != nil {
		createdAt = existing["createdAt"]
	}

	record := map[string]any{}
	if existing != nil {
		for k, v := range existing {
			record[k] = v
		}
	}
	record["instanceId"] = instanceID
	record["pluginId"] = pluginID
	record["version"] = stringField(target, "version")
	record["enabled"] = true
	record["configuration"] = validatedCfg
	record["updatedAt"] = nowMs
	record["createdAt"] = createdAt

	if hasDeclaredPermissions(manifest) {
		acceptedAt := any(nowMs)
		if existing != nil && stringField(existing, "permissionsAcceptedFingerprint") == fingerprint && existing["permissionsAcceptedAt"] != nil {
			acceptedAt = existing["permissionsAcceptedAt"]
		}
		record["permissionsAcceptedAt"] = acceptedAt
		record["permissionsAcceptedFingerprint"] = fingerprint
	}

	nextInstances := make([]map[string]any, 0, len(doc.instances)+1)
	for _, item := range doc.instances {
		if stringField(item, "instanceId") == instanceID {
			continue
		}
		nextInstances = append(nextInstances, item)
	}
	nextInstances = append(nextInstances, record)
	doc.instances = nextInstances

	sigStatus := "unsigned"
	if sig, ok := target["signature"].(map[string]any); ok {
		if s := stringField(sig, "status"); s != "" {
			sigStatus = s
		}
	}
	return map[string]any{
		"instanceId":  instanceID,
		"pluginId":    pluginID,
		"version":     stringField(target, "version"),
		"signature":   sigStatus,
		"permissions": manifest["permissions"],
	}, nil
}

func (p *ControlPreparer) mutateDisable(doc *rawControlDoc, input map[string]any) (map[string]any, error) {
	instanceID := stringField(input, "instanceId")
	target := findInstanceRecord(doc.instances, instanceID)
	if target == nil {
		return nil, pluginerr.New(CodeInstanceUnknown, fmt.Sprintf("没有实例 %s", instanceID))
	}
	remove, _ := input["remove"].(bool)
	pluginID := stringField(target, "pluginId")
	if remove {
		next := make([]map[string]any, 0, len(doc.instances))
		for _, item := range doc.instances {
			if stringField(item, "instanceId") == instanceID {
				continue
			}
			next = append(next, item)
		}
		doc.instances = next
	} else {
		target["enabled"] = false
		target["updatedAt"] = p.now().UnixMilli()
	}
	return map[string]any{
		"instanceId": instanceID,
		"pluginId":   pluginID,
		"remove":     remove,
	}, nil
}

func (p *ControlPreparer) prunePendingLocked() {
	cutoff := p.now().Add(-5 * time.Minute)
	for id, item := range p.pending {
		if item.at.Before(cutoff) {
			delete(p.pending, id)
		}
	}
}

type rawControlDoc struct {
	raw              map[string]json.RawMessage
	schemaVersion    int
	revision         int64
	activeGeneration int64
	installed        []json.RawMessage
	installedMaps    []map[string]any
	instances        []map[string]any
	generations      []json.RawMessage
}

func (p *ControlPreparer) loadStateDoc(ctx context.Context) (rawControlDoc, error) {
	rawBytes, err := p.reader.ReadRawControlState(ctx)
	if err != nil {
		return rawControlDoc{}, err
	}
	doc := rawControlDoc{
		raw:           map[string]json.RawMessage{},
		schemaVersion: 1,
		installed:     []json.RawMessage{},
		installedMaps: []map[string]any{},
		instances:     []map[string]any{},
		generations:   []json.RawMessage{},
	}
	if len(strings.TrimSpace(string(rawBytes))) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(rawBytes, &doc.raw); err != nil {
		return rawControlDoc{}, pluginerr.New(CodeStateInvalid, "plugins.control.v1 JSON 格式无效")
	}
	if v, ok := doc.raw["schemaVersion"]; ok {
		_ = json.Unmarshal(v, &doc.schemaVersion)
	}
	if doc.schemaVersion == 0 {
		doc.schemaVersion = 1
	}
	if v, ok := doc.raw["revision"]; ok {
		_ = json.Unmarshal(v, &doc.revision)
	}
	if v, ok := doc.raw["activeGeneration"]; ok {
		_ = json.Unmarshal(v, &doc.activeGeneration)
	}
	if v, ok := doc.raw["installed"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &doc.installed); err != nil {
			return rawControlDoc{}, pluginerr.New(CodeStateInvalid, "installed 字段无效")
		}
		for _, elem := range doc.installed {
			var m map[string]any
			if err := json.Unmarshal(elem, &m); err != nil {
				return rawControlDoc{}, pluginerr.New(CodeStateInvalid, "installed 元素必须是对象")
			}
			doc.installedMaps = append(doc.installedMaps, m)
		}
	}
	// 用 installedMaps 对照 parsed list：与 installed 同索引保留未修改元素原文
	if v, ok := doc.raw["instances"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &doc.instances); err != nil {
			return rawControlDoc{}, pluginerr.New(CodeStateInvalid, "instances 字段无效")
		}
	}
	if v, ok := doc.raw["generations"]; ok && string(v) != "null" {
		if err := json.Unmarshal(v, &doc.generations); err != nil {
			return rawControlDoc{}, pluginerr.New(CodeStateInvalid, "generations 字段无效")
		}
	}
	// 为 validate/helper 对齐，用 installedMaps 填充 typed alias
	_ = doc.installedMaps
	return doc, nil
}

func (doc *rawControlDoc) marshal() ([]byte, error) {
	out := make(map[string]json.RawMessage, len(doc.raw)+6)
	for k, v := range doc.raw {
		out[k] = v
	}
	fields := map[string]any{
		"schemaVersion":    doc.schemaVersion,
		"revision":         doc.revision,
		"activeGeneration": doc.activeGeneration,
		"installed":        doc.installed,
		"instances":        doc.instances,
		"generations":      doc.generations,
	}
	for k, v := range fields {
		encoded, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		out[k] = encoded
	}
	return json.Marshal(out)
}

func buildHostPluginsFromDoc(doc rawControlDoc) ([]PluginSpec, error) {
	plugins := make([]PluginSpec, 0)
	for _, inst := range doc.instances {
		enabled, _ := inst["enabled"].(bool)
		if !enabled {
			continue
		}
		pluginID := stringField(inst, "pluginId")
		version := stringField(inst, "version")
		installed, err := selectInstalledMap(doc.installedMaps, pluginID, version)
		if err != nil {
			return nil, err
		}
		manifest, _ := installed["manifest"].(map[string]any)
		directory := stringField(installed, "directory")
		entryRel := stringField(manifest, "entry")
		entryPath := joinManifestEntry(directory, entryRel)
		cfg, _ := inst["configuration"].(map[string]any)
		if cfg == nil {
			cfg = map[string]any{}
		}
		plugins = append(plugins, PluginSpec{
			InstanceID:    stringField(inst, "instanceId"),
			PluginID:      pluginID,
			Version:       version,
			EntryPath:     entryPath,
			Manifest:      manifest,
			Configuration: cfg,
		})
	}
	return plugins, nil
}

func joinManifestEntry(directory, entryRel string) string {
	if directory == "" {
		return entryRel
	}
	parts := append([]string{directory}, strings.Split(entryRel, "/")...)
	return filepath.Join(parts...)
}

func selectInstalledMap(items []map[string]any, pluginID, version string) (map[string]any, error) {
	var matches []map[string]any
	for _, item := range items {
		if stringField(item, "pluginId") == pluginID && (version == "" || stringField(item, "version") == version) {
			matches = append(matches, item)
		}
	}
	if len(matches) == 0 {
		suffix := ""
		if version != "" {
			suffix = "@" + version
		}
		return nil, pluginerr.New(CodeNotInstalled, fmt.Sprintf("未安装插件 %s%s", pluginID, suffix))
	}
	if len(matches) > 1 {
		return nil, pluginerr.New(CodeVersionAmbiguous, fmt.Sprintf("插件 %s 安装了多个版本，请指定 --version", pluginID))
	}
	return matches[0], nil
}

func findInstalledRecord(items []map[string]any, pluginID, version string) map[string]any {
	for _, item := range items {
		if stringField(item, "pluginId") == pluginID && (version == "" || stringField(item, "version") == version) {
			return item
		}
	}
	return nil
}

func findInstanceRecord(items []map[string]any, instanceID string) map[string]any {
	for _, item := range items {
		if stringField(item, "instanceId") == instanceID {
			return item
		}
	}
	return nil
}

func hasDeclaredPermissions(manifest map[string]any) bool {
	if manifest == nil {
		return false
	}
	perms, _ := manifest["permissions"].(map[string]any)
	if perms == nil {
		return false
	}
	hasSlice := func(m map[string]any, key string) bool {
		s, ok := m[key].([]any)
		return ok && len(s) > 0
	}
	if hasSlice(perms, "network") || hasSlice(perms, "secrets") || hasSlice(perms, "environment") {
		return true
	}
	if fsMap, ok := perms["filesystem"].(map[string]any); ok {
		if hasSlice(fsMap, "read") || hasSlice(fsMap, "write") {
			return true
		}
	}
	return false
}

// validateInstanceConfiguration 校验配置对象：应用 schema 默认值后走 pluginartifact.CompileSchema，
// 语义与 Node Ajv({ allErrors: true, strict: true, useDefaults: true }) 对齐。
func validateInstanceConfiguration(manifest map[string]any, rawConfig any) (map[string]any, error) {
	var value any
	if rawConfig == nil {
		value = map[string]any{}
	} else {
		encoded, err := json.Marshal(rawConfig)
		if err != nil {
			return nil, pluginerr.New(CodeConfigInvalid, "配置必须是 JSON 对象")
		}
		if err := json.Unmarshal(encoded, &value); err != nil {
			return nil, pluginerr.New(CodeConfigInvalid, "配置必须是 JSON 对象")
		}
	}
	obj, ok := value.(map[string]any)
	if !ok || obj == nil {
		return nil, pluginerr.New(CodeConfigInvalid, "配置必须是 JSON 对象")
	}

	rawSchema, hasSchema := manifest["configSchema"]
	if !hasSchema || rawSchema == nil {
		if len(obj) > 0 {
			return nil, pluginerr.New(CodeConfigUnsupported, "该插件不接受配置")
		}
		return obj, nil
	}
	schemaMap, ok := rawSchema.(map[string]any)
	if !ok {
		return nil, pluginerr.New(CodeConfigInvalid, "configSchema 必须是对象")
	}
	applySchemaDefaults(schemaMap, obj)

	schemaBytes, err := json.Marshal(schemaMap)
	if err != nil {
		return nil, pluginerr.New(CodeConfigInvalid, err.Error())
	}
	compiled, err := pluginartifact.CompileSchema(schemaBytes)
	if err != nil {
		return nil, pluginerr.New(CodeConfigInvalid, fmt.Sprintf("配置不符合插件的 configSchema：%v", err))
	}
	if err := compiled.Validate(obj); err != nil {
		return nil, pluginerr.New(CodeConfigInvalid, fmt.Sprintf("配置不符合插件的 configSchema：%v", err))
	}
	return obj, nil
}

func applySchemaDefaults(schema map[string]any, target any) {
	if schema == nil {
		return
	}
	switch typed := target.(type) {
	case map[string]any:
		props, _ := schema["properties"].(map[string]any)
		for propName, propSchemaRaw := range props {
			propSchema, ok := propSchemaRaw.(map[string]any)
			if !ok {
				continue
			}
			if _, exists := typed[propName]; !exists {
				if defVal, hasDefault := propSchema["default"]; hasDefault {
					typed[propName] = cloneAny(defVal)
				}
			}
			if existing, exists := typed[propName]; exists {
				applySchemaDefaults(propSchema, existing)
			}
		}
	case []any:
		if itemSchema, ok := schema["items"].(map[string]any); ok {
			for _, item := range typed {
				applySchemaDefaults(itemSchema, item)
			}
		}
	}
}

func cloneAny(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		return v
	}
	var out any
	_ = json.Unmarshal(raw, &out)
	return out
}
