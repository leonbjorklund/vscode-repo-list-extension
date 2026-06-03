import * as vscode from 'vscode';

import { GroupTreeItem, RepositoryTreeItem, type RepositoryTreeElement } from './repositoryTreeProvider';

const TREE_MIME_TYPE = 'application/vnd.code.tree.repolauncher.repositories';

type RepositoryDragPayload = { kind: 'repository'; id: string; groupId?: string };
type GroupDragPayload = { kind: 'group'; id: string };
type DragPayload = RepositoryDragPayload | GroupDragPayload;

export interface RepositoryDragAndDropStore {
  moveRepositoryToGroup(repoId: string, groupId: string | undefined, order?: number): Promise<boolean>;
  moveGroup(groupId: string, parentId: string | undefined, order?: number): Promise<boolean>;
}

export class RepositoryDragAndDropController implements vscode.TreeDragAndDropController<RepositoryTreeElement> {
  readonly dragMimeTypes = [TREE_MIME_TYPE];
  readonly dropMimeTypes = [TREE_MIME_TYPE];

  constructor(
    private readonly store: RepositoryDragAndDropStore,
    private readonly refresh: () => void
  ) {}

  handleDrag(
    source: readonly RepositoryTreeElement[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): void {
    if (source.length !== 1) {
      return;
    }

    const [item] = source;
    if (item instanceof RepositoryTreeItem) {
      dataTransfer.set(TREE_MIME_TYPE, new vscode.DataTransferItem({
        kind: 'repository',
        id: item.repository.id,
        groupId: item.repository.groupId
      } satisfies DragPayload));
      return;
    }

    if (item instanceof GroupTreeItem) {
      dataTransfer.set(TREE_MIME_TYPE, new vscode.DataTransferItem({
        kind: 'group',
        id: item.group.id
      } satisfies DragPayload));
    }
  }

  async handleDrop(
    target: RepositoryTreeElement | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const targetRepository = target instanceof RepositoryTreeItem ? target.repository : undefined;
    const targetGroup = target instanceof GroupTreeItem ? target.group : undefined;
    const targetGroupId = targetGroup?.id;
    const targetParentId = targetRepository?.groupId ?? targetGroupId;
    const targetOrder = targetRepository?.order === undefined ? undefined : targetRepository.order + 0.5;
    const payload = parseDragPayload(dataTransfer.get(TREE_MIME_TYPE)?.value);

    if (!payload) {
      return;
    }

    if (payload.kind === 'repository') {
      if (targetGroupId !== undefined && targetGroupId === payload.groupId) {
        return;
      }

      if (await this.store.moveRepositoryToGroup(payload.id, targetParentId, targetOrder)) {
        this.refresh();
      }
      return;
    }

    if (await this.store.moveGroup(payload.id, targetParentId, targetOrder)) {
      this.refresh();
    }
  }
}

function parseDragPayload(value: unknown): DragPayload | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const payload = value as Partial<DragPayload>;
  const id = getNonEmptyString(payload.id);
  if (!id) {
    return undefined;
  }

  if (payload.kind === 'group') {
    return { kind: 'group', id };
  }

  if (payload.kind === 'repository') {
    const groupId = getNonEmptyString(payload.groupId);
    return {
      kind: 'repository',
      id,
      ...(groupId === undefined ? {} : { groupId })
    };
  }

  return undefined;
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
