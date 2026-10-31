import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { message } from 'antd';
import { sessionsAPI } from '@/services/api';
import type { Session } from '@/types';
import DirectoryPickerDialog from './DirectoryPickerDialog';
import OpenProjectDialog from './OpenProjectDialog';
import { useServerDirectoryPicker } from './use-server-directory-picker';
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
  // 目录浏览状态机复用共享 hook；这里只保留打开项目特有的回填逻辑
  // （确认路径时顺带推导默认项目名）。
  return useServerDirectoryPicker(useCallback((path: string): void => {
    setProjectPath(path);
    const pathParts = path.split(/[\\/]/).filter(Boolean);
    const defaultName = pathParts[pathParts.length - 1] || '';
    if (defaultName && !projectName.trim()) setProjectName(defaultName);
  }, [projectName, setProjectName, setProjectPath]));
}
