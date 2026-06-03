import * as assert from 'assert';
import * as vscode from 'vscode';

import { discoverRepositoriesFromFolders, type RepositoryDiscoveryFileSystem } from '../repositoryDiscovery';

class MemoryFileSystem implements RepositoryDiscoveryFileSystem {
  constructor(
    private readonly directories = new Map<string, Array<[string, vscode.FileType]>>(),
    private readonly stats = new Map<string, vscode.FileType>()
  ) {}

  async readDirectory(uri: vscode.Uri): Promise<Array<[string, vscode.FileType]>> {
    const entries = this.directories.get(uri.fsPath);
    if (!entries) {
      throw new Error(`missing directory: ${uri.fsPath}`);
    }

    return entries;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const type = this.stats.get(uri.fsPath);
    if (type === undefined) {
      throw new Error(`missing stat: ${uri.fsPath}`);
    }

    return { type, ctime: 0, mtime: 0, size: 0 };
  }
}

suite('repository discovery', () => {
  test('returns selected git folder as manual repository path', async () => {
    const folder = vscode.Uri.file('C:\\Repos\\api');
    const fs = new MemoryFileSystem(undefined, new Map([
      [vscode.Uri.joinPath(folder, '.git').fsPath, vscode.FileType.Directory]
    ]));

    const result = await discoverRepositoriesFromFolders([folder], fs);

    assert.deepStrictEqual(result, {
      manualRepositoryPaths: [folder.fsPath],
      folderSources: [],
      manualCandidatePaths: []
    });
  });

  test('discovers nested folder sources in deterministic order', async () => {
    const folder = vscode.Uri.file('C:\\Repos');
    const alpha = vscode.Uri.joinPath(folder, 'Alpha');
    const alphaRepo = vscode.Uri.joinPath(alpha, 'alpha-repo');
    const nc = vscode.Uri.joinPath(folder, 'NC');
    const web = vscode.Uri.joinPath(nc, 'web');
    const zeta = vscode.Uri.joinPath(folder, 'zeta');
    const fs = new MemoryFileSystem(
      new Map([
        [folder.fsPath, [
          ['zeta', vscode.FileType.Directory],
          ['notes.txt', vscode.FileType.File],
          ['NC', vscode.FileType.Directory],
          ['Alpha', vscode.FileType.Directory]
        ]],
        [alpha.fsPath, [
          ['alpha-repo', vscode.FileType.Directory]
        ]],
        [nc.fsPath, [
          ['web', vscode.FileType.Directory]
        ]]
      ]),
      new Map([
        [vscode.Uri.joinPath(alphaRepo, '.git').fsPath, vscode.FileType.Directory],
        [vscode.Uri.joinPath(web, '.git').fsPath, vscode.FileType.File],
        [vscode.Uri.joinPath(zeta, '.git').fsPath, vscode.FileType.Directory]
      ])
    );

    const result = await discoverRepositoriesFromFolders([folder], fs);

    assert.deepStrictEqual(result.folderSources, [
      {
        name: 'Repos',
        sourcePath: folder.fsPath,
        repositories: [zeta.fsPath],
        children: [
          {
            name: 'Alpha',
            sourcePath: alpha.fsPath,
            repositories: [alphaRepo.fsPath],
            children: []
          },
          {
            name: 'NC',
            sourcePath: nc.fsPath,
            repositories: [web.fsPath],
            children: []
          }
        ]
      }
    ]);
  });

  test('collapses wrapper folders and skips excluded folders', async () => {
    const home = vscode.Uri.file('C:\\Users\\Leon');
    const codex = vscode.Uri.joinPath(home, '.codex');
    const desktop = vscode.Uri.joinPath(home, 'Desktop');
    const repos = vscode.Uri.joinPath(desktop, 'Repos');
    const api = vscode.Uri.joinPath(repos, 'api');
    const documents = vscode.Uri.joinPath(home, 'Documents');
    const docsRepo = vscode.Uri.joinPath(documents, 'docs-repo');
    const fs = new MemoryFileSystem(
      new Map([
        [home.fsPath, [
          ['.codex', vscode.FileType.Directory],
          ['Desktop', vscode.FileType.Directory],
          ['Documents', vscode.FileType.Directory]
        ]],
        [desktop.fsPath, [
          ['Repos', vscode.FileType.Directory]
        ]],
        [repos.fsPath, [
          ['api', vscode.FileType.Directory]
        ]],
        [documents.fsPath, [
          ['docs-repo', vscode.FileType.Directory]
        ]]
      ]),
      new Map([
        [vscode.Uri.joinPath(codex, '.git').fsPath, vscode.FileType.Directory],
        [vscode.Uri.joinPath(api, '.git').fsPath, vscode.FileType.Directory],
        [vscode.Uri.joinPath(docsRepo, '.git').fsPath, vscode.FileType.Directory]
      ])
    );

    const result = await discoverRepositoriesFromFolders([home], fs, undefined, {
      collapseRedundantFolderSources: true,
      excludedFolderNames: ['.codex']
    });

    assert.deepStrictEqual(result.folderSources, [
      {
        name: 'Leon',
        sourcePath: home.fsPath,
        repositories: [],
        children: [
          {
            name: 'Repos',
            sourcePath: repos.fsPath,
            repositories: [api.fsPath],
            children: []
          },
          {
            name: 'Documents',
            sourcePath: documents.fsPath,
            repositories: [docsRepo.fsPath],
            children: []
          }
        ]
      }
    ]);
  });

  test('returns manual fallback candidate for one non-git folder', async () => {
    const folder = vscode.Uri.file('C:\\Repos\\docs');
    const fs = new MemoryFileSystem(new Map([[folder.fsPath, []]]));

    const result = await discoverRepositoriesFromFolders([folder], fs);

    assert.deepStrictEqual(result, {
      manualRepositoryPaths: [],
      folderSources: [],
      manualCandidatePaths: [folder.fsPath]
    });
  });
});
