import * as path from 'path';

import { normalizeNonEmptyString, normalizeOptionalNonEmptyString } from './strings';

export const MAX_GROUP_DEPTH = 3;

export interface RepoGroup {
  id: string;
  name: string;
  parentId?: string;
  order?: number;
  sourcePath?: string;
}

export type CreateId = () => string;

export function normalizeGroupName(groupName: string): string | undefined {
  return normalizeNonEmptyString(groupName);
}

export function hasDuplicateSiblingGroupName(
  groups: RepoGroup[],
  name: string,
  parentId: string | undefined,
  exceptGroupId?: string
): boolean {
  const normalizedName = normalizeGroupName(name);
  if (!normalizedName) {
    return false;
  }

  return groups.some((group) =>
    group.id !== exceptGroupId &&
    group.parentId === parentId &&
    group.name.toLowerCase() === normalizedName.toLowerCase()
  );
}

export function createManualGroup(
  name: string,
  createId: CreateId,
  parentId?: string
): RepoGroup {
  const normalizedName = normalizeGroupName(name);
  const normalizedParentId = normalizeOptionalNonEmptyString(parentId, 'parentId');
  if (!normalizedName) {
    throw new Error('Group name cannot be empty.');
  }

  return {
    id: createId(),
    name: normalizedName,
    ...(normalizedParentId === undefined ? {} : { parentId: normalizedParentId })
  };
}

export function isRepoGroup(value: unknown): value is RepoGroup {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const group = value as Partial<RepoGroup>;
  return (
    typeof group.id === 'string' &&
    group.id.trim().length > 0 &&
    typeof group.name === 'string' &&
    normalizeGroupName(group.name) !== undefined &&
    (group.parentId === undefined ||
      (typeof group.parentId === 'string' && group.parentId.trim().length > 0)) &&
    (group.order === undefined || (typeof group.order === 'number' && Number.isFinite(group.order))) &&
    (group.sourcePath === undefined || typeof group.sourcePath === 'string')
  );
}

export function sanitizeGroups(value: unknown): RepoGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const candidates: RepoGroup[] = [];

  for (const group of value) {
    if (!isRepoGroup(group)) {
      continue;
    }

    const id = group.id.trim();
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const sourcePath = group.sourcePath?.trim();

    candidates.push({
      id,
      name: normalizeGroupName(group.name) ?? group.name.trim(),
      ...(group.parentId === undefined ? {} : { parentId: group.parentId.trim() }),
      ...(group.order === undefined ? {} : { order: group.order }),
      ...(sourcePath && path.isAbsolute(sourcePath) ? { sourcePath } : {})
    });
  }

  const repairedGroups = repairGroupParents(candidates);
  const dedupedGroups = dropDuplicateSiblingNames(repairedGroups);
  const finalGroups = dropDuplicateSiblingNames(repairGroupParents(dedupedGroups));

  return finalGroups.filter((group) => {
    const depth = getGroupDepth(finalGroups, group.id);
    return depth !== undefined && depth <= MAX_GROUP_DEPTH;
  });
}

export function getGroupDepth(groups: RepoGroup[], groupId: string): number | undefined {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  let current = groupById.get(groupId);
  if (!current) {
    return undefined;
  }

  let depth = 1;
  const visited = new Set<string>([current.id]);
  while (current.parentId !== undefined) {
    const parent = groupById.get(current.parentId);
    if (!parent || visited.has(parent.id)) {
      return undefined;
    }

    visited.add(parent.id);
    depth += 1;
    current = parent;
  }

  return depth;
}

export function getDescendantGroupIds(groups: RepoGroup[], groupId: string): string[] {
  const descendants: string[] = [];
  const visited = new Set<string>();

  const visit = (parentId: string): void => {
    for (const group of groups) {
      if (group.parentId === parentId && !visited.has(group.id)) {
        visited.add(group.id);
        descendants.push(group.id);
        visit(group.id);
      }
    }
  };

  visit(groupId);
  return descendants;
}

function withoutParent(group: RepoGroup): RepoGroup {
  const { parentId, ...topLevelGroup } = group;
  return topLevelGroup;
}

function repairGroupParents(groups: RepoGroup[]): RepoGroup[] {
  const groupIds = new Set(groups.map((group) => group.id));
  const repairedGroups = groups.map((group) =>
    group.parentId === undefined || groupIds.has(group.parentId) ? { ...group } : withoutParent(group)
  );

  for (const group of repairedGroups) {
    const cycleIds = getCycleIds(repairedGroups, group.id);
    if (cycleIds.length === 0) {
      continue;
    }

    const cycleIdSet = new Set(cycleIds);
    const groupIndexToBreak = repairedGroups.findIndex((candidate) => cycleIdSet.has(candidate.id));
    if (groupIndexToBreak !== -1) {
      repairedGroups[groupIndexToBreak] = withoutParent(repairedGroups[groupIndexToBreak]);
    }
  }

  return repairedGroups;
}

function dropDuplicateSiblingNames(groups: RepoGroup[]): RepoGroup[] {
  const seenSiblingNames = new Set<string>();
  const dedupedGroups: RepoGroup[] = [];

  for (const group of groups) {
    const siblingNameKey = `${group.parentId ?? ''}\0${group.name.toLowerCase()}`;
    if (seenSiblingNames.has(siblingNameKey)) {
      continue;
    }

    seenSiblingNames.add(siblingNameKey);
    dedupedGroups.push(group);
  }

  return dedupedGroups;
}

function getCycleIds(groups: RepoGroup[], groupId: string): string[] {
  const groupById = new Map(groups.map((group) => [group.id, group]));
  let current = groupById.get(groupId);
  const visitedIndexById = new Map<string, number>();
  const pathIds: string[] = [];

  while (current) {
    const visitedIndex = visitedIndexById.get(current.id);
    if (visitedIndex !== undefined) {
      return pathIds.slice(visitedIndex);
    }

    visitedIndexById.set(current.id, pathIds.length);
    pathIds.push(current.id);
    current = current.parentId === undefined ? undefined : groupById.get(current.parentId);
  }

  return [];
}
