import * as assert from 'assert';
import * as vscode from 'vscode';

import {
  getConfiguredOpenBehavior,
  getConfiguredShowPathsByDefault,
  updateConfiguredOpenBehavior,
  updateConfiguredShowPathsByDefault
} from '../settings';

class MemoryConfiguration {
  public updates: Array<{
    section: string;
    value: unknown;
    target?: boolean | vscode.ConfigurationTarget;
  }> = [];

  constructor(private readonly values: Record<string, unknown> = {}) {}

  get<T>(section: string, defaultValue: T): T {
    return (this.values[section] ?? defaultValue) as T;
  }

  async update(
    section: string,
    value: unknown,
    configurationTarget?: boolean | vscode.ConfigurationTarget
  ): Promise<void> {
    this.updates.push({ section, value, target: configurationTarget });
  }
}

suite('settings helpers', () => {
  test('falls back to new window for invalid open behavior', () => {
    assert.strictEqual(getConfiguredOpenBehavior(new MemoryConfiguration({ openBehavior: 'invalid' })), 'newWindow');
    assert.strictEqual(getConfiguredOpenBehavior(new MemoryConfiguration({ openBehavior: 'sameWindow' })), 'sameWindow');
  });

  test('reads show paths default as disabled unless explicitly true', () => {
    assert.strictEqual(getConfiguredShowPathsByDefault(new MemoryConfiguration()), false);
    assert.strictEqual(getConfiguredShowPathsByDefault(new MemoryConfiguration({ showPathsByDefault: true })), true);
    assert.strictEqual(getConfiguredShowPathsByDefault(new MemoryConfiguration({ showPathsByDefault: false })), false);
  });

  test('persists settings globally', async () => {
    const configuration = new MemoryConfiguration();

    await updateConfiguredOpenBehavior('sameWindow', configuration);
    await updateConfiguredShowPathsByDefault(false, configuration);

    assert.deepStrictEqual(configuration.updates, [
      { section: 'openBehavior', value: 'sameWindow', target: vscode.ConfigurationTarget.Global },
      { section: 'showPathsByDefault', value: false, target: vscode.ConfigurationTarget.Global }
    ]);
  });
});
