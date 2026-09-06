# ThreatWeaver — AI-Powered Threat Modeling (VS Code & Cursor IDE)

Automated, continuous STRIDE threat modeling inside VS Code and Cursor IDE — reads your Confluence design docs and code repositories, finds security threats via GitHub Copilot, and publishes results back to Confluence and Jira automatically.

![VS Code](https://img.shields.io/badge/VS%20Code-1.85.0+-blue.svg)
![Cursor IDE](https://img.shields.io/badge/Cursor%20IDE-Compatible-brightgreen.svg)
![Version](https://img.shields.io/badge/version-0.0.1-orange.svg)

> **⚠️ Prerequisite: GitHub Copilot Required**
> ThreatWeaver uses **GitHub Copilot** as its AI engine. An active [GitHub Copilot subscription](https://github.com/features/copilot) is required. Without it, threat analysis commands will not function.

---

## 🎬 Demo

https://github.com/Samiksha138/ThreatWeaver/assets/ThreatWeaver_Walkthrough.mp4

---

## 📐 Architecture

![ThreatWeaver Architecture](resources/Architecture_diagram.png)

> New here? Start with the **[Quick Start Guide](QUICKSTART.md)** for a step-by-step walkthrough.

---

## ✨ Key Features

- **AI-Powered Threat Analysis** — STRIDE-based security analysis via GitHub Copilot with dual-level assessment (code + design)
- **Multiple Confluence Pages** — Add multiple Confluence page URLs per feature for broader design coverage
- **Flexible Repository Analysis** — Three modes: PR diff, sub-directory, or whole-repo analysis
- **Interactive Dashboard** — Four-tab UI: Products, Threats, Reports, and Risk Score
- **Risk Score Dashboard** — Security posture score (0–100) with gauges, severity charts, and per-feature breakdowns
- **Publish to Confluence** — Write back threat results with design/code threat segregation and drawio DFD attachment
- **Jira Integration** — Auto-populate Jira tickets for Critical/High severity threats
- **HTML Reports** — Searchable, filterable reports with severity color-coding, status tracking, and persistent comments
- **PR Watcher** — Auto-detect new PRs and trigger security review
- **Confluence Watcher** — Auto-detect spec changes and trigger delta re-analysis with change summary
- **Scan Workspace** — Auto-import products/features created by `@threat-modeler` agent or `/full-threat-pipeline` skill into the dashboard
- **Knowledge Base** — Per-product lessons learned, auto-injected into analysis prompts for context-aware threat modeling
- **Validation Gate** — Pre-publish quality checks: STRIDE coverage, severity distribution, mitigation completeness, DFD alignment
- **Pipeline State Machine** — Resumable 9-phase pipeline (`pipeline-state.json`) for the `/full-threat-pipeline` skill
- **Copilot Customizations** — Slash commands, agents, skills, and auto-loaded instructions for STRIDE workflows
- **Auto-Update** — Self-hosted update via GitHub Releases
- **Cross-Platform** — Windows, macOS, Linux | VS Code and Cursor IDE

---

## 🚀 Installation & Prerequisites

### Requirements
- **VS Code** 1.85.0+ or **Cursor IDE**

### Optional Tokens (configure as needed)

| Token | Purpose | Format |
|-------|---------|--------|
| Atlassian email + API token | **Required** for publishing to Confluence | Email + token from [Atlassian API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| Bitbucket token | Repository analysis via MCP (Bitbucket Cloud via Atlassian MCP) | `BBDC-...` |
| GitHub PAT | Repository analysis via MCP | `ghp_...` (scope: `repo` or `public_repo`) |
| Jira PAT + Base URL | Create Jira tickets on on-prem Jira | PAT + `https://jira.your-company.com` |

### Install from VSIX
1. Download `threatweaver-latest.vsix` - [GitHub Releases](https://github.com/Samiksha138/ThreatWeaver/releases)
2. Open VS Code or Cursor IDE.
3. Go to Extensions → ⋯ menu → **"Install from VSIX..."**
4. Select the downloaded file

---

## 🎯 Quick Start

### Step 1 — Configure Credentials

1. Click the **🛡️ Shield icon** in the sidebar
2. Click **"🔑 Configure Credentials"**
3. Choose an option:
   - **🔧 Configure All Credentials** — Bitbucket + GitHub + Jira
   - **🏷️ Atlassian / Confluence** — Email + API Token (**required for Confluence publish**)
   - **🔗 Bitbucket Setup** — Bitbucket token
   - **🐙 GitHub Setup** — GitHub PAT
   - **🎫 Jira Setup (On-Prem)** — Jira PAT + base URL

### Step 2 — Start MCP Servers

1. Click **"▶️ Start MCP Servers"** in the sidebar
2. Wait for: *"✅ MCP servers started and mcp.json updated!"*

### Step 3 — Open the Dashboard

- Click **"🛡️ Open Dashboard"** in the sidebar, OR
- Command Palette: `Ctrl+Shift+P` → *"Threat Modeling: Open Threat Modeling Dashboard"*

### Step 4 — Create a Product (or Scan Workspace)

**Option A — Manual:**
1. In the **Products** tab, click **"+ Add Product"**
2. Enter product name (e.g., "MyApp")
3. Select the workspace folder

**Option B — Import from Agent:**
If you already used `@threat-modeler` or `/full-threat-pipeline` to create threat analysis files:
1. Click **"⟳ Scan Workspace"** in the Products tab
2. The extension discovers `{Product}/{Feature}/{Version}/design|repo/threat-analysis.md` folders
3. Matching products and features are automatically imported into the dashboard

### Step 5 — Add a Feature

1. Click **"+ Add Feature"** under your product
2. Fill in the form:
   - **Feature Name** — e.g., "Authentication Module"
   - **Version** — e.g., "1.0"
   - **Confluence URL(s)** — One or more page URLs (click "+ Add" for multiple)
   - **Repository URL** — Bitbucket or GitHub URL
   - **Repo Analysis Mode** — PR | Sub-directory | Whole Repo
   - **Confluence Writeback URL** — (Optional) Page to publish results back to
3. Click **"Add Feature"**

> At least one URL (Confluence or Repository) is required.

### Step 6 — Analyze Threats

1. Go to the **Threats** tab
2. Click **"Analyze Threats"** for your feature
3. Copilot Chat opens automatically with the analysis prompt
4. AI analyzes based on what you provided:
   - **Repository URL** → code-level vulnerabilities (saved to `repo/threat-analysis.md`)
   - **Confluence URL** → design-level architecture threats (saved to `design/threat-analysis.md`)
   - **Both** → comprehensive analysis

### Step 7 — Generate Report

1. Go to the **Reports** tab
2. Click **"Generate Report"** for your feature → interactive HTML report opens

### Step 8 — Publish to Confluence

- Click **"Publish to Confluence"** to write threat results to the configured writeback page
- Design-level and code-level threats appear under separate headings
- Drawio DFD files are attached automatically

### Step 9 — Create Jira Tickets (Optional)

- Click **"Create Jira Issues"** to auto-populate tickets for Critical/High threats
- Each threat → Jira issue with title, description, severity, and STRIDE category

### Step 10 — Stop MCP Servers

- Click **"⏹️ Stop MCP Servers"** in the sidebar when done

---

## 🤖 Copilot Customizations - VSCode

The extension auto-installs Copilot customization files into your workspace and user profile.

### Prompts (Slash Commands)

Type `/` in Copilot Chat:

| Command | When to Use |
|---------|-------------|
| `/threat-analyze` | New feature — provide Confluence/repo URLs for a full STRIDE analysis |
| `/delta-reanalyze` | Spec changed — reads existing threats + DFD and analyzes only what's different |
| `/pr-security-review` | PR ready — reviews only the changed lines |

### Agent (@threat-modeler)

Select in Copilot Chat agent picker. A persistent security architect persona for extended conversations — knows STRIDE methodology, output locations, and analysis modes.

### Skill (/full-threat-pipeline)

Type `/full-threat-pipeline` in Copilot Chat. Runs the entire pipeline end-to-end:
Gather inputs → Fetch content → STRIDE analysis → Generate DFDs → Validate format → Save files → Publish to Confluence → Create Jira tickets

> **Cursor IDE:** Use `@threat-modeler.md/full-threat-pipeline` — attach the agent file and type `/full-threat-pipeline` to run the complete pipeline.

> **Tip:** After using the agent or skill, click **"⟳ Scan Workspace"** in the Products tab to import the results into the dashboard.

### Instructions (Auto-Loaded)

| Instruction | Activates When | What It Does |
|-------------|---------------|---------------|
| `stride-format` | Editing `**/threat-analysis.md` | Forces exact STRIDE output format for report parser compatibility |
| `extension-dev` | Editing `src/**/*.ts` | Injects extension architecture context (esbuild, secrets, MCP) |

---


## 🔄 Automated Watchers (PR & Confluence)

### PR Watcher
1. Toggle **"🔀 PR Watch"** checkbox on a feature in the Threats tab
2. Watcher polls every 5 min (configurable via `aiThreatModeling.prWatchInterval`)
3. New/updated PR detected → Copilot Chat opens with PR threat analysis prompt
4. Notification confirms analysis has started

### Confluence Watcher
1. Toggle **"📄 Doc Watch"** checkbox on a feature in the Threats tab
2. Watcher polls at configured interval (default: 1 min, via `aiThreatModeling.confluenceWatchInterval`)
3. Page version change detected → reads existing threats + DFD → builds delta prompt → opens Copilot Chat
4. Output includes a **Change Summary** with new/removed/modified/unchanged threat counts

---


## 🔧 MCP Server Configuration (Reference)

The extension auto-configures MCP servers. This section is for reference or manual setup.

### mcp.json Location

| IDE | Windows | macOS | Linux |
|-----|---------|-------|-------|
| VS Code | `%APPDATA%\Code\User\mcp.json` | `~/Library/Application Support/Code/User/mcp.json` | `~/.config/Code/User/mcp.json` |
| Cursor | `~\.cursor\mcp.json` | `~/.cursor/mcp.json` | `~/.cursor/mcp.json` |

*Auto-detected based on your IDE.*

### Manual Configuration (Advanced)

**Windows:**
```json
{
    "inputs": [],
    "servers": {
        "atlassian": {
            "type": "stdio",
            "command": "npx",
            "args": ["-y", "mcp-remote@latest", "https://mcp.atlassian.com/v1/mcp"]
        }
    }
}
```

**macOS/Linux:**
```json
{
    "inputs": [],
    "servers": {
        "atlassian": {
            "type": "stdio",
            "command": "/bin/sh",
            "args": ["-c", "npx -y mcp-remote@latest https://mcp.atlassian.com/v1/mcp"]
        }
    }
}
```
---

## 🔒 Security

- **Credential Storage** — All tokens encrypted via VS Code SecretStorage API
- **No Hardcoded Tokens** — Credentials never in code or config files
- **Data Privacy** — Reports stored locally; data only sent to Confluence/Bitbucket/GitHub via MCP over HTTPS
- **Permissions Required**:
  - Confluence: Read + write (for publish-back)
  - Bitbucket: Read access
  - GitHub: `repo` or `public_repo` scope
  - Jira: Create issue permission

---

## 📁 Folder Structure

```
WorkspaceRoot/
└── ProductName/
    ├── knowledge/                         ← lessons learned (product-level)
    │   ├── LESSON-001.md
    │   └── LESSON-002.md
    └── FeatureName/
        └── v1.0/
            ├── product-info.json
            ├── feature-info.json
            ├── pipeline-state.json          ← resumable pipeline state
            ├── jira-tickets.json            ← deduplication for Jira issues
            ├── repo/                        ← only if repository URL provided
            │   ├── threat-analysis.md
            │   ├── dataflow-diagram.md
            │   └── dataflow-diagram.drawio
            ├── design/                      ← only if Confluence URL provided
            │   ├── threat-analysis.md
            │   ├── dataflow-diagram.md
            │   └── dataflow-diagram.drawio
            └── threat-report-combined-[timestamp].html
```

---

## 🛠️ Troubleshooting

#### "MCP credentials not configured"
Credentials not set up. Click sidebar 🛡️ → "🔑 Configure Credentials" → enter tokens → "▶️ Start MCP Servers".

#### "Atlassian credentials are required to publish to Confluence"
Publishing to Confluence requires Atlassian email and API token. Click sidebar 🛡️ → "🔑 Configure Credentials" → fill in **Atlassian / Confluence** section → Save. Generate your API token at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens).

#### "No workspace folder selected"
Open a folder first: `File → Open Folder`.

#### "GitHub Copilot not available"
Install GitHub Copilot extension, sign in with active subscription, restart IDE.

#### "Failed to fetch Confluence page"
1. Verify URL format (full URL or page ID)
2. Check MCP servers are running
3. View "MCP Confluence Server" output channel

#### "Failed to fetch repository"
1. Verify URL: Bitbucket (`https://bitbucket.company.com/projects/PROJ/repos/repo`) or GitHub (`https://github.com/owner/repo`)
2. Check MCP servers are running
3. View "MCP Repository Analysis" output channel

#### "At least one URL must be provided"
Provide at least one Confluence URL or Repository URL when adding a feature.

#### macOS: "spawn npx ENOENT"
Node.js/npx not in PATH. Install via `brew install node`, verify with `which npx`, add to `~/.zshrc` if needed: `export PATH="/opt/homebrew/bin:$PATH"`. Restart IDE.

### Debug Mode

1. Open Output panel (`View → Output` or `Ctrl+Shift+U`)
2. Select: **"MCP Confluence Server"** or **"MCP Repository Analysis"**

---

## � Knowledge Base

Each product maintains a `{ProductName}/knowledge/` folder with lessons learned from past analyses. The `@threat-modeler` agent and `/full-threat-pipeline` skill automatically create lesson files after each analysis.

### How It Works
- Lessons are stored as `LESSON-001.md`, `LESSON-002.md`, etc.
- Each lesson has YAML frontmatter: `title`, `domain`, `tags`, `product`, `feature`, `createdAt`
- Domains: `authentication`, `authorization`, `data-flow`, `networking`, `cryptography`, `input-validation`, `other`
- Relevant lessons are auto-injected into subsequent analysis prompts for context-aware threat modeling

### Lesson File Format
```markdown
---
title: "CHAP secrets exposed via REST endpoint"
domain: "cryptography"
tags: [Tri, iSCSI, CHAP]
product: "Tri"
feature: "SDL"
createdAt: 2026-05-06
---
The GetCHAP REST endpoint returns iSCSI CHAP secrets to any caller on the
plain HTTP interface without authentication, enabling credential exfiltration.
```

---

## ✅ Validation Gate

Before publishing to Confluence or creating Jira tickets, the extension can validate the `threat-analysis.md` quality:

| Check | Type | What It Verifies |
|-------|------|------------------|
| STRIDE coverage | Error if <4, warning if <6 | All 6 STRIDE categories should be addressed |
| Severity distribution | Warning | Flags if >80% are Critical (possible hallucination) or all same severity |
| Mitigation presence | Error | Each threat should have actionable mitigations |
| Component references | Warning | Threats should reference specific components, not be generic |
| DFD alignment | Warning | Components in the analysis should appear in the data flow diagram |
| File length | Error | Analysis must be ≥100 characters (not empty/stub) |

- **Command:** `Threat Modeling: Validate Threat Analysis` (programmatic — used by agents/skills before publish)
- **Result:** Returns `passed: true/false` with detailed `errors[]` and `warnings[]`

---

## 🔄 Pipeline State Machine

The `/full-threat-pipeline` skill uses a 9-phase state machine persisted in `pipeline-state.json` within each feature folder. This enables **resumable execution** — if a phase fails or the session ends, the pipeline picks up where it left off.

### Phases

| # | Phase | Description |
|---|-------|-------------|
| 0 | **Preflight** | Validate inputs, create folder structure, write `feature-info.json` |
| 1 | **Fetch Spec** | Retrieve Confluence pages and/or repository content via MCP |
| 2 | **Threat Analysis** | STRIDE analysis by Copilot — produces `threat-analysis.md` |
| 3 | **Validate Analysis** | Run Validation Gate checks on the output |
| 4 | **Generate DFD** | Create `dataflow-diagram.drawio` with Threat Modeling shapes |
| 5 | **Generate Report** | Produce HTML report via the dashboard report generator |
| 6 | **Publish Confluence** | Write results back to the Confluence writeback page |
| 7 | **Create Jira Tickets** | Create Jira issues for Critical/High threats |
| 8 | **Wrapup** | Save lessons learned, finalize state |

Phase statuses: `not-started` → `in-progress` → `completed` | `skipped` | `failed`. On re-run, completed phases are skipped and failed phases are retried from the exact point of failure.

---

## 🌍 Real-World Impact

Here are concrete examples of how ThreatWeaver helps teams in practice:

### Scenario 1 — New Feature, First Threat Model (15 minutes vs. 2-day workshop)
A developer ships a new authentication module. Traditionally, a security architect schedules a whiteboard session, manually walks through the design, and produces a threat model document — taking days. With ThreatWeaver:
1. Developer points the tool at the Confluence design page and the GitHub PR
2. Copilot analyzes both in parallel — design-level architecture threats + code-level implementation flaws
3. An interactive HTML report is ready in ~15 minutes, with Jira tickets auto-created for Critical findings

**Impact:** Security review that used to require a meeting and a 2-day turnaround happens automatically before the PR is merged.

---

### Scenario 2 — Spec Changed Mid-Sprint (Delta re-analysis)
An architect updates the authentication design in Confluence — adding a new OAuth flow. Without ThreatWeaver, nobody re-runs the threat model and the change silently introduces new risk. With ThreatWeaver:
1. Confluence Watcher detects the page version change automatically
2. Delta re-analysis runs against the updated spec, comparing against the existing threat model
3. Report shows: **2 NEW threats, 1 MODIFIED, 14 UNCHANGED** — analysts only review what changed

**Impact:** No threats slip through on spec updates. Existing threat IDs and audit history are preserved — no rework.

---

### Scenario 3 — Pre-Release Security Gate (Catching AI hallucinations)
Before a product release, the team publishes a threat model to Confluence. The AI produces a result, but the validation gate flags it:
- ❌ Only 2 of 6 STRIDE categories covered
- ⚠️ 85% of findings are Critical (statistically implausible — likely hallucination)

ThreatWeaver blocks the publish and prompts for re-analysis. The second run passes all checks cleanly.

**Impact:** Prevents incomplete or hallucinated threat models from being published as authoritative security documents.

---

### Scenario 4 — Continuous Security in a Monorepo (PR Watcher)
A large team merges 10–15 PRs per day. Manually reviewing each for security impact is impossible. With PR Watcher enabled:
1. Every new or updated PR is detected automatically
2. Copilot reviews only the changed lines — not the whole codebase
3. Security-relevant findings surface directly in the developer's Jira backlog

**Impact:** Security review scales with team velocity — no dedicated security bottleneck for every PR.

---

## 🛡️ Use Cases

| Role | How They Use It |
|------|----------------|
| **Security Engineers** | Automate threat modeling, generate consistent assessments, track remediation, share reports |
| **Development Teams** | Shift-left security, understand code change implications, maintain threat models alongside code |
| **Compliance & Audit** | Generate audit-ready reports, document analysis process, track resolution over time |

---

## 📋 Changelog

### v0.0.1 (Current)
Initial public release. See [Key Features](#-key-features) for the full feature list.

---

## 💬 Support

- **Issues**: [GitHub Issues](https://github.com/Samiksha138/ThreatWeaver/issues) or email samiksha138@gmail.com

---

## 🙏 Acknowledgments

- **GitHub Copilot** for AI-powered analysis
- **MCP (Model Context Protocol)** for Confluence, Bitbucket, GitHub, and Jira integration
- **VS Code Extension API** and **SecretStorage API** for secure, cross-platform operation
- HTTP-based MCP architecture (no Docker required)

---
