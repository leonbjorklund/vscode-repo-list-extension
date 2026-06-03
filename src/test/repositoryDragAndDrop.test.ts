import * as assert from 'assert';
import * as vscode from 'vscode';

import { RepositoryDragAndDropController } from '../repositoryDragAndDrop';
import type { RepoGroup } from '../repositoryGroup';
import { GroupTreeItem, RepositoryTreeItem } from '../repositoryTreeProvider';

class StubStore {
  public repoMoves: Array<{ repoId: string; groupId: string | undefined; order?: number }> = [];
  public groupMoves: Array<{ groupId: string; parentId: string | undefined; order?: number }> = [];

  async moveRepositoryToGroup(repoId: string, groupId: string | undefined, order?: number): Promise<boolean> {
    this.repoMoves.push({ repoId, groupId, ...(order === undefined ? {} : { order }) });
    return true;
  }

  async moveGroup(groupId: string, parentId: string | undefined, order?: number): Promise<boolean> {
    this.groupMoves.push({ groupId, parentId, ...(order === undefined ? {} : { order }) });
    return true;
  }
}

function cancellationToken(): vscode.CancellationToken {
  return new vscode.CancellationTokenSource().token;
}

suite('RepositoryDragAndDropController', () => {
  test('moves dragged repository after repository target', async () => {
    const store = new StubStore();
    const controller = new RepositoryDragAndDropController(store, () => undefined);
    const sourceRepo = { id: 'repo', name: 'api', path: 'C:\\Repos\\api' };
    const targetRepo = { id: 'target', name: 'web', path: 'C:\\Repos\\web', groupId: 'manual', order: 4 };
    const dataTransfer = new vscode.DataTransfer();

    await controller.handleDrag?.([new RepositoryTreeItem(sourceRepo, true)], dataTransfer, cancellationToken());
    await controller.handleDrop?.(new RepositoryTreeItem(targetRepo, true), dataTransfer, cancellationToken());

    assert.deepStrictEqual(store.repoMoves, [{ repoId: 'repo', groupId: 'manual', order: 4.5 }]);
    assert.deepStrictEqual(store.groupMoves, []);
  });

  test('does not move repository when dropped on current parent group', async () => {
    const store = new StubStore();
    const controller = new RepositoryDragAndDropController(store, () => undefined);
    const group: RepoGroup = { id: 'manual', name: 'Manual' };
    const repo = { id: 'repo', name: 'api', path: 'C:\\Repos\\api', groupId: 'manual' };
    const dataTransfer = new vscode.DataTransfer();

    await controller.handleDrag?.([new RepositoryTreeItem(repo, true)], dataTransfer, cancellationToken());
    await controller.handleDrop?.(new GroupTreeItem(group, 0), dataTransfer, cancellationToken());

    assert.deepStrictEqual(store.repoMoves, []);
  });

  test('ungroups repository when dropped on root', async () => {
    const store = new StubStore();
    const controller = new RepositoryDragAndDropController(store, () => undefined);
    const repo = { id: 'repo', name: 'api', path: 'C:\\Repos\\api', groupId: 'manual' };
    const dataTransfer = new vscode.DataTransfer();

    await controller.handleDrag?.([new RepositoryTreeItem(repo, true)], dataTransfer, cancellationToken());
    await controller.handleDrop?.(undefined, dataTransfer, cancellationToken());

    assert.deepStrictEqual(store.repoMoves, [{ repoId: 'repo', groupId: undefined }]);
  });

  test('moves dragged group to root', async () => {
    const store = new StubStore();
    const controller = new RepositoryDragAndDropController(store, () => undefined);
    const group: RepoGroup = { id: 'manual', name: 'Manual' };
    const dataTransfer = new vscode.DataTransfer();

    await controller.handleDrag?.([new GroupTreeItem(group, 0)], dataTransfer, cancellationToken());
    await controller.handleDrop?.(undefined, dataTransfer, cancellationToken());

    assert.deepStrictEqual(store.groupMoves, [{ groupId: 'manual', parentId: undefined }]);
  });
});
