import { useCallback, useEffect, useState } from 'react';
import { message } from 'antd';
import { sshHostsAPI } from '@/services/api';
import type { SshHostTestResult } from '@/types';
import type { RemoteDirItem, SshConnection, SshWorkspace } from './ssh-hosts-model';

type ApiError = { message?: string; response?: { data?: { message?: string } } };

const asApiError = (error: unknown): ApiError => (error && typeof error === 'object' ? error as ApiError : {});

export interface SshTestState {
  loading: boolean;
  result?: SshHostTestResult;
}

/**
 * SSH 连接 / 工作空间的数据与操作（sshHostsAPI），桌面 SshHostsPanel 与移动端 MobileSshHosts 共用。
 * 只负责数据、请求与提示文案；弹窗 / 抽屉等视图状态由各自页面持有。
 */
export function useSshHosts() {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  const [workspaces, setWorkspaces] = useState<SshWorkspace[]>([]);
  const [loadingConns, setLoadingConns] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  // 连通性测试状态：key 为 connection.id，value 为测试中 (loading) 或测试结果 (result)
  const [testStates, setTestStates] = useState<Record<string, SshTestState>>({});

  const fetchConnections = useCallback(async () => {
    setLoadingConns(true);
    try {
      const data = await sshHostsAPI.listConnections() as SshConnection[];
      setConnections(data || []);
    } catch (err) {
      message.error(`加载远程连接失败: ${asApiError(err).message || '未知错误'}`);
    } finally {
      setLoadingConns(false);
    }
  }, []);

  const fetchWorkspaces = useCallback(async () => {
    setLoadingWorkspaces(true);
    try {
      const data = await sshHostsAPI.listWorkspaces() as SshWorkspace[];
      setWorkspaces(data || []);
    } catch (err) {
      message.error(`加载工作空间失败: ${asApiError(err).message || '未知错误'}`);
    } finally {
      setLoadingWorkspaces(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
    fetchWorkspaces();
  }, [fetchConnections, fetchWorkspaces]);

  /** 新建（editing 为空）或更新连接；成功返回 true。 */
  const saveConnection = async (editing: SshConnection | null, values: Record<string, unknown>): Promise<boolean> => {
    try {
      if (editing) {
        await sshHostsAPI.updateConnection(editing.id, values);
        message.success('更新远程连接配置成功');
      } else {
        await sshHostsAPI.createConnection(values);
        message.success('添加远程连接成功');
      }
      await fetchConnections();
      return true;
    } catch (err) {
      const error = asApiError(err);
      message.error(`保存失败: ${error.response?.data?.message || error.message || '未知错误'}`);
      return false;
    }
  };

  const deleteConnection = async (id: string) => {
    try {
      await sshHostsAPI.deleteConnection(id);
      message.success('删除连接成功');
      fetchConnections();
      fetchWorkspaces(); // 级联删除，同时刷新工作空间
    } catch (err) {
      message.error(`删除失败: ${asApiError(err).message || '未知错误'}`);
    }
  };

  const testConnection = async (conn: SshConnection) => {
    setTestStates((prev) => ({ ...prev, [conn.id]: { loading: true } }));
    try {
      const result = await sshHostsAPI.testConnection({
        connectionId: conn.id,
        timeoutMs: 5000
      });
      setTestStates((prev) => ({ ...prev, [conn.id]: { loading: false, result } }));
    } catch (err) {
      const error = asApiError(err);
      setTestStates((prev) => ({
        ...prev,
        [conn.id]: {
          loading: false,
          result: {
            status: 'unreachable',
            target: conn.host,
            stderr: error.response?.data?.message || error.message || '连接超时，无法建立 SSH 连接。'
          }
        }
      }));
    }
  };

  /** 新建（editing 为空）或更新工作空间；成功返回 true。 */
  const saveWorkspace = async (editing: SshWorkspace | null, values: Record<string, unknown>): Promise<boolean> => {
    try {
      if (editing) {
        await sshHostsAPI.updateWorkspace(editing.id, values);
        message.success('更新工作空间配置成功');
      } else {
        await sshHostsAPI.createWorkspace(values);
        message.success('工作空间创建成功');
      }
      await fetchWorkspaces();
      return true;
    } catch (err) {
      const error = asApiError(err);
      message.error(`保存工作区失败: ${error.response?.data?.message || error.message || '未知错误'}`);
      return false;
    }
  };

  const deleteWorkspace = async (id: string) => {
    try {
      await sshHostsAPI.deleteWorkspace(id);
      message.success('工作空间已移除 (远端磁盘数据未受影响)');
      fetchWorkspaces();
    } catch (err) {
      message.error(`移除失败: ${asApiError(err).message || '未知错误'}`);
    }
  };

  const testingIds = Object.entries(testStates).filter(([, state]) => state.loading).map(([id]) => id);

  return {
    connections,
    workspaces,
    loadingConns,
    loadingWorkspaces,
    testStates,
    testingIds,
    fetchConnections,
    fetchWorkspaces,
    saveConnection,
    deleteConnection,
    testConnection,
    saveWorkspace,
    deleteWorkspace
  };
}

/**
 * 远程目录浏览器（sshHostsAPI.browseSshDirectory）：打开 / 逐级加载 / 选定目录。
 * 行为与桌面一致：接口返回 ok=false 只提示；请求异常则提示并关闭浏览器。
 */
export function useSshDirectoryBrowser() {
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [dirs, setDirs] = useState<RemoteDirItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState('');

  const loadDirectory = async (targetConnectionId: string, subDir: string) => {
    setLoading(true);
    try {
      const res = await sshHostsAPI.browseSshDirectory({ connectionId: targetConnectionId, subDir });
      if (res.ok) {
        setCurrentPath(res.currentDir);
        setParentPath(res.parentDir);
        setDirs(res.directories || []);
        setSelectedPath(res.currentDir);
      } else {
        message.error(res.message || '加载远程目录失败');
      }
    } catch (err) {
      const error = asApiError(err);
      message.error(`远程执行失败: ${error.response?.data?.message || error.message || '无法建立 SSH 连接，请先在下方测试该连接。'}`);
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  /** 打开浏览器（需先在工作空间表单里选定 SSH 连接）。 */
  const openFor = (targetConnectionId: string) => {
    if (!targetConnectionId) {
      message.warning('请先选择一个远程 SSH 连接');
      return;
    }
    setConnectionId(targetConnectionId);
    setSelectedPath('');
    setCurrentPath('');
    setDirs([]);
    setOpen(true);
    loadDirectory(targetConnectionId, '');
  };

  const navigate = (path: string) => loadDirectory(connectionId, path);

  /** 确认选定路径；返回选定路径（未选择时提示并返回空串）。 */
  const confirm = () => {
    if (!selectedPath) {
      message.warning('请选择一个目录');
      return '';
    }
    setOpen(false);
    return selectedPath;
  };

  return {
    open,
    close: () => setOpen(false),
    connectionId,
    currentPath,
    parentPath,
    dirs,
    loading,
    selectedPath,
    select: setSelectedPath,
    openFor,
    navigate,
    confirm
  };
}
