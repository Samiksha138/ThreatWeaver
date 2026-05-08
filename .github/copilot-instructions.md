# ThreatWeaver - Copilot Instructions

## Project Overview
This is a VS Code extension for automated threat modeling that integrates with Copilot Chat and Confluence MCP server.

## Key Features
- Product management dashboard with Confluence integration
- Automated threat analysis using Copilot Chat
- Report generation in HTML and CSV formats
- Publish threat analysis to Confluence writeback page (REST API with drawio macro support)
- Jira ticket creation for Critical/High threats (on-prem REST API with deduplication)
- Folder structure organized by product/feature/version
- PR watcher — auto-detects new pull requests and triggers security review
- Confluence watcher — auto-detects spec changes and triggers delta re-analysis

## Copilot Customizations

### Prompts (type `/` in chat)
| Prompt | Purpose |
|--------|---------|
| `/threat-analyze` | Run STRIDE threat analysis on Confluence specs or repo code |
| `/delta-reanalyze` | Incremental re-analysis when a spec has changed |
| `/pr-security-review` | Security review focused on PR diff only |

### Agents (select in agent picker)
| Agent | Purpose |
|-------|---------|
| `@threat-modeler` | Dedicated security architect agent for all threat modeling tasks |

### Skills (type `/` in chat)
| Skill | Purpose |
|-------|---------|
| `/full-threat-pipeline` | End-to-end: fetch specs → analyze threats → generate DFD → publish to Confluence → create Jira tickets |

### Instructions (auto-loaded)
| Instruction | Trigger |
|-------------|---------|
| `stride-format` | Auto-loaded when editing `**/threat-analysis.md` files |
| `extension-dev` | Auto-loaded when editing `src/**/*.ts` files |

## Development Status
- [x] Create copilot-instructions.md file
- [x] Get VS Code extension project setup info
- [x] Scaffold VS Code extension project
- [x] Create webview dashboard UI
- [x] Implement product management logic
- [x] Implement Analyze Threats feature
- [x] Implement Generate Report feature
- [x] Install dependencies and compile
- [x] Test and document the extension

## Project Structure
```
.github/
├── prompts/                  # Copilot prompt files (slash commands)
│   ├── threat-analyze.prompt.md
│   ├── delta-reanalyze.prompt.md
│   └── pr-security-review.prompt.md
├── instructions/             # Auto-loaded context for file types
│   ├── stride-format.instructions.md
│   └── extension-dev.instructions.md
├── agents/                   # Custom Copilot agents
│   └── threat-modeler.agent.md
├── skills/                   # Multi-step workflow skills
│   └── full-threat-pipeline/SKILL.md
└── copilot-instructions.md   # This file (workspace-level instructions)
src/
├── extension.ts              # Main extension activation
├── dashboardPanel.ts         # Webview UI for product management
├── productManager.ts         # CRUD operations for products
├── threatAnalyzer.ts         # Copilot Chat integration for threat analysis
├── reportGenerator.ts        # PDF and Excel report generation
├── prWatcher.ts              # PR polling and auto-analysis
├── confluenceWatcher.ts      # Confluence page change detection
├── mcpManager.ts             # MCP server management
└── sidebarProvider.ts        # Sidebar view provider
```

## Integrations

### Publish to Confluence
- Requires Atlassian email + API token (sidebar → Configure Credentials)
- Builds a threat table with severity badges, STRIDE categories, mitigations, and Jira ticket links
- Uploads `.drawio` DFD files as attachments → embeds via `drawio` macro
- Cloud (`.atlassian.net`): `/wiki` prefix; on-prem: no prefix

### Jira Ticket Creation
- Requires Jira base URL, project key, and PAT (sidebar → Configure Credentials)
- Creates issues for Critical/High threats via `/rest/api/2/issue`
- Deduplicates via `{featureFolder}/jira-tickets.json`
- Confluence publish table auto-includes "Mitigation Jira ticket" column

## How to Test
1. Press `F5` to launch Extension Development Host
2. In the new window, open Command Palette (`Ctrl+Shift+P`)
3. Run: "Threat Modeling: Open Threat Modeling Dashboard"
4. Add a product with Confluence page ID
5. Click "Analyze Threats" to test Copilot integration
6. Click "Publish to Confluence" to test Confluence writeback
7. Click "Create Jira Tickets" to test Jira integration
8. Click "Generate Report" to test HTML/CSV generation

## Key Commands
- `npm run compile` - Build the extension
- `npm run watch` - Watch mode for development
- `npm run package` - Create VSIX package
