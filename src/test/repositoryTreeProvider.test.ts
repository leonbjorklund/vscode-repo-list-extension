import * as assert from 'assert';

import type { RepositoryEntry } from '../repository';
import type { RepoGroup } from '../repositoryGroup';
import {
  GroupTreeItem,
  isRepositoryActive,
  isRepositoryPathVisible,
  RepositoryTreeItem,
  RepositoryTreeProvider
} from '../repositoryTreeProvider';

class StubStore {
  constructor(
    private repositories: RepositoryEntry[],
    private groups: RepoGroup[] = []
  ) {}

  getRepositories(): RepositoryEntry[] {
    return this.repositories;
  }

  getGroups(): RepoGroup[] {
    return this.groups;
  }
}

suite('RepositoryTreeProvider', () => {
  test('returns ordered children with nested repository counts', async () => {
    const workGroup = { id: 'group-work', name: 'Work', order: 0 } satisfies RepoGroup;
    const childGroup = { id: 'group-child', name: 'Child', parentId: 'group-work', order: 0 } satisfies RepoGroup;
    const personalGroup = { id: 'group-personal', name: 'Personal', order: 2 } satisfies RepoGroup;
    const scratchRepo = { id: 'repo-scratch', name: 'scratch', path: 'C:\\Repos\\scratch', order: 1 };
    const childRepo = { id: 'repo-api', name: 'api', path: 'C:\\Repos\\api', groupId: 'group-child', order: 0 };
    const provider = new RepositoryTreeProvider(
      new StubStore([scratchRepo, childRepo], [workGroup, childGroup, personalGroup]),
      async () => true
    );

    const rootChildren = await provider.getChildren();
    const workChildren = await provider.getChildren(rootChildren[0]);

    assert.deepStrictEqual(rootChildren.map((item) => item.label), ['Work', 'scratch', 'Personal']);
    assert.ok(rootChildren[0] instanceof GroupTreeItem);
    assert.strictEqual(rootChildren[0].description, '1 repository');
    assert.strictEqual(rootChildren[0].contextValue, 'group');
    assert.ok(workChildren[0] instanceof GroupTreeItem);
    assert.strictEqual(workChildren[0].group, childGroup);
  });

  test('renders path visibility overrides and missing paths', async () => {
    const visibleRepo = { id: 'visible', name: 'visible', path: 'C:\\Repos\\visible', showPath: true };
    const hiddenMissingRepo = { id: 'hidden', name: 'hidden', path: 'C:\\Repos\\hidden', showPath: false };
    const defaultVisibleRepo = { id: 'default', name: 'default', path: 'C:\\Repos\\default' };
    const provider = new RepositoryTreeProvider(
      new StubStore([visibleRepo, hiddenMissingRepo, defaultVisibleRepo]),
      async (repoPath) => repoPath !== hiddenMissingRepo.path,
      undefined,
      undefined,
      () => true
    );

    const [visibleItem, hiddenMissingItem, defaultVisibleItem] = await provider.getChildren();

    assert.ok(visibleItem instanceof RepositoryTreeItem);
    assert.strictEqual(visibleItem.description, visibleRepo.path);
    assert.strictEqual(visibleItem.contextValue, 'repositoryPathVisible');
    assert.ok(hiddenMissingItem instanceof RepositoryTreeItem);
    assert.strictEqual(hiddenMissingItem.description, '(missing)');
    assert.strictEqual(hiddenMissingItem.contextValue, 'missingRepositoryPathHidden');
    assert.ok(defaultVisibleItem instanceof RepositoryTreeItem);
    assert.strictEqual(defaultVisibleItem.description, defaultVisibleRepo.path);
    assert.strictEqual(isRepositoryPathVisible(defaultVisibleRepo, true), true);
  });

  test('marks existing folder source groups revealable without warning on missing sources', async () => {
    const existingSource = {
      id: 'source',
      name: 'Source',
      sourcePath: 'C:\\Repos',
      order: 0
    } satisfies RepoGroup;
    const missingSource = {
      id: 'missing-source',
      name: 'Missing Source',
      sourcePath: 'C:\\Missing',
      order: 1
    } satisfies RepoGroup;
    const repo = { id: 'repo-api', name: 'api', path: 'C:\\Repos\\api', groupId: 'source', order: 0 };
    const provider = new RepositoryTreeProvider(
      new StubStore([repo], [existingSource, missingSource]),
      async (repoPath) => repoPath !== missingSource.sourcePath
    );

    const [existingItem, missingItem] = await provider.getChildren();

    assert.ok(existingItem instanceof GroupTreeItem);
    assert.strictEqual(existingItem.contextValue, 'folderSourceGroup');
    assert.ok(missingItem instanceof GroupTreeItem);
    assert.strictEqual(missingItem.contextValue, 'emptyGroup');
  });

  test('marks active repository by descendant workspace folder', async () => {
    const repo = { id: 'repo-portal', name: 'Portal', path: 'C:\\Repos\\Portal' };
    const provider = new RepositoryTreeProvider(
      new StubStore([repo]),
      async () => true,
      () => ['C:\\Repos\\Portal\\Portal.Frontend']
    );

    const [item] = await provider.getChildren();

    assert.ok(item instanceof RepositoryTreeItem);
    assert.strictEqual(item.label, 'Portal | Active');
    assert.strictEqual(item.tooltip, repo.path);
    assert.strictEqual(isRepositoryActive(repo.path, ['C:\\Repos\\Portal2']), false);
  });
});
