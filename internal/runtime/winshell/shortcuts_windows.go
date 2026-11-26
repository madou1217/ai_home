//go:build windows

package winshell

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const defaultVBSTimeout = 20 * time.Second

// RunVBSReadText writes a temporary VBS script, executes it via
// %SystemRoot%\System32\cscript.exe //nologo with a hidden console window,
// and decodes the UTF-16LE output file written by the script.
//
// The script may locate the output file path either through the "{{OUT}}"
// placeholder or through WScript.Arguments(0). Additional args are forwarded as
// WScript.Arguments(1), WScript.Arguments(2), ...
func RunVBSReadText(ctx context.Context, scriptTemplate string, timeout time.Duration, extraArgs ...string) (string, error) {
	if timeout <= 0 {
		timeout = defaultVBSTimeout
	}
	dir, err := os.MkdirTemp("", "aih-winshell-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	outPath := filepath.Join(dir, "out.tsv")
	vbsPath := filepath.Join(dir, "run.vbs")
	script := strings.ReplaceAll(scriptTemplate, "{{OUT}}", strings.ReplaceAll(outPath, `"`, `""`))
	if err := os.WriteFile(vbsPath, encodeScriptBytes(script), 0o600); err != nil {
		return "", err
	}

	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cscript := resolveCscriptPath()
	args := make([]string, 0, 3+len(extraArgs))
	args = append(args, "//nologo", vbsPath, outPath)
	args = append(args, extraArgs...)
	cmd := exec.CommandContext(cctx, cscript, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	runErr := cmd.Run()

	data, readErr := os.ReadFile(outPath)
	if readErr != nil || len(data) == 0 {
		if runErr != nil {
			return "", runErr
		}
		if readErr != nil {
			return "", readErr
		}
		return "", nil
	}
	return DecodeWindowsText(data), nil
}

func resolveCscriptPath() string {
	if sysRoot := strings.TrimSpace(os.Getenv("SystemRoot")); sysRoot != "" {
		candidate := filepath.Join(sysRoot, "System32", "cscript.exe")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return "cscript.exe"
}

// StartMenuProgramsRoots returns the deduplicated per-user and machine-wide
// Start Menu\Programs directories on Windows.
func StartMenuProgramsRoots() []string {
	var roots []string
	seen := make(map[string]struct{}, 2)
	add := func(base string) {
		base = strings.TrimSpace(base)
		if base == "" {
			return
		}
		p := filepath.Clean(filepath.Join(base, "Microsoft", "Windows", "Start Menu", "Programs"))
		key := strings.ToLower(p)
		if _, dup := seen[key]; dup {
			return
		}
		seen[key] = struct{}{}
		roots = append(roots, p)
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		add(appData)
	} else if up := strings.TrimSpace(os.Getenv("USERPROFILE")); up != "" {
		add(filepath.Join(up, "AppData", "Roaming"))
	}
	if programData := strings.TrimSpace(os.Getenv("ProgramData")); programData != "" {
		add(programData)
	} else if allUsers := strings.TrimSpace(os.Getenv("ALLUSERSPROFILE")); allUsers != "" {
		add(allUsers)
	}
	return roots
}

// ListShortcuts enumerates .lnk files under per-user/machine Start Menu\Programs
// (recursively) and per-user/public Desktop, resolving each shortcut's TargetPath
// through WScript.Shell.CreateShortcut in a temporary cscript VBS invocation.
func ListShortcuts(ctx context.Context) ([]Shortcut, error) {
	text, err := RunVBSReadText(ctx, listShortcutsVBS, defaultVBSTimeout)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(text) == "" {
		return nil, nil
	}

	seen := make(map[string]struct{}, 128)
	shortcuts := make([]Shortcut, 0, 128)
	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSuffix(rawLine, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		linkPath := strings.TrimSpace(parts[0])
		if linkPath == "" {
			continue
		}
		cleanLink := filepath.Clean(linkPath)
		ext := filepath.Ext(cleanLink)
		if !strings.EqualFold(ext, ".lnk") {
			continue
		}
		key := strings.ToLower(cleanLink)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}

		base := filepath.Base(cleanLink)
		name := strings.TrimSpace(base[:len(base)-len(filepath.Ext(base))])
		targetPath := ""
		if len(parts) == 2 {
			targetPath = strings.TrimSpace(parts[1])
		}
		if targetPath != "" {
			targetPath = filepath.Clean(targetPath)
		}
		targetExists := false
		if targetPath != "" {
			if _, statErr := os.Stat(targetPath); statErr == nil {
				targetExists = true
			}
		}
		shortcuts = append(shortcuts, Shortcut{
			LinkPath:     cleanLink,
			Name:         name,
			TargetPath:   targetPath,
			TargetExists: targetExists,
		})
	}
	return shortcuts, nil
}

const listShortcutsVBS = `Option Explicit
If WScript.Arguments.Count < 1 Then WScript.Quit 1

Dim fso, shell, out, seenDirs, seenLinks, envProc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set out = fso.CreateTextFile(WScript.Arguments(0), True, True)
Set seenDirs = CreateObject("Scripting.Dictionary")
seenDirs.CompareMode = 1
Set seenLinks = CreateObject("Scripting.Dictionary")
seenLinks.CompareMode = 1
Set envProc = shell.Environment("Process")

Function CleanDir(p)
  Dim s
  s = Trim(CStr(p))
  Do While Len(s) > 3 And Right(s, 1) = "\"
    s = Left(s, Len(s) - 1)
  Loop
  CleanDir = s
End Function

Function SafeSpecialFolder(name)
  On Error Resume Next
  Err.Clear
  SafeSpecialFolder = shell.SpecialFolders(name)
  If Err.Number <> 0 Then
    SafeSpecialFolder = ""
    Err.Clear
  End If
End Function

Function JoinPath(a, b)
  a = CleanDir(a)
  If Len(a) = 0 Then
    JoinPath = ""
  Else
    JoinPath = fso.BuildPath(a, b)
  End If
End Function

Sub ScanRoot(dirPath, recursive)
  Dim norm, key
  norm = CleanDir(dirPath)
  If Len(norm) = 0 Then Exit Sub
  key = norm & "|" & CStr(recursive)
  If seenDirs.Exists(key) Then Exit Sub
  seenDirs.Add key, True
  WalkFolder norm, recursive, 0
End Sub

Sub WalkFolder(folderPath, recursive, depth)
  Dim folder, f, subf, subPaths(), count, i
  If Len(folderPath) = 0 Or depth > 10 Then Exit Sub
  On Error Resume Next
  Err.Clear
  If Not fso.FolderExists(folderPath) Then
    Err.Clear
    Exit Sub
  End If
  Set folder = fso.GetFolder(folderPath)
  If Err.Number <> 0 Or folder Is Nothing Then
    Err.Clear
    Exit Sub
  End If
  For Each f In folder.Files
    If Err.Number <> 0 Then
      Err.Clear
      Exit For
    End If
    If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
      EmitShortcut f.Path
    End If
  Next
  Err.Clear
  If recursive Then
    count = 0
    For Each subf In folder.SubFolders
      If Err.Number <> 0 Then
        Err.Clear
        Exit For
      End If
      If (subf.Attributes And 1024) = 0 Then
        ReDim Preserve subPaths(count)
        subPaths(count) = subf.Path
        count = count + 1
      End If
    Next
    Err.Clear
    For i = 0 To count - 1
      WalkFolder subPaths(i), True, depth + 1
    Next
  End If
End Sub

Sub EmitShortcut(lnkPath)
  Dim sc, target
  If seenLinks.Exists(lnkPath) Then Exit Sub
  seenLinks.Add lnkPath, True
  On Error Resume Next
  Err.Clear
  target = ""
  Set sc = shell.CreateShortcut(lnkPath)
  If Err.Number = 0 And Not sc Is Nothing Then
    If Not IsNull(sc.TargetPath) Then
      target = CStr(sc.TargetPath)
    End If
    If InStr(target, "%") > 0 Then
      target = shell.ExpandEnvironmentStrings(target)
    End If
  End If
  Err.Clear
  target = Replace(Replace(Replace(target, vbCr, ""), vbLf, ""), vbTab, " ")
  out.WriteLine lnkPath & vbTab & target
End Sub

ScanRoot SafeSpecialFolder("Programs"), True
ScanRoot SafeSpecialFolder("AllUsersPrograms"), True
ScanRoot JoinPath(envProc("APPDATA"), "Microsoft\Windows\Start Menu\Programs"), True
ScanRoot JoinPath(envProc("ProgramData"), "Microsoft\Windows\Start Menu\Programs"), True
ScanRoot JoinPath(envProc("ALLUSERSPROFILE"), "Microsoft\Windows\Start Menu\Programs"), True

ScanRoot SafeSpecialFolder("Desktop"), False
ScanRoot SafeSpecialFolder("AllUsersDesktop"), False
ScanRoot JoinPath(envProc("USERPROFILE"), "Desktop"), False
ScanRoot JoinPath(envProc("PUBLIC"), "Desktop"), False

out.Close
`
