import * as assert from 'assert';
import * as vscode from 'vscode';

import { openRepository, type OpenRepositoryDependencies } from '../openRepository';
import type { RepositoryEntry } from '../repository';

function createDependencies(overrides: Partial<OpenRepositoryDependencies> = {}): OpenRepositoryDependencies & {
  executed: Array<{ command: string; args: unknown[] }>;
  errors: string[];
} {
  const executed: Array<{ command: string; args: unknown[] }> = [];
  const errors: string[] = [];

  return {
    executed,
    errors,
    pathExists: async () => true,
    executeCommand: async (command: string, ...args: unknown[]) => {
      executed.push({ command, args });
      return undefined;
    },
    showErrorMessage: async (message: string) => {
      errors.push(message);
      return undefined;
    },
    getOpenBehavior: () => 'newWindow',
    ...overrides
  };
}

suite('openRepository', () => {
  test('opens repository with configured window behavior', async () => {
    const repo: RepositoryEntry = { id: 'repo-1', name: 'api-server', path: 'C:\\Users\\Leon\\Repos\\api-server' };
    const dependencies = createDependencies({ getOpenBehavior: () => 'sameWindow' });

    await openRepository(repo, dependencies);

    assert.strictEqual(dependencies.executed[0].command, 'vscode.openFolder');
    assert.strictEqual((dependencies.executed[0].args[0] as vscode.Uri).toString(), vscode.Uri.file(repo.path).toString());
    assert.deepStrictEqual(dependencies.executed[0].args[1], { forceReuseWindow: true });
    assert.deepStrictEqual(dependencies.errors, []);
  });

  test('does not open missing repository path', async () => {
    const repo: RepositoryEntry = { id: 'repo-1', name: 'api-server', path: 'C:\\Users\\Leon\\Repos\\api-server' };
    const dependencies = createDependencies({ pathExists: async () => false });

    await openRepository(repo, dependencies);

    assert.deepStrictEqual(dependencies.executed, []);
    assert.deepStrictEqual(dependencies.errors, [`Repository path not found: ${repo.path}`]);
  });
});
