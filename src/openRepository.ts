import * as vscode from 'vscode';

import { vscodePathExists } from './repositoryTreeProvider';
import type { RepositoryEntry } from './repository';
import { getConfiguredOpenBehavior, type OpenBehavior } from './settings';

export interface OpenRepositoryDependencies {
  pathExists(path: string): Thenable<boolean> | Promise<boolean>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown> | Promise<unknown>;
  showErrorMessage(message: string): Thenable<unknown> | Promise<unknown>;
  getOpenBehavior(): OpenBehavior;
}

export function getOpenFolderOptions(openBehavior: OpenBehavior): { forceNewWindow: true } | { forceReuseWindow: true } {
  return openBehavior === 'sameWindow' ? { forceReuseWindow: true } : { forceNewWindow: true };
}

export function createOpenRepositoryDependencies(): OpenRepositoryDependencies {
  return {
    pathExists: vscodePathExists,
    executeCommand: (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args),
    showErrorMessage: (message: string) => vscode.window.showErrorMessage(message),
    getOpenBehavior: getConfiguredOpenBehavior
  };
}

export async function openRepository(
  repository: RepositoryEntry,
  dependencies: OpenRepositoryDependencies = createOpenRepositoryDependencies()
): Promise<void> {
  if (!(await dependencies.pathExists(repository.path))) {
    await dependencies.showErrorMessage(`Repository path not found: ${repository.path}`);
    return;
  }

  await dependencies.executeCommand(
    'vscode.openFolder',
    vscode.Uri.file(repository.path),
    getOpenFolderOptions(dependencies.getOpenBehavior())
  );
}
