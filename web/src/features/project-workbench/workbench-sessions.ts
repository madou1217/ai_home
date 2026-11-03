import type { AggregatedProject, Session } from '@/types';

/**
 * 左栏 Sessions 页签数据源：直接取 canonical 目录（Chat.tsx 的
 * canonicalDirectory.projects）中当前项目的会话组，数据已按项目聚合
 * 并按活跃度倒序，这里只做按 projectPath 的定位，不再排序/请求。
 */
export function resolveWorkbenchSessions(
  projects: readonly AggregatedProject[],
  projectPath?: string,
): readonly Session[] {
  const path = String(projectPath || '').trim();
  if (!path) return [];
  return projects.find((project) => project.path === path)?.sessions ?? [];
}
