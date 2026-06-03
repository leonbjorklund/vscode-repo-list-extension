import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createRepositoryEntry,
  repairRepositoryGroupReferences,
  sanitizeRepositories,
  type RepositoryEntry
} from './repository';
import {
  createManualGroup,
  getDescendantGroupIds,
  getGroupDepth,
  hasDuplicateSiblingGroupName,
  MAX_GROUP_DEPTH,
  normalizeGroupName,
  sanitizeGroups,
  type RepoGroup
} from './repositoryGroup';
import type { DiscoveredFolderSource } from './repositoryDiscovery';

export interface RepositoryStorageState {
  groups: unknown[];
  repositories: unknown[];
}

export interface RepositoryStorage {
  read(): RepositoryStorageState;
  write(state: RepositoryStorageState): Thenable<void>;
}

export interface AddFolderSourceResult {
  addedGroups: RepoGroup[];
  addedRepositories: RepositoryEntry[];
}

interface RepositoryStoreState {
  groups: RepoGroup[];
  repositories: RepositoryEntry[];
}

type SiblingRef =
  | { kind: 'group'; id: string; order?: number; fallbackOrder: number; stableIndex: number }
  | { kind: 'repository'; id: string; order?: number; fallbackOrder: number; stableIndex: number };

type SiblingRefKey = `${SiblingRef['kind']}:${string}`;

const STORAGE_FILE_NAME = 'repositories.json';

export class RepositoryGlobalStorage implements RepositoryStorage {
  private constructor(
    private state: RepositoryStorageState,
    private readonly storageUri: vscode.Uri,
    private readonly fileSystem: Pick<typeof vscode.workspace.fs, 'createDirectory' | 'readFile' | 'writeFile'>
  ) {}

  static async create(
    context: vscode.ExtensionContext,
    fileSystem: Pick<typeof vscode.workspace.fs, 'createDirectory' | 'readFile' | 'writeFile'> = vscode.workspace.fs
  ): Promise<RepositoryGlobalStorage> {
    return new RepositoryGlobalStorage(
      await readStorageState(context.globalStorageUri, fileSystem),
      context.globalStorageUri,
      fileSystem
    );
  }

  read(): RepositoryStorageState {
    return this.state;
  }

  async write(state: RepositoryStorageState): Promise<void> {
    await this.fileSystem.createDirectory(this.storageUri);
    await this.fileSystem.writeFile(
      vscode.Uri.joinPath(this.storageUri, STORAGE_FILE_NAME),
      new TextEncoder().encode(JSON.stringify(state, undefined, 2))
    );
    this.state = state;
  }
}

export class RepositoryStore {
  constructor(
    private readonly storage: RepositoryStorage,
    private readonly createId: () => string = randomUUID
  ) {}

  static async create(context: vscode.ExtensionContext): Promise<RepositoryStore> {
    return new RepositoryStore(await RepositoryGlobalStorage.create(context));
  }

  getRepositories(): RepositoryEntry[] {
    return this.readState().repositories;
  }

  getGroups(): RepoGroup[] {
    return this.readState().groups;
  }

  private readState(): RepositoryStoreState {
    const groups = sanitizeGroups(this.getRawGroups());
    return normalizeAllSiblingOrders({
      groups,
      repositories: repairRepositoryGroupReferences(sanitizeRepositories(this.getRawRepositories()), groups)
    });
  }

  private async writeState(state: RepositoryStoreState): Promise<void> {
    await this.storage.write(normalizeAllSiblingOrders(state));
  }

  async addRepositories(repositoryPaths: string[], groupId?: string): Promise<RepositoryEntry[]> {
    const state = this.readState();
    if (groupId !== undefined && !state.groups.some((group) => group.id === groupId)) {
      return [];
    }

    const added: RepositoryEntry[] = [];
    let nextOrder = getNextOrderFrom(state.groups, state.repositories, groupId);

    for (const repositoryPath of repositoryPaths) {
      const absolutePath = getAbsoluteTrimmedPath(repositoryPath);
      if (!absolutePath) {
        continue;
      }

      added.push(createRepositoryEntry(absolutePath, this.createId, groupId, nextOrder));
      nextOrder += 1;
    }

    if (added.length > 0) {
      const nextState = normalizeAllSiblingOrders({ ...state, repositories: [...state.repositories, ...added] });
      await this.writeState(nextState);
      const addedIds = new Set(added.map((repository) => repository.id));
      return nextState.repositories.filter((repository) => addedIds.has(repository.id));
    }

    return added;
  }

  async addFolderSource(source: DiscoveredFolderSource, parentId?: string): Promise<AddFolderSourceResult> {
    const state = this.readState();
    if (!this.canAddFolderSource(source, parentId, state.groups)) {
      return { addedGroups: [], addedRepositories: [] };
    }

    const result = this.buildFolderSourceAdditions(source, parentId, state.groups, state.repositories);

    if (result.addedGroups.length > 0) {
      state.groups = [...state.groups, ...result.addedGroups];
    }
    if (result.addedRepositories.length > 0) {
      state.repositories = [...state.repositories, ...result.addedRepositories];
    }
    if (result.addedGroups.length > 0 || result.addedRepositories.length > 0) {
      await this.writeState(state);
    }

    return result;
  }

  async createGroup(groupName: string, parentId?: string, order?: number): Promise<RepoGroup | undefined> {
    const state = this.readState();
    const normalizedName = normalizeGroupName(groupName);
    if (!normalizedName || !this.canCreateChildGroup(parentId, state.groups)) {
      return undefined;
    }
    if (hasDuplicateSiblingGroupName(state.groups, normalizedName, parentId)) {
      return undefined;
    }

    const group = {
      ...createManualGroup(normalizedName, this.createId, parentId),
      order: order ?? getNextOrderFrom(state.groups, state.repositories, parentId)
    };
    const nextState = normalizeAllSiblingOrders({ ...state, groups: [...state.groups, group] });
    await this.writeState(nextState);
    return nextState.groups.find((candidate) => candidate.id === group.id);
  }

  async renameGroup(groupId: string, newName: string): Promise<boolean> {
    const state = this.readState();
    const group = state.groups.find((candidate) => candidate.id === groupId);
    const normalizedName = normalizeGroupName(newName);
    if (!group || !normalizedName) {
      return false;
    }
    if (hasDuplicateSiblingGroupName(state.groups, normalizedName, group.parentId, group.id)) {
      return false;
    }

    const updatedGroups = state.groups.map((entry) =>
      entry.id === group.id ? { ...entry, name: normalizedName } : entry
    );

    await this.writeState({ ...state, groups: updatedGroups });
    return true;
  }

  async ungroupGroup(groupId: string): Promise<boolean> {
    const state = this.readState();
    const group = state.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return false;
    }
    if (wouldReparentDuplicateChildGroups(group, state.groups)) {
      return false;
    }

    const parentId = group.parentId;
    const parentRefs = getOrderedSiblingRefs(state.groups, state.repositories, parentId);
    const groupIndex = parentRefs.findIndex((entry) => entry.kind === 'group' && entry.id === group.id);
    if (groupIndex === -1) {
      return false;
    }

    const childRefs = getOrderedSiblingRefs(state.groups, state.repositories, group.id);
    const updatedGroups = state.groups.flatMap((entry) => {
      if (entry.id === group.id) {
        return [];
      }
      if (entry.parentId === group.id) {
        return [withParent(entry, group.parentId)];
      }

      return [entry];
    });

    const updatedRepositories = state.repositories.map((entry) =>
      entry.groupId === group.id ? withRepositoryGroup(entry, group.parentId) : entry
    );

    const updatedParentRefs = [
      ...parentRefs.slice(0, groupIndex),
      ...childRefs,
      ...parentRefs.slice(groupIndex + 1)
    ];
    const updatedState = assignSiblingOrders(
      { groups: updatedGroups, repositories: updatedRepositories },
      parentId,
      updatedParentRefs
    );

    await this.writeState(updatedState);
    return true;
  }

  async removeGroup(groupId: string): Promise<boolean> {
    const state = this.readState();
    const group = state.groups.find((candidate) => candidate.id === groupId);
    if (!group) {
      return false;
    }

    const removedGroupIds = new Set([group.id, ...getDescendantGroupIds(state.groups, group.id)]);
    const updatedGroups = state.groups.filter((entry) => !removedGroupIds.has(entry.id));
    const updatedRepositories = state.repositories.filter((entry) =>
      entry.groupId === undefined || !removedGroupIds.has(entry.groupId)
    );

    await this.writeState({ groups: updatedGroups, repositories: updatedRepositories });
    return true;
  }

  async moveGroup(groupId: string, parentId: string | undefined, order?: number): Promise<boolean> {
    const state = this.readState();
    const group = state.groups.find((candidate) => candidate.id === groupId);
    const parent = parentId === undefined ? undefined : state.groups.find((candidate) => candidate.id === parentId);
    if (!group || (parentId !== undefined && !parent)) {
      return false;
    }
    if (parentId === group.id) {
      return false;
    }

    const descendants = new Set(getDescendantGroupIds(state.groups, group.id));
    if (parentId !== undefined && descendants.has(parentId)) {
      return false;
    }
    if (hasDuplicateSiblingGroupName(state.groups, group.name, parentId, group.id)) {
      return false;
    }

    const movedGroups = state.groups.map((candidate) =>
      candidate.id === group.id ? withParent(candidate, parentId) : candidate
    );

    for (const candidate of movedGroups) {
      const depth = getGroupDepth(movedGroups, candidate.id);
      if (depth === undefined || depth > MAX_GROUP_DEPTH) {
        return false;
      }
    }

    const nextOrder = order ?? getNextOrderFrom(state.groups, state.repositories, parentId);
    const updatedGroups = movedGroups.map((entry) =>
      entry.id === group.id ? { ...entry, order: nextOrder } : entry
    );

    await this.writeState({ ...state, groups: updatedGroups });
    return true;
  }

  async moveRepositoryToGroup(repositoryId: string, groupId: string | undefined, order?: number): Promise<boolean> {
    const state = this.readState();
    const repository = state.repositories.find((candidate) => candidate.id === repositoryId);
    const group = groupId === undefined ? undefined : state.groups.find((candidate) => candidate.id === groupId);
    if (!repository) {
      return false;
    }
    if (groupId !== undefined && !group) {
      return false;
    }

    const targetOrder = order ?? getNextOrderFrom(state.groups, state.repositories, groupId);
    const updatedRepositories = state.repositories.map((entry) =>
      entry.id === repository.id ? withRepositoryGroup({ ...entry, order: targetOrder }, groupId) : entry
    );

    await this.writeState({ ...state, repositories: updatedRepositories });
    return true;
  }

  async setRepositoryPathVisibility(
    repositoryId: string,
    showPath: boolean,
    showPathsByDefault = false
  ): Promise<boolean> {
    const state = this.readState();
    const repository = state.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) {
      return false;
    }

    const updatedRepositories = state.repositories.map((entry) => {
      if (entry.id !== repository.id) {
        return entry;
      }

      if (showPath === showPathsByDefault) {
        const { showPath: _showPath, ...defaultEntry } = entry;
        return defaultEntry;
      }

      return { ...entry, showPath };
    });

    await this.writeState({ ...state, repositories: updatedRepositories });
    return true;
  }

  async removeRepository(repositoryId: string): Promise<boolean> {
    const state = this.readState();
    const repository = state.repositories.find((candidate) => candidate.id === repositoryId);
    if (!repository) {
      return false;
    }

    await this.writeState({
      ...state,
      repositories: state.repositories.filter((entry) => entry.id !== repository.id)
    });
    return true;
  }

  private canCreateChildGroup(parentId: string | undefined, groups: RepoGroup[] = this.getGroups()): boolean {
    if (parentId === undefined) {
      return true;
    }

    const parent = groups.find((group) => group.id === parentId);
    if (!parent) {
      return false;
    }

    const depth = getGroupDepth(groups, parent.id);
    return depth !== undefined && depth < MAX_GROUP_DEPTH;
  }

  private canAddFolderSource(
    source: DiscoveredFolderSource,
    parentId: string | undefined,
    groups: RepoGroup[] = this.getGroups()
  ): boolean {
    if (!isValidFolderSource(source)) {
      return false;
    }

    return this.canCreateChildGroup(parentId, groups);
  }

  private buildFolderSourceAdditions(
    source: DiscoveredFolderSource,
    parentId: string | undefined,
    groups: RepoGroup[],
    repositories: RepositoryEntry[]
  ): AddFolderSourceResult {
    const result: AddFolderSourceResult = {
      addedGroups: [],
      addedRepositories: []
    };

    const parentDepth = parentId === undefined ? 0 : getGroupDepth(groups, parentId);
    this.addFolderSourceTree(
      source,
      parentId,
      result,
      (parentDepth ?? 0) + 1,
      groups,
      repositories
    );
    return result;
  }

  private addFolderSourceTree(
    source: DiscoveredFolderSource,
    parentId: string | undefined,
    result: AddFolderSourceResult,
    depth: number,
    groups: RepoGroup[],
    repositories: RepositoryEntry[]
  ): RepoGroup | undefined {
    if (
      !isValidFolderSource(source) ||
      depth > MAX_GROUP_DEPTH
    ) {
      return undefined;
    }

    const groupName = getAvailableSiblingGroupName([...groups, ...result.addedGroups], source.name, parentId);
    if (!groupName) {
      return undefined;
    }

    const groupIndex = result.addedGroups.length;
    const repositoryStartIndex = result.addedRepositories.length;
    const nextOrder = getNextOrderFrom(groups, repositories, parentId) +
      result.addedGroups.filter((group) => group.parentId === parentId).length;
    const group = {
      ...createManualGroup(groupName, this.createId, parentId),
      sourcePath: getAbsoluteTrimmedPath(source.sourcePath),
      order: nextOrder
    };
    result.addedGroups.push(group);
    this.addImportedRepositories(source.repositories, group.id, result, groups, repositories);

    if (depth < MAX_GROUP_DEPTH) {
      for (const childSource of source.children) {
        this.addFolderSourceTree(childSource, group.id, result, depth + 1, groups, repositories);
      }
    }

    const hasAddedRepositories = result.addedRepositories.length > repositoryStartIndex;
    const hasAddedChildren = result.addedGroups.length > groupIndex + 1;
    if (!hasAddedRepositories && !hasAddedChildren) {
      result.addedGroups.splice(groupIndex, 1);
      return undefined;
    }

    return group;
  }

  private addImportedRepositories(
    repositoryPaths: string[],
    groupId: string,
    result: AddFolderSourceResult,
    groups: RepoGroup[],
    repositories: RepositoryEntry[]
  ): void {
    let nextOrder = getNextOrderFrom(groups, repositories, groupId) +
      result.addedRepositories.filter((repository) => repository.groupId === groupId).length;
    for (const repositoryPath of repositoryPaths) {
      const absolutePath = getAbsoluteTrimmedPath(repositoryPath);
      if (!absolutePath) {
        continue;
      }

      result.addedRepositories.push(createRepositoryEntry(absolutePath, this.createId, groupId, nextOrder));
      nextOrder += 1;
    }
  }

  private getRawRepositories(): unknown[] {
    return this.storage.read().repositories;
  }

  private getRawGroups(): unknown[] {
    return this.storage.read().groups;
  }
}

async function readStorageState(
  storageUri: vscode.Uri,
  fileSystem: Pick<typeof vscode.workspace.fs, 'readFile'>
): Promise<RepositoryStorageState> {
  try {
    const content = new TextDecoder().decode(
      await fileSystem.readFile(vscode.Uri.joinPath(storageUri, STORAGE_FILE_NAME))
    );
    const data = JSON.parse(content) as Partial<RepositoryStorageState>;
    return {
      groups: Array.isArray(data.groups) ? data.groups : [],
      repositories: Array.isArray(data.repositories) ? data.repositories : []
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return { groups: [], repositories: [] };
    }

    throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function isValidFolderSource(source: DiscoveredFolderSource): boolean {
  return (
    normalizeGroupName(source.name) !== undefined &&
    getAbsoluteTrimmedPath(source.sourcePath) !== undefined &&
    Array.isArray(source.repositories) &&
    Array.isArray(source.children)
  );
}

function getAbsoluteTrimmedPath(value: string): string | undefined {
  const trimmedPath = value.trim();
  return path.isAbsolute(trimmedPath) ? trimmedPath : undefined;
}

function getNextOrderFrom(
  groups: RepoGroup[],
  repositories: RepositoryEntry[],
  parentId: string | undefined
): number {
  let maxOrder: number | undefined;

  const siblingRefs = getOrderedSiblingRefs(groups, repositories, parentId);
  for (const sibling of siblingRefs) {
    if (sibling.order !== undefined) {
      maxOrder = maxOrder === undefined ? sibling.order : Math.max(maxOrder, sibling.order);
    }
  }

  return maxOrder === undefined ? siblingRefs.length : maxOrder + 1;
}

function normalizeAllSiblingOrders(state: RepositoryStoreState): RepositoryStoreState {
  let normalizedState: RepositoryStoreState = {
    groups: state.groups.map((group) => ({ ...group })),
    repositories: state.repositories.map((repository) => ({ ...repository }))
  };
  const parentIds = new Set<string | undefined>([undefined]);
  for (const group of normalizedState.groups) {
    parentIds.add(group.id);
  }

  for (const parentId of parentIds) {
    normalizedState = assignSiblingOrders(
      normalizedState,
      parentId,
      getOrderedSiblingRefs(normalizedState.groups, normalizedState.repositories, parentId)
    );
  }

  return normalizedState;
}

function assignSiblingOrders(
  state: RepositoryStoreState,
  parentId: string | undefined,
  orderedRefs: SiblingRef[]
): RepositoryStoreState {
  const orderByKey = new Map<SiblingRefKey, number>();
  orderedRefs.forEach((entry, index) => {
    orderByKey.set(getSiblingRefKey(entry), index);
  });

  return {
    groups: state.groups.map((group) => {
      if (group.parentId !== parentId) {
        return group;
      }

      const order = orderByKey.get(getSiblingRefKey({ kind: 'group', id: group.id }));
      return order === undefined ? group : { ...group, order };
    }),
    repositories: state.repositories.map((repository) => {
      if (repository.groupId !== parentId) {
        return repository;
      }

      const order = orderByKey.get(getSiblingRefKey({ kind: 'repository', id: repository.id }));
      return order === undefined ? repository : { ...repository, order };
    })
  };
}

function getOrderedSiblingRefs(
  groups: RepoGroup[],
  repositories: RepositoryEntry[],
  parentId: string | undefined
): SiblingRef[] {
  const childGroups = groups.filter((group) => group.parentId === parentId);
  const groupRefs: SiblingRef[] = childGroups.map((group, index) => ({
    kind: 'group',
    id: group.id,
    order: group.order,
    fallbackOrder: index,
    stableIndex: index
  }));
  const repositoryRefs: SiblingRef[] = repositories
    .filter((repository) => repository.groupId === parentId)
    .map((repository, index) => ({
      kind: 'repository',
      id: repository.id,
      order: repository.order,
      fallbackOrder: childGroups.length + index,
      stableIndex: childGroups.length + index
    }));

  return [...groupRefs, ...repositoryRefs].sort(compareSiblingRefs);
}

function compareSiblingRefs(left: SiblingRef, right: SiblingRef): number {
  const orderComparison = getSiblingSortOrder(left) - getSiblingSortOrder(right);
  return orderComparison === 0 ? left.stableIndex - right.stableIndex : orderComparison;
}

function getSiblingSortOrder(entry: SiblingRef): number {
  return entry.order ?? entry.fallbackOrder;
}

function getSiblingRefKey(entry: Pick<SiblingRef, 'kind' | 'id'>): SiblingRefKey {
  return `${entry.kind}:${entry.id}`;
}

function wouldReparentDuplicateChildGroups(group: RepoGroup, groups: RepoGroup[]): boolean {
  return groups.some((candidate) =>
    candidate.parentId === group.id &&
    hasDuplicateSiblingGroupName(groups, candidate.name, group.parentId, candidate.id)
  );
}

function getAvailableSiblingGroupName(
  groups: RepoGroup[],
  groupName: string,
  parentId: string | undefined
): string | undefined {
  const baseName = normalizeGroupName(groupName);
  if (!baseName) {
    return undefined;
  }

  let candidateName = baseName;
  let suffix = 2;
  while (hasDuplicateSiblingGroupName(groups, candidateName, parentId)) {
    candidateName = `${baseName} ${suffix}`;
    suffix += 1;
  }

  return candidateName;
}

function withParent(group: RepoGroup, parentId: string | undefined): RepoGroup {
  if (parentId === undefined) {
    const { parentId: _parentId, ...topLevelGroup } = group;
    return topLevelGroup;
  }

  return { ...group, parentId };
}

function withRepositoryGroup(repository: RepositoryEntry, groupId: string | undefined): RepositoryEntry {
  if (groupId === undefined) {
    const { groupId: _groupId, ...ungroupedRepository } = repository;
    return ungroupedRepository;
  }

  return { ...repository, groupId };
}
