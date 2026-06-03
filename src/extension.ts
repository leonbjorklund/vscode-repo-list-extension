import * as vscode from 'vscode';

import {
  COMMAND_ADD_REPOSITORY,
  COMMAND_ADD_REPOSITORY_AT_ROOT,
  COMMAND_CREATE_GROUP,
  COMMAND_CREATE_ROOT_GROUP,
  COMMAND_DELETE_SELECTED_ITEM,
  COMMAND_DISABLE_OPEN_IN_NEW_WINDOW,
  COMMAND_DISABLE_SHOW_PATHS_BY_DEFAULT,
  COMMAND_ENABLE_OPEN_IN_NEW_WINDOW,
  COMMAND_ENABLE_SHOW_PATHS_BY_DEFAULT,
  COMMAND_HIDE_REPOSITORY_PATH,
  COMMAND_MOVE_REPOSITORY_TO_GROUP,
  COMMAND_OPEN_REPOSITORY,
  COMMAND_REVEAL_IN_FILE_EXPLORER,
  COMMAND_RENAME_GROUP,
  COMMAND_SHOW_REPOSITORY_PATH,
  COMMAND_UNGROUP_SELECTED_GROUP,
  CONFIG_SECTION,
  DEFAULT_SCAN_EXCLUDES,
  SCAN_EXCLUDE_CONFIG_KEY,
  SHOW_PATHS_BY_DEFAULT_CONFIG_KEY,
  VIEW_ID
} from './constants';
import { openRepository } from './openRepository';
import { RepositoryDragAndDropController } from './repositoryDragAndDrop';
import { discoverRepositoriesFromFolders } from './repositoryDiscovery';
import { isRepositoryEntry, type RepositoryEntry } from './repository';
import { hasDuplicateSiblingGroupName, normalizeGroupName, type RepoGroup } from './repositoryGroup';
import { RepositoryStore, type AddFolderSourceResult } from './repositoryStore';
import { GroupTreeItem, RepositoryTreeItem, RepositoryTreeProvider } from './repositoryTreeProvider';
import {
  getConfiguredShowPathsByDefault,
  updateConfiguredOpenBehavior,
  updateConfiguredShowPathsByDefault
} from './settings';

const CREATE_GROUP_QUICK_PICK_LABEL = '$(add) Create group';
const UNGROUP_QUICK_PICK_LABEL = '$(remove) Ungroup';

export interface RepositoryProgressDependencies {
  withProgress<R>(
    options: vscode.ProgressOptions,
    task: (
      progress: vscode.Progress<{ increment: number; message: string }>,
      token: vscode.CancellationToken
    ) => Thenable<R> | Promise<R>
  ): Thenable<R> | Promise<R>;
}

export interface DeleteSelectedTreeItemDependencies {
  removeGroup(groupId: string): Thenable<boolean> | Promise<boolean>;
  removeRepository(repositoryId: string): Thenable<boolean> | Promise<boolean>;
  refresh(): void;
  showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
}

export interface RevealInFileExplorerDependencies {
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | Promise<unknown>;
  showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
}

export type GroupQuickPickItem = vscode.QuickPickItem & (
  | { itemType: 'group'; groupId: string }
  | { itemType: 'createGroup'; groupId?: undefined }
  | { itemType: 'createTypedGroup'; groupName: string; groupId?: undefined }
  | { itemType: 'ungroup'; groupId?: undefined }
);

export function getRepositoryArgument(
  argument: unknown
): RepositoryEntry | undefined {
  if (!argument) {
    return undefined;
  }

  if (argument instanceof RepositoryTreeItem) {
    return argument.repository;
  }

  return isRepositoryEntry(argument) ? argument : undefined;
}

export function getGroupArgument(argument: unknown): RepoGroup | undefined {
  if (!argument) {
    return undefined;
  }

  if (argument instanceof GroupTreeItem) {
    return argument.group;
  }

  return undefined;
}

async function confirmManualRepository(repositoryPath: string): Promise<string[]> {
  const confirmation = await vscode.window.showWarningMessage(
    'No Git repository found. Add this folder anyway?',
    { modal: true },
    'Add Folder'
  );

  return confirmation === 'Add Folder' ? [repositoryPath] : [];
}

async function showAddRepositoriesResult(added: RepositoryEntry[]): Promise<void> {
  if (added.length === 1) {
    await vscode.window.showInformationMessage(`Added repository: ${added[0].name}`);
  } else if (added.length > 1) {
    await vscode.window.showInformationMessage(`Added ${added.length} repositories.`);
  }
}

export function runRepositoryOperationWithProgress<T>(
  title: string,
  task: (token: vscode.CancellationToken) => Thenable<T> | Promise<T>,
  dependencies: RepositoryProgressDependencies = vscode.window
): Promise<T> {
  return Promise.resolve(dependencies.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true
    },
    (_progress, token) => task(token)
  ));
}

function getScanExcludedFolderNames(): string[] {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string[]>(SCAN_EXCLUDE_CONFIG_KEY, DEFAULT_SCAN_EXCLUDES);
}

export function validateNewGroupName(
  value: string,
  groups: RepoGroup[],
  parentId?: string,
  exceptGroupId?: string
): string | undefined {
  if (!normalizeGroupName(value)) {
    return 'Group name cannot be empty.';
  }

  return hasDuplicateSiblingGroupName(groups, value, parentId, exceptGroupId)
    ? 'Group name already exists.'
    : undefined;
}

export function buildTypedCreateGroupQuickPickItem(
  value: string | undefined,
  groups: RepoGroup[],
  parentId?: string
): GroupQuickPickItem | undefined {
  const groupName = normalizeGroupName(value ?? '');
  if (!groupName) {
    return undefined;
  }

  if (hasDuplicateSiblingGroupName(groups, groupName, parentId)) {
    return undefined;
  }

  return {
    label: `$(add) Create "${groupName}"`,
    itemType: 'createTypedGroup',
    groupName,
    alwaysShow: true
  };
}

export function getRepositorySiblingOrder(
  repository: RepositoryEntry,
  groups: RepoGroup[],
  repositories: RepositoryEntry[]
): number | undefined {
  if (repository.order !== undefined) {
    return repository.order;
  }

  const siblingRepositories = repositories.filter((candidate) => candidate.groupId === repository.groupId);
  const repositoryIndex = siblingRepositories.findIndex((candidate) => candidate.id === repository.id);
  if (repositoryIndex === -1) {
    return undefined;
  }

  return groups.filter((group) => group.parentId === repository.groupId).length + repositoryIndex;
}

export function buildGroupQuickPickItems(
  groups: RepoGroup[],
  includeUngroup: boolean,
  value?: string,
  parentId?: string,
  excludedGroupId?: string
): GroupQuickPickItem[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const targetGroups = groups.filter((group) => group.id !== excludedGroupId);
  const items: GroupQuickPickItem[] = [
    ...targetGroups.map((group) => ({
      label: group.name,
      description: getGroupParentPath(group, groupById),
      itemType: 'group' as const,
      groupId: group.id
    })),
    { label: CREATE_GROUP_QUICK_PICK_LABEL, itemType: 'createGroup' },
    ...(includeUngroup ? [{ label: UNGROUP_QUICK_PICK_LABEL, itemType: 'ungroup' as const }] : [])
  ];
  const typedCreateItem = buildTypedCreateGroupQuickPickItem(value, groups, parentId);
  if (!typedCreateItem) {
    return items;
  }

  return hasGroupMatchingFilter(targetGroups, value) ? [...items, typedCreateItem] : [typedCreateItem, ...items];
}

function getGroupParentPath(group: RepoGroup, groupById: Map<string, RepoGroup>): string | undefined {
  const parentNames: string[] = [];
  const visited = new Set<string>([group.id]);
  let parent = group.parentId === undefined ? undefined : groupById.get(group.parentId);

  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    parentNames.unshift(parent.name);
    parent = parent.parentId === undefined ? undefined : groupById.get(parent.parentId);
  }

  return parentNames.length > 0 ? parentNames.join(' / ') : undefined;
}

function hasGroupMatchingFilter(groups: RepoGroup[], value: string | undefined): boolean {
  const normalizedValue = normalizeGroupName(value ?? '');
  if (!normalizedValue) {
    return false;
  }

  return groups.some((group) => groupNameMatchesFilter(group.name, normalizedValue));
}

function groupNameMatchesFilter(groupName: string, filter: string): boolean {
  const normalizedGroupName = groupName.toLowerCase();
  const normalizedFilter = filter.toLowerCase();

  if (normalizedGroupName.includes(normalizedFilter)) {
    return true;
  }

  let groupIndex = 0;
  for (const character of normalizedFilter) {
    groupIndex = normalizedGroupName.indexOf(character, groupIndex);
    if (groupIndex === -1) {
      return false;
    }

    groupIndex += 1;
  }

  return true;
}

function showGroupQuickPick(
  groups: RepoGroup[],
  includeUngroup: boolean,
  parentId?: string,
  excludedGroupId?: string
): Promise<GroupQuickPickItem | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<GroupQuickPickItem>();
    const disposables: vscode.Disposable[] = [];
    let settled = false;

    const updateItems = (value: string): void => {
      const items = buildGroupQuickPickItems(groups, includeUngroup, value, parentId, excludedGroupId);
      const typedCreateItem = items.find((item) => item.itemType === 'createTypedGroup');
      const matchingGroupItem = items.find((item) =>
        item.itemType === 'group' && groupNameMatchesFilter(item.label, normalizeGroupName(value) ?? '')
      );

      quickPick.items = items;
      if (typedCreateItem && items[0] === typedCreateItem) {
        quickPick.activeItems = [typedCreateItem];
      } else if (matchingGroupItem) {
        quickPick.activeItems = [matchingGroupItem];
      } else {
        quickPick.activeItems = [];
      }
    };
    const settle = (item: GroupQuickPickItem | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(item);
      quickPick.hide();
    };

    quickPick.title = 'Move to Group';
    quickPick.placeholder = 'Select or type a group';

    disposables.push(
      quickPick.onDidChangeValue(updateItems),
      quickPick.onDidAccept(() => {
        const selectedItem = quickPick.activeItems[0] ?? buildTypedCreateGroupQuickPickItem(quickPick.value, groups, parentId);
        if (selectedItem) {
          settle(selectedItem);
        }
      }),
      quickPick.onDidHide(() => {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }

        for (const disposable of disposables) {
          disposable.dispose();
        }
        quickPick.dispose();
      })
    );

    updateItems('');
    quickPick.show();
  });
}

export async function deleteSelectedTreeItem(
  argument: unknown,
  dependencies: DeleteSelectedTreeItemDependencies
): Promise<void> {
  const repository = getRepositoryArgument(argument);
  if (repository) {
    const removed = await dependencies.removeRepository(repository.id);
    dependencies.refresh();

    if (!removed) {
      await dependencies.showErrorMessage(`Could not remove repository: ${repository.name}`);
    }
    return;
  }

  if (argument instanceof GroupTreeItem) {
    const group = argument.group;
    const deleted = await dependencies.removeGroup(group.id);
    dependencies.refresh();

    if (!deleted) {
      await dependencies.showErrorMessage(`Could not update group: ${group.name}`);
    }
    return;
  }

  await dependencies.showErrorMessage('Select a repository or group first.');
}

export async function revealInFileExplorer(
  argument: unknown,
  dependencies: RevealInFileExplorerDependencies = {
    executeCommand: (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args),
    showErrorMessage: (message: string) => vscode.window.showErrorMessage(message)
  }
): Promise<void> {
  const repository = getRepositoryArgument(argument);
  const group = getGroupArgument(argument);
  const targetPath = repository?.path ?? group?.sourcePath;

  if (!targetPath) {
    await dependencies.showErrorMessage('Select a repository or folder first.');
    return;
  }

  await dependencies.executeCommand('revealFileInOS', vscode.Uri.file(targetPath));
}

function registerRepositoryCommands(
  context: vscode.ExtensionContext,
  store: RepositoryStore,
  treeProvider: RepositoryTreeProvider,
  treeView: vscode.TreeView<RepositoryTreeItem | GroupTreeItem>
): void {
  const refreshRepositories = (): void => {
    treeProvider.refresh();
  };

  const getSelectedGroupItem = (argument?: unknown): GroupTreeItem | undefined => {
    if (argument instanceof GroupTreeItem) {
      return argument;
    }

    const selectedItem = treeView.selection[0];
    return selectedItem instanceof GroupTreeItem ? selectedItem : undefined;
  };

  const getManualGroupName = async (
    parentId?: string,
    typedGroupName?: string
  ): Promise<string | undefined> => {
    return typedGroupName ?? await vscode.window.showInputBox({
      title: 'Create Group',
      prompt: 'Enter a group name.',
      validateInput: (value) => validateNewGroupName(value, store.getGroups(), parentId)
    });
  };

  const createManualGroupFromName = async (
    groupName: string,
    parentId?: string,
    order?: number
  ): Promise<RepoGroup | undefined> => {
    const group = await store.createGroup(groupName, parentId, order);
    if (!group) {
      await vscode.window.showErrorMessage(`Could not create group: ${groupName}`);
      return undefined;
    }

    return group;
  };

  const addSelectedFolders = async (argument?: GroupTreeItem): Promise<void> => {
    const targetGroup = getGroupArgument(argument);

    const selectedFolders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add'
    });

    if (!selectedFolders) {
      return;
    }

    const discovery = await runRepositoryOperationWithProgress(
      'Scanning repositories',
      (token) => discoverRepositoriesFromFolders(
        selectedFolders,
        vscode.workspace.fs,
        token,
        {
          excludedFolderNames: getScanExcludedFolderNames(),
          collapseRedundantFolderSources: true
        }
      )
    );
    const manualRepositoryPaths =
      discovery.manualRepositoryPaths.length === 0 && discovery.manualCandidatePaths.length === 1
        ? await confirmManualRepository(discovery.manualCandidatePaths[0])
        : discovery.manualRepositoryPaths;

    if (manualRepositoryPaths.length === 0 && discovery.folderSources.length === 0) {
      await vscode.window.showInformationMessage('No Git repositories found.');
      return;
    }

    const manualRepositories = await store.addRepositories(manualRepositoryPaths, targetGroup?.id);
    const folderResults: AddFolderSourceResult[] = [];
    for (const source of discovery.folderSources) {
      folderResults.push(await store.addFolderSource(source, targetGroup?.id));
    }

    refreshRepositories();
    await showAddRepositoriesResult([
      ...manualRepositories,
      ...folderResults.flatMap((result) => result.addedRepositories)
    ]);
  };

  const deleteSelected = async (argument?: unknown): Promise<void> => {
    await deleteSelectedTreeItem(argument ?? treeView.selection[0], {
      removeGroup: (groupId) => store.removeGroup(groupId),
      removeRepository: (repositoryId) => store.removeRepository(repositoryId),
      refresh: refreshRepositories,
      showErrorMessage: (message) => vscode.window.showErrorMessage(message)
    });
  };

  const ungroupSelectedGroup = async (argument?: unknown): Promise<void> => {
    const item = getSelectedGroupItem(argument);
    if (!item) {
      await vscode.window.showErrorMessage('Select a group first.');
      return;
    }

    const ungrouped = await store.ungroupGroup(item.group.id);
    refreshRepositories();

    if (!ungrouped) {
      await vscode.window.showErrorMessage(`Could not ungroup: ${item.group.name}`);
    }
  };

  const setRepositoryPathVisibility = async (
    argument: unknown,
    showPath: boolean
  ): Promise<void> => {
    const repository = getRepositoryArgument(argument ?? treeView.selection[0]);

    if (!repository) {
      await vscode.window.showErrorMessage('Select a repository first.');
      return;
    }

    const updated = await store.setRepositoryPathVisibility(
      repository.id,
      showPath,
      getConfiguredShowPathsByDefault()
    );
    refreshRepositories();

    if (!updated) {
      await vscode.window.showErrorMessage(`Could not update repository path visibility: ${repository.name}`);
    }
  };

  const createGroup = async (argument?: GroupTreeItem): Promise<void> => {
    const parentId = getGroupArgument(argument)?.id;
    const groupName = await getManualGroupName(parentId);
    if (groupName === undefined) {
      return;
    }

    await createManualGroupFromName(groupName, parentId);
    refreshRepositories();
  };

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand(COMMAND_ADD_REPOSITORY, addSelectedFolders),
    vscode.commands.registerCommand(COMMAND_ADD_REPOSITORY_AT_ROOT, async () => addSelectedFolders(undefined)),
    vscode.commands.registerCommand(COMMAND_ENABLE_OPEN_IN_NEW_WINDOW, async () => updateConfiguredOpenBehavior('newWindow')),
    vscode.commands.registerCommand(COMMAND_DISABLE_OPEN_IN_NEW_WINDOW, async () => updateConfiguredOpenBehavior('sameWindow')),
    vscode.commands.registerCommand(COMMAND_ENABLE_SHOW_PATHS_BY_DEFAULT, async () => updateConfiguredShowPathsByDefault(true)),
    vscode.commands.registerCommand(COMMAND_DISABLE_SHOW_PATHS_BY_DEFAULT, async () => updateConfiguredShowPathsByDefault(false)),
    vscode.commands.registerCommand(COMMAND_CREATE_GROUP, createGroup),
    vscode.commands.registerCommand(COMMAND_CREATE_ROOT_GROUP, async () => createGroup(undefined)),
    vscode.commands.registerCommand(COMMAND_RENAME_GROUP, async (argument?: GroupTreeItem) => {
      const group = getSelectedGroupItem(argument)?.group;

      if (!group) {
        await vscode.window.showErrorMessage('Select a group first.');
        return;
      }

      const newName = await vscode.window.showInputBox({
        title: 'Rename Group',
        prompt: 'Enter a new group name.',
        value: group.name,
        validateInput: (value) => validateNewGroupName(value, store.getGroups(), group.parentId, group.id)
      });

      if (newName === undefined) {
        return;
      }

      const renamed = await store.renameGroup(group.id, newName);
      refreshRepositories();

      if (!renamed) {
        await vscode.window.showErrorMessage(`Could not rename group: ${group.name}`);
      }
    }),
    vscode.commands.registerCommand(COMMAND_DELETE_SELECTED_ITEM, async (argument?: unknown) => {
      await deleteSelected(argument);
    }),
    vscode.commands.registerCommand(COMMAND_UNGROUP_SELECTED_GROUP, async (argument?: unknown) => {
      await ungroupSelectedGroup(argument);
    }),
    vscode.commands.registerCommand(
      COMMAND_MOVE_REPOSITORY_TO_GROUP,
      async (argument?: RepositoryEntry | RepositoryTreeItem) => {
        const repository = getRepositoryArgument(argument);

        if (!repository) {
          await vscode.window.showErrorMessage('Select a repository first.');
          return;
        }

        const groups = store.getGroups();
        const repositories = store.getRepositories();
        const currentRepository = repositories.find((candidate) => candidate.id === repository.id) ?? repository;
        const currentGroup = groups.find((group) => group.id === currentRepository.groupId);
        const selectedGroup = await showGroupQuickPick(
          groups,
          currentRepository.groupId !== undefined,
          currentGroup?.id,
          currentGroup?.id
        );

        if (!selectedGroup) {
          return;
        }

        let targetGroupId = selectedGroup.groupId;
        let newGroupName: string | undefined;
        if (selectedGroup.itemType === 'createGroup' || selectedGroup.itemType === 'createTypedGroup') {
          newGroupName = await getManualGroupName(
            currentGroup?.id,
            selectedGroup.itemType === 'createTypedGroup' ? selectedGroup.groupName : undefined
          );
          if (newGroupName === undefined) {
            return;
          }
        }

        const moved = await (async () => {
          if (newGroupName !== undefined) {
            const createdGroup = await createManualGroupFromName(
              newGroupName,
              currentGroup?.id,
              getRepositorySiblingOrder(currentRepository, groups, repositories)
            );
            if (!createdGroup) {
              return false;
            }

            targetGroupId = createdGroup.id;
          }

          return store.moveRepositoryToGroup(repository.id, targetGroupId);
        })();
        refreshRepositories();

        if (!moved) {
          await vscode.window.showErrorMessage(`Could not move repository: ${repository.name}`);
        }
      }
    ),
    vscode.commands.registerCommand(COMMAND_SHOW_REPOSITORY_PATH, async (argument?: unknown) => {
      await setRepositoryPathVisibility(argument, true);
    }),
    vscode.commands.registerCommand(COMMAND_HIDE_REPOSITORY_PATH, async (argument?: unknown) => {
      await setRepositoryPathVisibility(argument, false);
    }),
    vscode.commands.registerCommand(COMMAND_OPEN_REPOSITORY, async (argument?: RepositoryEntry | RepositoryTreeItem) => {
      const repository = getRepositoryArgument(argument);

      if (!repository) {
        await vscode.window.showErrorMessage('Select a repository first.');
        return;
      }

      await openRepository(repository);
    }),
    vscode.commands.registerCommand(COMMAND_REVEAL_IN_FILE_EXPLORER, async (argument?: unknown) => {
      await revealInFileExplorer(argument ?? treeView.selection[0]);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.${SHOW_PATHS_BY_DEFAULT_CONFIG_KEY}`)) {
        refreshRepositories();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshRepositories();
    })
  );
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = await RepositoryStore.create(context);
  const activeRepositoryIconPath = {
    light: vscode.Uri.joinPath(context.extensionUri, 'media', 'repo-active-light.svg'),
    dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'repo-active.svg')
  };
  const treeProvider = new RepositoryTreeProvider(store, undefined, undefined, activeRepositoryIconPath);
  const refreshRepositories = (): void => {
    treeProvider.refresh();
  };

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: treeProvider,
    dragAndDropController: new RepositoryDragAndDropController(store, refreshRepositories)
  });

  registerRepositoryCommands(context, store, treeProvider, treeView);
}
