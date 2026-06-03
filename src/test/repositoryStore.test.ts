import * as assert from 'assert';
import * as vscode from 'vscode';

import type { DiscoveredFolderSource } from '../repositoryDiscovery';
import {
  RepositoryGlobalStorage,
  RepositoryStore,
  type RepositoryStorage,
  type RepositoryStorageState
} from '../repositoryStore';

class MemoryStorage implements RepositoryStorage {
  public values = new Map<string, unknown>();
  public updates: RepositoryStorageState[] = [];

  read(): RepositoryStorageState {
    return {
      groups: readArray(this.values.get('groups')),
      repositories: readArray(this.values.get('repositories'))
    };
  }

  async write(state: RepositoryStorageState): Promise<void> {
    this.values.set('groups', state.groups);
    this.values.set('repositories', state.repositories);
    this.updates.push(state);
  }
}

class MemoryFileSystem {
  public files = new Map<string, Uint8Array>();
  public writeError: Error | undefined;

  async createDirectory(_uri: vscode.Uri): Promise<void> {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const file = this.files.get(uri.toString());
    if (file === undefined) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return file;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    if (this.writeError) {
      throw this.writeError;
    }

    this.files.set(uri.toString(), content);
  }
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function createIds(ids: string[]): () => string {
  return () => ids.shift() ?? 'fallback';
}

suite('RepositoryStore', () => {
  test('creates nested groups and rejects groups past max depth', async () => {
    const config = new MemoryStorage();
    const store = new RepositoryStore(config, createIds(['root', 'child', 'grandchild', 'too-deep']));

    assert.deepStrictEqual(await store.createGroup('Root'), { id: 'root', name: 'Root', order: 0 });
    assert.deepStrictEqual(await store.createGroup('Child', 'root'), {
      id: 'child',
      name: 'Child',
      parentId: 'root',
      order: 0
    });
    assert.deepStrictEqual(await store.createGroup('Grandchild', 'child'), {
      id: 'grandchild',
      name: 'Grandchild',
      parentId: 'child',
      order: 0
    });
    assert.strictEqual(await store.createGroup('Too Deep', 'grandchild'), undefined);
  });

  test('adds repositories with ids, names, and sibling order', async () => {
    const config = new MemoryStorage();
    config.values.set('repositories', [
      { id: 'existing', name: 'api', path: 'C:\\Repos\\api' }
    ]);
    const store = new RepositoryStore(config, createIds(['repo-1', 'repo-2']));

    const added = await store.addRepositories(['C:\\Repos\\web', 'relative']);

    assert.deepStrictEqual(added, [
      { id: 'repo-1', name: 'web', path: 'C:\\Repos\\web', order: 1 }
    ]);
    assert.deepStrictEqual(config.values.get('repositories'), [
      { id: 'existing', name: 'api', path: 'C:\\Repos\\api', order: 0 },
      { id: 'repo-1', name: 'web', path: 'C:\\Repos\\web', order: 1 }
    ]);
  });

  test('imports discovered folder source as groups and repositories', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [{ id: 'manual', name: 'Manual' }]);
    const source: DiscoveredFolderSource = {
      name: 'Repos',
      sourcePath: 'C:\\Repos',
      repositories: ['C:\\Repos\\api'],
      children: [
        {
          name: 'Tools',
          sourcePath: 'C:\\Repos\\Tools',
          repositories: ['C:\\Repos\\Tools\\cli'],
          children: []
        }
      ]
    };
    const store = new RepositoryStore(config, createIds(['repos', 'api', 'tools', 'cli']));

    const result = await store.addFolderSource(source, 'manual');

    assert.deepStrictEqual(result.addedGroups, [
      { id: 'repos', name: 'Repos', parentId: 'manual', sourcePath: 'C:\\Repos', order: 0 },
      { id: 'tools', name: 'Tools', parentId: 'repos', sourcePath: 'C:\\Repos\\Tools', order: 0 }
    ]);
    assert.deepStrictEqual(result.addedRepositories, [
      { id: 'api', name: 'api', path: 'C:\\Repos\\api', groupId: 'repos', order: 0 },
      { id: 'cli', name: 'cli', path: 'C:\\Repos\\Tools\\cli', groupId: 'tools', order: 0 }
    ]);
  });

  test('renames imported folder group when sibling name already exists', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [{ id: 'repos', name: 'Repos' }]);
    const source: DiscoveredFolderSource = {
      name: 'repos',
      sourcePath: 'C:\\Repos',
      repositories: ['C:\\Repos\\api'],
      children: []
    };
    const store = new RepositoryStore(config, createIds(['new-repos', 'repo']));

    const result = await store.addFolderSource(source);

    assert.deepStrictEqual(result.addedGroups, [
      { id: 'new-repos', name: 'repos 2', sourcePath: 'C:\\Repos', order: 1 }
    ]);
  });

  test('keeps group and grouped repositories when source path metadata is invalid', () => {
    const config = new MemoryStorage();
    config.values.set('groups', [{ id: 'repos', name: 'Repos', sourcePath: 'relative' }]);
    config.values.set('repositories', [{ id: 'api', name: 'api', path: 'C:\\Repos\\api', groupId: 'repos' }]);
    const store = new RepositoryStore(config);

    assert.deepStrictEqual(store.getGroups(), [{ id: 'repos', name: 'Repos', order: 0 }]);
    assert.deepStrictEqual(store.getRepositories(), [
      { id: 'api', name: 'api', path: 'C:\\Repos\\api', groupId: 'repos', order: 0 }
    ]);
  });

  test('moves repository to group and root using sibling order', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [{ id: 'manual', name: 'Manual' }]);
    config.values.set('repositories', [{ id: 'repo', name: 'api', path: 'C:\\Repos\\api' }]);
    const store = new RepositoryStore(config);

    assert.strictEqual(await store.moveRepositoryToGroup('repo', 'manual'), true);
    assert.deepStrictEqual(config.values.get('repositories'), [
      { id: 'repo', name: 'api', path: 'C:\\Repos\\api', groupId: 'manual', order: 0 }
    ]);

    assert.strictEqual(await store.moveRepositoryToGroup('repo', undefined), true);
    assert.deepStrictEqual(config.values.get('repositories'), [
      { id: 'repo', name: 'api', path: 'C:\\Repos\\api', order: 1 }
    ]);
  });

  test('creates group at repository position before moving repository into it', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [{ id: 'group-1', name: 'group1' }]);
    config.values.set('repositories', [
      { id: 'repo-1', name: 'repo1', path: 'C:\\Repos\\repo1', groupId: 'group-1' },
      { id: 'repo-2', name: 'repo2', path: 'C:\\Repos\\repo2', groupId: 'group-1' },
      { id: 'repo-3', name: 'repo3', path: 'C:\\Repos\\repo3', groupId: 'group-1' },
      { id: 'repo-4', name: 'repo4', path: 'C:\\Repos\\repo4', groupId: 'group-1' }
    ]);
    const store = new RepositoryStore(config, () => 'group-2');

    assert.deepStrictEqual(await store.createGroup('group2', 'group-1', 2), {
      id: 'group-2',
      name: 'group2',
      parentId: 'group-1',
      order: 2
    });
    assert.strictEqual(await store.moveRepositoryToGroup('repo-3', 'group-2'), true);

    assert.deepStrictEqual(store.getGroups(), [
      { id: 'group-1', name: 'group1', order: 0 },
      { id: 'group-2', name: 'group2', parentId: 'group-1', order: 2 }
    ]);
    assert.deepStrictEqual(store.getRepositories(), [
      { id: 'repo-1', name: 'repo1', path: 'C:\\Repos\\repo1', groupId: 'group-1', order: 0 },
      { id: 'repo-2', name: 'repo2', path: 'C:\\Repos\\repo2', groupId: 'group-1', order: 1 },
      { id: 'repo-3', name: 'repo3', path: 'C:\\Repos\\repo3', groupId: 'group-2', order: 0 },
      { id: 'repo-4', name: 'repo4', path: 'C:\\Repos\\repo4', groupId: 'group-1', order: 3 }
    ]);
  });

  test('sets repository path visibility relative to default', async () => {
    const config = new MemoryStorage();
    config.values.set('repositories', [
      { id: 'manual', name: 'manual', path: 'C:\\Scratch' },
      { id: 'imported', name: 'api', path: 'C:\\Repos\\api', showPath: false }
    ]);
    const store = new RepositoryStore(config);

    assert.strictEqual(await store.setRepositoryPathVisibility('manual', false, true), true);
    assert.strictEqual(await store.setRepositoryPathVisibility('imported', true, true), true);
    assert.deepStrictEqual(config.values.get('repositories'), [
      { id: 'manual', name: 'Scratch', path: 'C:\\Scratch', order: 0, showPath: false },
      { id: 'imported', name: 'api', path: 'C:\\Repos\\api', order: 1 }
    ]);
  });

  test('ungroups group by replacing it with ordered contents', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [
      { id: 'group-1', name: 'group1' },
      { id: 'group-2', name: 'group2', parentId: 'group-1', order: 2 },
      { id: 'group-3', name: 'group3', parentId: 'group-2', order: 1 }
    ]);
    config.values.set('repositories', [
      { id: 'repo-1', name: 'repo1', path: 'C:\\Repos\\repo1', groupId: 'group-1', order: 0 },
      { id: 'repo-2', name: 'repo2', path: 'C:\\Repos\\repo2', groupId: 'group-1', order: 1 },
      { id: 'repo-3', name: 'repo3', path: 'C:\\Repos\\repo3', groupId: 'group-2', order: 0 },
      { id: 'repo-4', name: 'repo4', path: 'C:\\Repos\\repo4', groupId: 'group-1', order: 3 }
    ]);
    const store = new RepositoryStore(config);

    assert.strictEqual(await store.ungroupGroup('group-2'), true);

    assert.deepStrictEqual(store.getGroups(), [
      { id: 'group-1', name: 'group1', order: 0 },
      { id: 'group-3', name: 'group3', parentId: 'group-1', order: 3 }
    ]);
    assert.deepStrictEqual(store.getRepositories(), [
      { id: 'repo-1', name: 'repo1', path: 'C:\\Repos\\repo1', groupId: 'group-1', order: 0 },
      { id: 'repo-2', name: 'repo2', path: 'C:\\Repos\\repo2', groupId: 'group-1', order: 1 },
      { id: 'repo-3', name: 'repo3', path: 'C:\\Repos\\repo3', groupId: 'group-1', order: 2 },
      { id: 'repo-4', name: 'repo4', path: 'C:\\Repos\\repo4', groupId: 'group-1', order: 4 }
    ]);
  });

  test('removes group subtree and contained repositories', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [
      { id: 'manual', name: 'Manual' },
      { id: 'group', name: 'Repos', parentId: 'manual' },
      { id: 'nested', name: 'NC', parentId: 'group' }
    ]);
    config.values.set('repositories', [
      { id: 'manual-repo', name: 'scratch', path: 'C:\\Scratch', groupId: 'manual' },
      { id: 'group-repo', name: 'api', path: 'C:\\Repos\\api', groupId: 'group' },
      { id: 'nested-repo', name: 'web', path: 'C:\\Repos\\NC\\web', groupId: 'nested' }
    ]);
    const store = new RepositoryStore(config);

    assert.strictEqual(await store.removeGroup('group'), true);
    assert.deepStrictEqual(config.values.get('groups'), [
      { id: 'manual', name: 'Manual', order: 0 }
    ]);
    assert.deepStrictEqual(config.values.get('repositories'), [
      { id: 'manual-repo', name: 'Scratch', path: 'C:\\Scratch', groupId: 'manual', order: 0 }
    ]);
  });

  test('moves groups while rejecting cycles', async () => {
    const config = new MemoryStorage();
    config.values.set('groups', [
      { id: 'manual', name: 'Manual' },
      { id: 'group', name: 'Repos' },
      { id: 'target', name: 'NC' }
    ]);
    const store = new RepositoryStore(config);

    assert.strictEqual(await store.moveGroup('group', 'manual'), true);
    assert.strictEqual(await store.moveGroup('manual', 'target'), true);
    assert.strictEqual(await store.moveGroup('target', 'group'), false);
  });
});

suite('RepositoryGlobalStorage', () => {
  test('reads and writes repository data', async () => {
    const fileSystem = new MemoryFileSystem();
    const storageUri = vscode.Uri.file('C:\\RepoLauncherStorage');
    fileSystem.files.set(
      vscode.Uri.joinPath(storageUri, 'repositories.json').toString(),
      new TextEncoder().encode(JSON.stringify({
        groups: [{ id: 'manual', name: 'Manual' }],
        repositories: [{ id: 'repo', name: 'api', path: 'C:\\Repos\\api' }]
      }))
    );
    const storage = await RepositoryGlobalStorage.create(
      { globalStorageUri: storageUri } as vscode.ExtensionContext,
      fileSystem
    );

    assert.deepStrictEqual(storage.read(), {
      groups: [{ id: 'manual', name: 'Manual' }],
      repositories: [{ id: 'repo', name: 'api', path: 'C:\\Repos\\api' }]
    });

    await storage.write({
      groups: [{ id: 'changed', name: 'Changed' }],
      repositories: []
    });

    const fileUri = vscode.Uri.joinPath(storageUri, 'repositories.json');
    const content = new TextDecoder().decode(fileSystem.files.get(fileUri.toString()));
    assert.deepStrictEqual(JSON.parse(content), {
      groups: [{ id: 'changed', name: 'Changed' }],
      repositories: []
    });
  });

  test('keeps current state when global storage write fails', async () => {
    const fileSystem = new MemoryFileSystem();
    const storageUri = vscode.Uri.file('C:\\RepoLauncherStorage');
    const storage = await RepositoryGlobalStorage.create(
      { globalStorageUri: storageUri } as vscode.ExtensionContext,
      fileSystem
    );
    const writeError = new Error('Write failed');

    await storage.write({
      groups: [{ id: 'manual', name: 'Manual' }],
      repositories: []
    });
    fileSystem.writeError = writeError;

    await assert.rejects(
      storage.write({
        groups: [{ id: 'changed', name: 'Changed' }],
        repositories: []
      }),
      writeError
    );
    assert.deepStrictEqual(storage.read(), {
      groups: [{ id: 'manual', name: 'Manual' }],
      repositories: []
    });
  });
});
