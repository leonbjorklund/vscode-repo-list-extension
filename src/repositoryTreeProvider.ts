import * as vscode from "vscode";

import { COMMAND_OPEN_REPOSITORY } from "./constants";
import { normalizeRepositoryPath, type RepositoryEntry } from "./repository";
import type { RepoGroup } from "./repositoryGroup";
import { getConfiguredShowPathsByDefault } from "./settings";

export interface RepositorySource {
  getRepositories(): RepositoryEntry[];
  getGroups(): RepoGroup[];
}

export type PathExists = (repoPath: string) => Thenable<boolean>;
export type WorkspaceFolderPaths = () => readonly string[];
export type ShowPathsByDefault = () => boolean;
export type RepositoryIconPath = vscode.Uri | { light: vscode.Uri; dark: vscode.Uri };
export type RepositoryTreeElement = GroupTreeItem | RepositoryTreeItem;
const PATH_STAT_CONCURRENCY = 16;

export function isDirectoryFileType(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.Directory) !== 0;
}

export async function vscodePathExists(repoPath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(repoPath));
    return isDirectoryFileType(stat.type);
  } catch {
    return false;
  }
}

export class RepositoryTreeProvider implements vscode.TreeDataProvider<RepositoryTreeElement> {
  private readonly changeEmitter = new vscode.EventEmitter<RepositoryTreeElement | undefined>();
  private readonly getWorkspaceFolderPaths: WorkspaceFolderPaths;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly source: RepositorySource,
    private readonly pathExists: PathExists = vscodePathExists,
    workspaceFolderPaths?: WorkspaceFolderPaths,
    private readonly activeRepositoryIconPath?: RepositoryIconPath,
    private readonly showPathsByDefault: ShowPathsByDefault = getConfiguredShowPathsByDefault,
  ) {
    this.getWorkspaceFolderPaths = workspaceFolderPaths ?? getWorkspaceFolderPaths;
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: RepositoryTreeElement): RepositoryTreeElement {
    return element;
  }

  async getChildren(element?: RepositoryTreeElement): Promise<RepositoryTreeElement[]> {
    const repositories = this.source.getRepositories();
    const groups = this.source.getGroups();

    if (element instanceof GroupTreeItem) {
      return this.createChildren(element.group.id, groups, repositories);
    }

    if (element) {
      return [];
    }

    return this.createChildren(undefined, groups, repositories);
  }

  private async createChildren(
    parentId: string | undefined,
    groups: RepoGroup[],
    repositories: RepositoryEntry[],
  ): Promise<RepositoryTreeElement[]> {
    const childGroups = groups.filter((group) => group.parentId === parentId);
    const repositoryCountByGroupId = createRepositoryCountByGroupId(groups, repositories);
    const childGroupCountByGroupId = createChildGroupCountByGroupId(groups);
    const groupItems = await mapWithConcurrency(
      childGroups.map((group, index) => ({ group, index })),
      PATH_STAT_CONCURRENCY,
      async ({ group, index }) => ({
        item: new GroupTreeItem(group, repositoryCountByGroupId.get(group.id) ?? 0, {
          childGroupCount: childGroupCountByGroupId.get(group.id) ?? 0,
          sourcePathExists: group.sourcePath === undefined ? false : await this.pathExists(group.sourcePath),
        }),
        order: group.order,
        fallbackOrder: index,
      }),
    );
    const repositoryItems = (
      await this.createRepositoryItems(
        repositories.filter((repository) => repository.groupId === parentId),
      )
    ).map((item, index) => ({
      item,
      order: item.repository.order,
      fallbackOrder: childGroups.length + index,
    }));

    return [...groupItems, ...repositoryItems]
      .sort((left, right) => compareTreeOrder(left, right))
      .map((entry) => entry.item);
  }

  private async createRepositoryItems(
    repositories: RepositoryEntry[],
  ): Promise<RepositoryTreeItem[]> {
    const workspaceFolderPaths = this.getWorkspaceFolderPaths();
    const showPathsByDefault = this.showPathsByDefault();
    return mapWithConcurrency(
      repositories,
      PATH_STAT_CONCURRENCY,
      async (repository) =>
        new RepositoryTreeItem(
          repository,
          await this.pathExists(repository.path),
          isRepositoryActive(repository.path, workspaceFolderPaths),
          this.activeRepositoryIconPath,
          showPathsByDefault,
        ),
    );
  }
}

export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly group: RepoGroup,
    public readonly repositoryCount: number,
    options: { childGroupCount?: number; sourcePathExists?: boolean } = {},
  ) {
    super(group.name, vscode.TreeItemCollapsibleState.Expanded);

    const childGroupCount = options.childGroupCount ?? 0;
    this.id = `group:${group.id}`;
    this.description = formatRepositoryCount(repositoryCount);
    this.tooltip = group.name;
    this.contextValue = formatGroupContextValue(group, repositoryCount, childGroupCount, options.sourcePathExists ?? false);
    this.iconPath = new vscode.ThemeIcon("folder");
    this.childGroupCount = childGroupCount;
  }

  public readonly childGroupCount: number;
}

export class RepositoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly repository: RepositoryEntry,
    exists: boolean,
    active = false,
    activeIconPath?: RepositoryIconPath,
    showPathsByDefault = false,
  ) {
    super(
      formatRepositoryLabel(repository.name, exists && active),
      vscode.TreeItemCollapsibleState.None,
    );

    const showPath = isRepositoryPathVisible(repository, showPathsByDefault);
    this.id = `repository:${repository.id}`;
    this.description = formatRepositoryDescription(repository.path, exists, showPath);
    this.tooltip = repository.path;
    this.contextValue = formatRepositoryContextValue(showPath, exists);
    this.iconPath = getRepositoryIcon(exists, active, activeIconPath);
    this.command = {
      command: COMMAND_OPEN_REPOSITORY,
      title: "Open in Code",
      arguments: [repository],
    };
  }
}

export function isRepositoryPathVisible(
  repository: RepositoryEntry,
  showPathsByDefault = false,
): boolean {
  return repository.showPath ?? showPathsByDefault;
}

function getRepositoryIcon(
  exists: boolean,
  active: boolean,
  activeIconPath: RepositoryIconPath | undefined,
): NonNullable<vscode.TreeItem["iconPath"]> {
  if (!exists) {
    return new vscode.ThemeIcon("warning");
  }

  if (active && activeIconPath) {
    return activeIconPath;
  }

  return new vscode.ThemeIcon("repo");
}

function formatRepositoryLabel(repositoryName: string, active: boolean): string {
  return active ? `${repositoryName} | Active` : repositoryName;
}

function formatRepositoryDescription(
  repositoryPath: string,
  exists: boolean,
  showPath: boolean,
): string {
  if (exists) {
    return showPath ? repositoryPath : "";
  }

  return showPath ? `${repositoryPath} (missing)` : "(missing)";
}

function formatGroupContextValue(
  group: RepoGroup,
  repositoryCount: number,
  childGroupCount: number,
  sourcePathExists: boolean,
): string {
  const isEmpty = repositoryCount === 0 && childGroupCount === 0;
  if (group.sourcePath !== undefined && sourcePathExists) {
    return isEmpty ? "emptyFolderSourceGroup" : "folderSourceGroup";
  }

  return isEmpty ? "emptyGroup" : "group";
}

function formatRepositoryContextValue(showPath: boolean, exists: boolean): string {
  return `${exists ? "repository" : "missingRepository"}Path${showPath ? "Visible" : "Hidden"}`;
}

export function getWorkspaceFolderPaths(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}

export function isRepositoryActive(
  repositoryPath: string,
  workspaceFolderPaths: readonly string[],
): boolean {
  const normalizedRepositoryPath = normalizeComparablePath(repositoryPath);

  return workspaceFolderPaths.some((workspaceFolderPath) => {
    const normalizedWorkspaceFolderPath = normalizeComparablePath(workspaceFolderPath);
    return (
      normalizedWorkspaceFolderPath === normalizedRepositoryPath ||
      normalizedWorkspaceFolderPath.startsWith(
        `${normalizedRepositoryPath}${getPathSeparator(normalizedRepositoryPath)}`,
      )
    );
  });
}

function normalizeComparablePath(value: string): string {
  return trimTrailingPathSeparators(normalizeRepositoryPath(value));
}

function trimTrailingPathSeparators(value: string): string {
  return value.replace(/[\\/]+$/, "");
}

function getPathSeparator(value: string): string {
  return value.includes("\\") ? "\\" : "/";
}

function formatRepositoryCount(repositoryCount: number): string {
  return `${repositoryCount} ${repositoryCount === 1 ? "repository" : "repositories"}`;
}

function compareTreeOrder(
  left: { order: number | undefined; fallbackOrder: number },
  right: { order: number | undefined; fallbackOrder: number },
): number {
  if (left.order !== undefined && right.order !== undefined) {
    return left.order - right.order;
  }
  if (left.order !== undefined) {
    return left.order - right.fallbackOrder;
  }
  if (right.order !== undefined) {
    return left.fallbackOrder - right.order;
  }

  return left.fallbackOrder - right.fallbackOrder;
}

function createRepositoryCountByGroupId(
  groups: RepoGroup[],
  repositories: RepositoryEntry[],
): Map<string, number> {
  const directCounts = new Map<string, number>();
  for (const repository of repositories) {
    if (repository.groupId === undefined) {
      continue;
    }

    directCounts.set(repository.groupId, (directCounts.get(repository.groupId) ?? 0) + 1);
  }

  const childIdsByParentId = new Map<string, string[]>();
  for (const group of groups) {
    if (group.parentId === undefined) {
      continue;
    }

    childIdsByParentId.set(group.parentId, [
      ...(childIdsByParentId.get(group.parentId) ?? []),
      group.id,
    ]);
  }

  const counts = new Map<string, number>();
  const countGroup = (groupId: string): number => {
    const existing = counts.get(groupId);
    if (existing !== undefined) {
      return existing;
    }

    const count =
      (directCounts.get(groupId) ?? 0) +
      (childIdsByParentId.get(groupId) ?? []).reduce(
        (total, childId) => total + countGroup(childId),
        0,
      );
    counts.set(groupId, count);
    return count;
  };

  groups.forEach((group) => countGroup(group.id));

  return counts;
}

function createChildGroupCountByGroupId(groups: RepoGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    if (group.parentId === undefined) {
      continue;
    }

    counts.set(group.parentId, (counts.get(group.parentId) ?? 0) + 1);
  }

  return counts;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapItem: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapItem(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
}
