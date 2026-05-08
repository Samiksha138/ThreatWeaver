---
description: "Use when editing VS Code extension source code in this project — threatAnalyzer.ts, dashboardPanel.ts, extension.ts, productManager.ts, prWatcher.ts, confluenceWatcher.ts"
applyTo: "src/**/*.ts"
---
# Extension Development Guidelines

## Architecture
- **esbuild** bundled, externals: `['vscode']` only
- Credentials stored in `context.secrets` — never hardcode tokens
- State persisted in `context.globalState`
- MCP integration generates prompt text for Copilot Chat — NOT direct API calls

## Key Patterns
- `ProductManager` — CRUD via `updateFeature()`. When adding new Feature fields, also add persistence in the `updateFeature()` method using `!== undefined` checks (not truthy checks, since `false` is valid)
- `ThreatAnalyzer` — builds prompt strings, invokes Copilot via `workbench.action.chat.open`
- `DashboardPanel` — webview with inline HTML/CSS/JS. Message handlers in the `_panel.webview.onDidReceiveMessage` switch block
- Watchers (PR, Confluence) — polling pattern with `globalState` for tracking, `startIfWatched()` on activation

## Confluence REST API
- Cloud (`.atlassian.net`): prefix `/wiki`
- On-prem: no prefix
- Auth: Basic with `atlassian.email` + `atlassian.apiToken` from `context.secrets`
- Publish flow: parse threats → build markdown table with severity badges + Jira links → convert to Confluence storage format → PUT page
- DFD publish: upload `.drawio` XML as attachment → embed via `<ac:structured-macro ac:name="drawio">` macro
- Timeouts: 30s for GET/PUT page, 15s for attachment check

## Jira REST API (On-Prem)
- Base URL from `context.secrets` key `jira.baseUrl`
- Auth: Bearer PAT from `context.secrets` key `jira.pat`
- Endpoint: `POST /rest/api/2/issue` with `CREATE_ISSUES` permission check first
- Only creates tickets for **Critical** and **High** severity threats
- Deduplication: tracks created tickets in `{featureFolder}/jira-tickets.json`
- Issue type fallback: tries configured type first, falls back to `Task`
- Confluence publish table includes a "Mitigation Jira ticket" column linking to created issues

## Testing After Changes
Always run `npm run compile` to verify. The build chain: `check-types` → `lint` → `esbuild`.
