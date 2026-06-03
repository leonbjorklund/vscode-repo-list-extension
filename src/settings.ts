import * as vscode from 'vscode';

import {
  CONFIG_SECTION,
  OPEN_BEHAVIOR_CONFIG_KEY,
  SHOW_PATHS_BY_DEFAULT_CONFIG_KEY
} from './constants';

export type OpenBehavior = 'newWindow' | 'sameWindow';

interface ConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

interface ConfigurationWriter extends ConfigurationReader {
  update(
    section: string,
    value: unknown,
    configurationTarget?: boolean | vscode.ConfigurationTarget
  ): Thenable<void>;
}

function getRepoLauncherConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

export function normalizeOpenBehavior(value: unknown): OpenBehavior {
  return value === 'sameWindow' ? 'sameWindow' : 'newWindow';
}

export function getConfiguredOpenBehavior(
  configuration: ConfigurationReader = getRepoLauncherConfiguration()
): OpenBehavior {
  return normalizeOpenBehavior(configuration.get<OpenBehavior>(OPEN_BEHAVIOR_CONFIG_KEY, 'newWindow'));
}

export function getConfiguredShowPathsByDefault(
  configuration: ConfigurationReader = getRepoLauncherConfiguration()
): boolean {
  return configuration.get<boolean>(SHOW_PATHS_BY_DEFAULT_CONFIG_KEY, false) === true;
}

export async function updateConfiguredOpenBehavior(
  openBehavior: OpenBehavior,
  configuration: ConfigurationWriter = getRepoLauncherConfiguration()
): Promise<void> {
  await configuration.update(
    OPEN_BEHAVIOR_CONFIG_KEY,
    openBehavior,
    vscode.ConfigurationTarget.Global
  );
}

export async function updateConfiguredShowPathsByDefault(
  showPathsByDefault: boolean,
  configuration: ConfigurationWriter = getRepoLauncherConfiguration()
): Promise<void> {
  await configuration.update(
    SHOW_PATHS_BY_DEFAULT_CONFIG_KEY,
    showPathsByDefault,
    vscode.ConfigurationTarget.Global
  );
}
