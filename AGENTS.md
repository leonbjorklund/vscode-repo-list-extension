# Repo Launcher

VS Code extension that lists configured Git repositories in an Activity Bar view and opens them in one click. Supports folder scanning (4 levels deep), groups, and drag-and-drop reordering.

**Naming:** the folder is `vscode-repo-list-extension`, but the shipped extension is `repo-launcher` / "Repo Launcher" and every command and setting is namespaced `repoLauncher.*`. Use the `repoLauncher` name in code and UI.

## Commands

```powershell
npm install
npm run check-types   # typecheck only
npm run compile       # typecheck + esbuild bundle
npm run watch         # rebuild on change
npm test              # compile-tests + compile + vscode-test
npm run package       # production bundle
```

Bundles to `dist/extension.js` via esbuild; `tsconfig.json` emits to `out/` only for the test run. `npm test` downloads a VS Code build into `.vscode-test/` (gitignored, ~800 MB) — safe to delete anytime.

## Layout

- `src/extension.ts` — activation and command registration.
- `src/repositoryTreeProvider.ts` — the Activity Bar tree; `repositoryDragAndDrop.ts` handles reordering.
- `src/repositoryStore.ts` — persisted repository/group state; `repositoryGroup.ts` and `repository.ts` are the models.
- `src/repositoryDiscovery.ts` — folder scanning, honors `repoLauncher.scan.exclude`.
- `src/openRepository.ts` — window-open behavior; `settings.ts` reads config.
- `src/constants.ts` — config section/keys and `DEFAULT_SCAN_EXCLUDES`. `src/strings.ts` — string trim/normalize helpers, not a message catalog.
- `src/test/` — `vscode-test` suites, one per module.

## Rules

- User-facing messages are inlined at their `vscode.window.show*` call sites in `extension.ts`. There is no message catalog — don't invent one for a small change.
- Config keys belong in `constants.ts`, never as string literals in providers.
- Add a focused test in `src/test/` alongside behavior changes.
- No telemetry or network access — the extension only reads local paths.
