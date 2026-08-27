import { useCallback, useState } from 'react';
import { message } from 'antd';
import { sessionsAPI } from '@/services/api';

export interface ServerDirectoryEntry {
  name: string;
  path: string;
}

// 复用「打开项目」的服务端目录浏览状态机：双击进入子目录、单击选定、
// 确认后通过 onConfirm 回调选定路径。浏览的是 aih server 宿主机的目录，
// 空 subDir 时服务端默认落在当前用户 home。
export function useServerDirectoryPicker(onConfirm: (path: string) => void) {
  const [visible, setVisible] = useState(false);
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [directories, setDirectories] = useState<ServerDirectoryEntry[]>([]);
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
    onConfirm(selectedPath);
    setVisible(false);
  }, [onConfirm, selectedPath]);
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
