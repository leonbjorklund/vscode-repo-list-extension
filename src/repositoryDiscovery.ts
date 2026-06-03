import * as path from 'path';
import * as vscode from 'vscode';

const MAX_DISCOVERY_DEPTH = 4;

export interface RepositoryDiscoveryFileSystem {
  readDirectory(uri: vscode.Uri): Thenable<Array<[string, vscode.FileType]>>;
  stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
}

export interface DiscoveredFolderSource {
  name: string;
  sourcePath: string;
  repositories: string[];
  children: DiscoveredFolderSource[];
}

export interface RepositoryDiscoveryResult {
  manualRepositoryPaths: string[];
  folderSources: DiscoveredFolderSource[];
  manualCandidatePaths: string[];
}

export interface RepositoryDiscoveryOptions {
  excludedFolderNames?: readonly string[];
  collapseRedundantFolderSources?: boolean;
}

export async function discoverRepositoriesFromFolders(
  selectedFolders: vscode.Uri[],
  fileSystem: RepositoryDiscoveryFileSystem = vscode.workspace.fs,
  token?: vscode.CancellationToken,
  options: RepositoryDiscoveryOptions = {}
): Promise<RepositoryDiscoveryResult> {
  const manualRepositoryPaths: string[] = [];
  const folderSources: DiscoveredFolderSource[] = [];
  const manualCandidatePaths: string[] = [];
  const excludedFolderNames = createExcludedFolderNameSet(options.excludedFolderNames);

  for (const folder of selectedFolders) {
    if (token?.isCancellationRequested) {
      break;
    }

    if (await hasGitMetadata(folder, fileSystem)) {
      manualRepositoryPaths.push(folder.fsPath);
      continue;
    }

    const folderSource = await discoverFolderSource(folder, fileSystem, token, excludedFolderNames);
    if (folderSource) {
      folderSources.push(
        options.collapseRedundantFolderSources
          ? collapseRedundantFolderSource(folderSource)
          : folderSource
      );
    }

    if (selectedFolders.length === 1 && !folderSource) {
      manualCandidatePaths.push(folder.fsPath);
    }
  }

  return { manualRepositoryPaths, folderSources, manualCandidatePaths };
}

async function discoverFolderSource(
  folder: vscode.Uri,
  fileSystem: RepositoryDiscoveryFileSystem,
  token?: vscode.CancellationToken,
  excludedFolderNames = new Set<string>(),
  depth = 1
): Promise<DiscoveredFolderSource | undefined> {
  if (token?.isCancellationRequested) {
    return undefined;
  }

  let entries: Array<[string, vscode.FileType]>;
  try {
    entries = await fileSystem.readDirectory(folder);
  } catch {
    return undefined;
  }

  const repositories: string[] = [];
  const children: DiscoveredFolderSource[] = [];
  for (const [name, type] of entries.sort(compareDirectoryEntries)) {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    if (!hasFileType(type, vscode.FileType.Directory)) {
      continue;
    }

    if (excludedFolderNames.has(normalizeExcludedFolderName(name))) {
      continue;
    }

    const childFolder = vscode.Uri.joinPath(folder, name);
    if (await hasGitMetadata(childFolder, fileSystem)) {
      repositories.push(childFolder.fsPath);
      continue;
    }

    if (depth < MAX_DISCOVERY_DEPTH) {
      const childSource = await discoverFolderSource(childFolder, fileSystem, token, excludedFolderNames, depth + 1);
      if (childSource) {
        children.push(childSource);
      }
    }
  }

  if (repositories.length === 0 && children.length === 0) {
    return undefined;
  }

  return {
    name: path.basename(folder.fsPath),
    sourcePath: folder.fsPath,
    repositories,
    children
  };
}

function collapseRedundantFolderSource(source: DiscoveredFolderSource): DiscoveredFolderSource {
  const children = source.children.map(collapseRedundantFolderSource);

  if (source.repositories.length === 0 && children.length === 1) {
    return children[0];
  }

  return {
    ...source,
    children
  };
}

async function hasGitMetadata(folder: vscode.Uri, fileSystem: RepositoryDiscoveryFileSystem): Promise<boolean> {
  try {
    const stat = await fileSystem.stat(vscode.Uri.joinPath(folder, '.git'));
    return hasFileType(stat.type, vscode.FileType.Directory) || hasFileType(stat.type, vscode.FileType.File);
  } catch {
    return false;
  }
}

function createExcludedFolderNameSet(excludedFolderNames: readonly string[] | undefined): Set<string> {
  const result = new Set<string>();
  for (const name of excludedFolderNames ?? []) {
    const normalizedName = normalizeExcludedFolderName(name);
    if (normalizedName) {
      result.add(normalizedName);
    }
  }

  return result;
}

function normalizeExcludedFolderName(name: string): string {
  return name.trim().toLowerCase();
}

function hasFileType(actualType: vscode.FileType, expectedType: vscode.FileType): boolean {
  return (actualType & expectedType) === expectedType;
}

function compareDirectoryEntries([leftName]: [string, vscode.FileType], [rightName]: [string, vscode.FileType]): number {
  return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' }) ||
    leftName.localeCompare(rightName);
}
