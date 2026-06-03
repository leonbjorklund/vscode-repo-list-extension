import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  COMMAND_ADD_REPOSITORY,
  COMMAND_ADD_REPOSITORY_AT_ROOT,
  COMMAND_CREATE_GROUP,
  COMMAND_CREATE_ROOT_GROUP,
  COMMAND_DELETE_SELECTED_ITEM,
  COMMAND_HIDE_REPOSITORY_PATH,
  COMMAND_MOVE_REPOSITORY_TO_GROUP,
  COMMAND_OPEN_REPOSITORY,
  COMMAND_RENAME_GROUP,
  COMMAND_REVEAL_IN_FILE_EXPLORER,
  COMMAND_SHOW_REPOSITORY_PATH,
  COMMAND_UNGROUP_SELECTED_GROUP
} from '../constants';
import {
  buildGroupQuickPickItems,
  deleteSelectedTreeItem,
  getRepositorySiblingOrder,
  revealInFileExplorer
} from '../extension';
import type { RepositoryEntry } from '../repository';
import { GroupTreeItem, RepositoryTreeItem } from '../repositoryTreeProvider';

suite('extension activation', () => {
  test('registers contributed commands', async () => {
    const extension = vscode.extensions.getExtension('local.vscode-repo-list-extension');

    assert.ok(extension);
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      COMMAND_ADD_REPOSITORY,
      COMMAND_ADD_REPOSITORY_AT_ROOT,
      COMMAND_CREATE_GROUP,
      COMMAND_CREATE_ROOT_GROUP,
      COMMAND_OPEN_REPOSITORY,
      COMMAND_MOVE_REPOSITORY_TO_GROUP,
      COMMAND_SHOW_REPOSITORY_PATH,
      COMMAND_HIDE_REPOSITORY_PATH,
      COMMAND_REVEAL_IN_FILE_EXPLORER,
      COMMAND_DELETE_SELECTED_ITEM,
      COMMAND_UNGROUP_SELECTED_GROUP,
      COMMAND_RENAME_GROUP
    ]) {
      assert.ok(commands.includes(command), command);
    }
  });
});

suite('extension group helpers', () => {
  test('builds group picker items with parent labels and create action', () => {
    const items = buildGroupQuickPickItems([
      { id: 'client-a', name: 'Client A' },
      { id: 'shared-a', name: 'Shared', parentId: 'client-a' }
    ], true, 'New');

    assert.deepStrictEqual(items.map((item) => item.label), [
      '$(add) Create "New"',
      'Client A',
      'Shared',
      '$(add) Create group',
      '$(remove) Ungroup'
    ]);
    assert.strictEqual(items.find((item) => item.label === 'Shared')?.description, 'Client A');
  });

  test('gets repository sibling order for group creation', () => {
    const groups = [
      { id: 'folder', name: 'Folder' },
      { id: 'manual', name: 'Manual', parentId: 'folder' }
    ];
    const repositories = [
      { id: 'api', name: 'api', path: 'C:\\Repos\\api', groupId: 'folder', order: 4 },
      { id: 'web', name: 'web', path: 'C:\\Repos\\web', groupId: 'folder' }
    ];

    assert.strictEqual(getRepositorySiblingOrder(repositories[0], groups, repositories), 4);
    assert.strictEqual(getRepositorySiblingOrder(repositories[1], groups, repositories), 2);
  });
});

suite('extension selected item commands', () => {
  test('removes selected repository or group', async () => {
    const repository: RepositoryEntry = { id: 'api', name: 'api', path: 'C:\\Repos\\api' };
    const removedRepositories: string[] = [];
    const removedGroups: string[] = [];

    const dependencies = {
      removeGroup: async (groupId: string) => {
        removedGroups.push(groupId);
        return true;
      },
      removeRepository: async (repositoryId: string) => {
        removedRepositories.push(repositoryId);
        return true;
      },
      refresh: () => undefined,
      showErrorMessage: async () => undefined
    };

    await deleteSelectedTreeItem(new RepositoryTreeItem(repository, true), dependencies);
    await deleteSelectedTreeItem(new GroupTreeItem({ id: 'manual', name: 'Manual' }, 1), dependencies);

    assert.deepStrictEqual(removedRepositories, ['api']);
    assert.deepStrictEqual(removedGroups, ['manual']);
  });

  test('reveals repository in file explorer', async () => {
    const repository: RepositoryEntry = { id: 'api', name: 'api', path: 'C:\\Repos\\api' };
    const executed: Array<{ command: string; args: unknown[] }> = [];

    await revealInFileExplorer(new RepositoryTreeItem(repository, true), {
      executeCommand: async (command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return undefined;
      },
      showErrorMessage: async () => undefined
    });

    assert.strictEqual(executed[0].command, 'revealFileInOS');
    assert.strictEqual((executed[0].args[0] as vscode.Uri).toString(), vscode.Uri.file(repository.path).toString());
  });

  test('reveals folder source group in file explorer', async () => {
    const sourcePath = 'C:\\Repos';
    const executed: Array<{ command: string; args: unknown[] }> = [];

    await revealInFileExplorer(new GroupTreeItem({ id: 'repos', name: 'Repos', sourcePath }, 1), {
      executeCommand: async (command: string, ...args: unknown[]) => {
        executed.push({ command, args });
        return undefined;
      },
      showErrorMessage: async () => undefined
    });

    assert.strictEqual(executed[0].command, 'revealFileInOS');
    assert.strictEqual((executed[0].args[0] as vscode.Uri).toString(), vscode.Uri.file(sourcePath).toString());
  });
});
