import * as path from 'path';

import type { RepoGroup } from './repositoryGroup';
import { normalizeOptionalNonEmptyString } from './strings';

export interface RepositoryEntry {
  id: string;
  name: string;
  path: string;
  groupId?: string;
  order?: number;
  showPath?: boolean;
}

export type CreateId = () => string;

export function isRepositoryEntry(value: unknown): value is RepositoryEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const entry = value as Partial<RepositoryEntry>;
  return (
    typeof entry.id === 'string' &&
    entry.id.trim().length > 0 &&
    typeof entry.name === 'string' &&
    entry.name.trim().length > 0 &&
    typeof entry.path === 'string' &&
    path.isAbsolute(entry.path.trim()) &&
    (entry.groupId === undefined ||
      (typeof entry.groupId === 'string' && entry.groupId.trim().length > 0)) &&
    (entry.order === undefined || (typeof entry.order === 'number' && Number.isFinite(entry.order))) &&
    (entry.showPath === undefined || typeof entry.showPath === 'boolean')
  );
}

export function sanitizeRepositories(value: unknown): RepositoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const repositories: RepositoryEntry[] = [];
  for (const entry of value) {
    if (!isRepositoryEntry(entry)) {
      continue;
    }

    const id = entry.id.trim();
    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);
    repositories.push({
      id,
      name: path.basename(path.resolve(entry.path.trim())),
      path: entry.path.trim(),
      ...(entry.groupId === undefined ? {} : { groupId: entry.groupId.trim() }),
      ...(entry.order === undefined ? {} : { order: entry.order }),
      ...(entry.showPath === undefined ? {} : { showPath: entry.showPath })
    });
  }

  return repositories;
}

export function repairRepositoryGroupReferences(
  repositories: RepositoryEntry[],
  groups: RepoGroup[]
): RepositoryEntry[] {
  const groupIds = new Set(groups.map((group) => group.id));

  return repositories.map((repository) => {
    if (repository.groupId === undefined || groupIds.has(repository.groupId)) {
      return repository;
    }

    const { groupId: _groupId, ...ungroupedRepository } = repository;
    return ungroupedRepository;
  });
}

export function normalizeRepositoryPath(repositoryPath: string): string {
  const resolvedPath = path.resolve(repositoryPath.trim());
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export function createRepositoryEntry(
  repositoryPath: string,
  createId: CreateId,
  groupId?: string,
  order?: number,
  showPath?: boolean
): RepositoryEntry {
  const trimmedPath = repositoryPath.trim();
  const normalizedGroupId = normalizeOptionalNonEmptyString(groupId, 'groupId');
  return {
    id: createId(),
    name: path.basename(path.resolve(trimmedPath)),
    path: trimmedPath,
    ...(normalizedGroupId === undefined ? {} : { groupId: normalizedGroupId }),
    ...(order === undefined ? {} : { order }),
    ...(showPath === undefined ? {} : { showPath })
  };
}
