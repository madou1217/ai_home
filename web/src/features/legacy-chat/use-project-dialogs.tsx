import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { message } from 'antd';
import { sessionsAPI } from '@/services/api';
import type { Session } from '@/types';
import DirectoryPickerDialog from './DirectoryPickerDialog';
import OpenProjectDialog from './OpenProjectDialog';
import type { PersistedChatSelection } from './runtime-types';

interface ProjectDialogDependencies {
  readonly mobile: boolean;
  readonly loadProjects: (selection?: PersistedChatSelection) => Promise<void>;
  readonly setExpandedProjects: Dispatch<SetStateAction<Set<string>>>;
  readonly setSelectedSession: Dispatch<SetStateAction<Session | null>>;
  readonly setMobileShowChat: Dispatch<SetStateAction<boolean>>;
  readonly onSelectionMutation: () => void;
}

export function useProjectDialogs(dependencies: ProjectDialogDependencies) {
  const [open, setOpen] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const directory = useProjectDirectoryPicker(projectName, setProjectName, setProjectPath);

  const submit = useCallback(async (): Promise<void> => {
    const normalizedPath = projectPath.trim();
    if (!normalizedPath) {
      message.warning('请输入项目路径');
      return;
    }
    try {
      const project = await sessionsAPI.openProject(
        normalizedPath,
        projectName.trim() || undefined,
      );
      setOpen(false);
      setProjectPath('');
      setProjectName('');
      dependencies.onSelectionMutation();
      await dependencies.loadProjects({ projectPath: project.path });
      dependencies.setExpandedProjects((current) => new Set([...current, project.id]));
      dependencies.setSelectedSession(null);
      if (dependencies.mobile) dependencies.setMobileShowChat(false);
      message.success('项目已打开');
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '打开项目失败');
    }
  }, [dependencies, projectName, projectPath]);

  return {
    openProject: useCallback((): void => setOpen(true), []),
    node: (
      <>
        <OpenProjectDialog
          open={open}
          projectPath={projectPath}
          projectName={projectName}
          onOpenChange={setOpen}
          onPickDirectory={directory.open}
          onProjectNameChange={setProjectName}
          onSubmit={submit}
        />
        <DirectoryPickerDialog
          open={directory.visible}
          currentPath={directory.currentPath}
          parentPath={directory.parentPath}
          directories={directory.directories}
          loading={directory.loading}
          selectedPath={directory.selectedPath}
          onCancel={directory.close}
          onConfirm={directory.confirm}
          onNavigate={directory.load}
          onSelect={directory.select}
        />
      </>
    ),
  };
}

function useProjectDirectoryPicker(
  projectName: string,
  setProjectName: Dispatch<SetStateAction<string>>,
  setProjectPath: Dispatch<SetStateAction<string>>,
) {
  const [visible, setVisible] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [directories, setDirectories] = useState<Array<{ name: string; path: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');
  const load = useCallback(async (subDirectory: string): Promise<void> => {
    setLoading(true);
    try {
      const result = await sessionsAPI.browseProjectDirectory(subDirectory);
      if (!result.ok) {
        message.error(result.message || '加载目录失败');
        return;
      }
      setCurrentPath(result.currentDir);
      setParentPath(result.parentDir);
      setDirectories(result.directories || []);
      setSelectedPath(result.currentDir);
    } catch (error: any) {
      message.error(`无法获取服务端目录列表: ${error.message || '未知错误'}`);
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }, []);
  const open = useCallback((): void => {
    setSelectedPath('');
    setCurrentPath('');
    setDirectories([]);
    setVisible(true);
    void load('');
  }, [load]);
  const confirm = useCallback((): void => {
    if (!selectedPath) {
      message.warning('请选择一个目录');
      return;
    }
    setProjectPath(selectedPath);
    const pathParts = selectedPath.split(/[\\/]/).filter(Boolean);
    const defaultName = pathParts[pathParts.length - 1] || '';
    if (defaultName && !projectName.trim()) setProjectName(defaultName);
    setVisible(false);
  }, [projectName, selectedPath, setProjectName, setProjectPath]);
  return {
    visible,
    currentPath,
    parentPath,
    directories,
    loading,
    selectedPath,
    open,
    close: () => setVisible(false),
    confirm,
    load,
    select: setSelectedPath,
  };
}
