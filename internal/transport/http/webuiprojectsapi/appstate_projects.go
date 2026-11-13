package webuiprojectsapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const webuiProjectsKey = "webui-projects"

type openedProjectRecord struct {
	Path    string `json:"path"`
	Name    string `json:"name"`
	AddedAt int64  `json:"addedAt"`
}

type webuiProjectState struct {
	OpenedProjects []openedProjectRecord
	HiddenPaths    []string
}

func readWebUIProjectState(ctx context.Context, aiHomeDir string) webuiProjectState {
	if strings.TrimSpace(aiHomeDir) == "" {
		return webuiProjectState{}
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return webuiProjectState{}
	}
	if _, statErr := os.Stat(dbPath); statErr != nil {
		return webuiProjectState{}
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, webuiProjectsKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return webuiProjectState{}
	}
	var payload struct {
		Projects    []openedProjectRecord `json:"projects"`
		HiddenPaths []string              `json:"hiddenPaths"`
	}
	if json.Unmarshal([]byte(raw), &payload) != nil {
		return webuiProjectState{}
	}
	opened := make([]openedProjectRecord, 0, len(payload.Projects))
	seenOpened := make(map[string]bool, len(payload.Projects))
	for _, item := range payload.Projects {
		normalized := normalizeProjectPath(item.Path)
		if normalized == "" || seenOpened[normalized] {
			continue
		}
		seenOpened[normalized] = true
		opened = append(opened, openedProjectRecord{
			Path:    normalized,
			Name:    trimSpace(item.Name),
			AddedAt: item.AddedAt,
		})
	}
	hidden := make([]string, 0, len(payload.HiddenPaths))
	seenHidden := make(map[string]bool, len(payload.HiddenPaths))
	for _, item := range payload.HiddenPaths {
		normalized := normalizeProjectPath(item)
		if normalized == "" || seenHidden[normalized] {
			continue
		}
		seenHidden[normalized] = true
		hidden = append(hidden, normalized)
	}
	return webuiProjectState{OpenedProjects: opened, HiddenPaths: hidden}
}

func applyProjectOverlay(
	aiHomeDir string,
	scanned []projectView,
	state webuiProjectState,
	workspaces []webuiremoteworkspace.WorkspaceRecord,
	options aggregateOptions,
) []projectView {
	hiddenSet := make(map[string]bool, len(state.HiddenPaths))
	for _, p := range state.HiddenPaths {
		hiddenSet[p] = true
	}

	openedByPath := make(map[string]openedProjectRecord, len(state.OpenedProjects))
	for _, item := range state.OpenedProjects {
		openedByPath[item.Path] = item
	}

	remoteOrder := make([]webuiremoteworkspace.WorkspaceRecord, 0, len(workspaces))
	remoteByShadow := make(map[string]webuiremoteworkspace.WorkspaceRecord, len(workspaces))
	for _, ws := range workspaces {
		shadow, err := webuiremoteworkspace.EnsureShadowDir(aiHomeDir, ws.ID)
		if err != nil {
			continue
		}
		normShadow := normalizeProjectPath(shadow)
		ws.ShadowPath = normShadow
		remoteByShadow[normShadow] = ws
		remoteOrder = append(remoteOrder, ws)
	}

	chatWorkspacesRoot := normalizeProjectPath(filepath.Join(aiHomeDir, "run", "chat-workspaces"))
	isChatWorkspace := func(projectPath string) bool {
		return chatWorkspacesRoot != "" && (projectPath == chatWorkspacesRoot || strings.HasPrefix(projectPath, chatWorkspacesRoot+"/"))
	}

	projects := make([]projectView, 0, len(scanned)+len(state.OpenedProjects)+len(remoteOrder))
	seenPaths := make(map[string]bool, len(scanned))

	for _, project := range scanned {
		projectPath := normalizeProjectPath(project.Path)
		if projectPath == "" || hiddenSet[projectPath] || isChatWorkspace(projectPath) {
			continue
		}
		if webuiremoteworkspace.WorkspaceIDFromProjectPath(aiHomeDir, projectPath) != "" {
			if _, registered := remoteByShadow[projectPath]; !registered {
				continue
			}
		}
		if opened, ok := openedByPath[projectPath]; ok {
			project.Manual = true
			if opened.AddedAt > 0 {
				project.AddedAt = opened.AddedAt
			}
			if opened.Name != "" {
				project.Name = opened.Name
			}
		}
		if ws, ok := remoteByShadow[projectPath]; ok {
			if ws.Label != "" {
				project.Name = ws.Label
			}
			project.Remote = buildRemoteDescriptor(ws)
			if project.AddedAt == 0 && ws.CreatedAt > 0 {
				project.AddedAt = ws.CreatedAt
			}
		}
		seenPaths[projectPath] = true
		projects = append(projects, project)
	}

	for _, opened := range state.OpenedProjects {
		if seenPaths[opened.Path] || hiddenSet[opened.Path] || isChatWorkspace(opened.Path) {
			continue
		}
		if options.projectPath != "" && opened.Path != options.projectPath {
			continue
		}
		if !isExistingDirectory(opened.Path) {
			continue
		}
		name := opened.Name
		if name == "" {
			name = filepath.Base(opened.Path)
		}
		view := projectView{
			ID:           base64PathID("", opened.Path),
			Name:         name,
			Path:         opened.Path,
			Providers:    []string{},
			Sessions:     []sessionView{},
			SessionTotal: 0,
			Manual:       true,
			AddedAt:      opened.AddedAt,
		}
		if ws, ok := remoteByShadow[opened.Path]; ok {
			if ws.Label != "" {
				view.Name = ws.Label
			}
			view.Remote = buildRemoteDescriptor(ws)
		}
		seenPaths[opened.Path] = true
		projects = append(projects, view)
	}

	for _, ws := range remoteOrder {
		shadow := ws.ShadowPath
		if shadow == "" || seenPaths[shadow] || hiddenSet[shadow] {
			continue
		}
		if options.projectPath != "" && shadow != options.projectPath {
			continue
		}
		name := ws.Label
		if name == "" {
			name = ws.ID
		}
		seenPaths[shadow] = true
		projects = append(projects, projectView{
			ID:           ws.ID,
			Name:         name,
			Path:         shadow,
			Providers:    []string{},
			Sessions:     []sessionView{},
			SessionTotal: 0,
			Remote:       buildRemoteDescriptor(ws),
			AddedAt:      ws.CreatedAt,
		})
	}

	sort.SliceStable(projects, func(left, right int) bool {
		return projectLastActivityAt(projects[left]) > projectLastActivityAt(projects[right])
	})
	return projects
}

func buildRemoteDescriptor(ws webuiremoteworkspace.WorkspaceRecord) *remoteDescriptor {
	return &remoteDescriptor{
		WorkspaceID:  ws.ID,
		ConnectionID: ws.ConnectionID,
		Host:         ws.Host,
		HostLabel:    ws.HostLabel,
		RemoteRoot:   ws.RemoteRoot,
	}
}

// ListAuthorizedProjectPaths 返回当前所有已登记（扫描+手动打开+远程工作区，排除隐藏项）的项目路径。
// 供文件与 Git 接口校权使用。
func ListAuthorizedProjectPaths(ctx context.Context, hostHomeDir, aiHomeDir string) ([]string, error) {
	handler := &Handler{
		hostHomeDir: trimSpace(hostHomeDir),
		aiHomeDir:   trimSpace(aiHomeDir),
		maxEntries:  DefaultMaxEntries,
		scanTimeout: DefaultScanTimeout,
	}
	if handler.aiHomeDir == "" && handler.hostHomeDir != "" {
		handler.aiHomeDir = filepath.Join(handler.hostHomeDir, ".ai_home")
	}
	scanCtx, cancel := context.WithTimeout(ctx, handler.scanTimeout)
	defer cancel()
	projects, _ := handler.collect(scanCtx, aggregateOptions{})
	paths := make([]string, 0, len(projects))
	for _, project := range projects {
		if project.Path != "" {
			paths = append(paths, project.Path)
		}
	}
	return paths, nil
}
