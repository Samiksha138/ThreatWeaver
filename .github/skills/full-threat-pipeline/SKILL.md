---
name: full-threat-pipeline
description: 'Run the complete threat modeling pipeline: fetch specs, analyze threats, generate DFD, and produce reports. Resumable via pipeline-state.json — picks up where it left off.'
---

# Full Threat Modeling Pipeline

## When to Use
- Running a complete threat assessment for a new feature
- Re-running full analysis after major spec overhaul
- Generating all outputs (threats + DFD + reports) in one go
- Resuming a pipeline that was interrupted mid-session

## Architecture

### State Machine
The pipeline tracks progress in `{featureFolder}/pipeline-state.json`. Each phase must complete (or be explicitly skipped) before advancing. If a session dies or context compresses, the next invocation reads the state file and resumes from the last incomplete phase.

### Knowledge Base
Each product has a `knowledge/` folder containing lesson-learned files (LESSON-001.md, LESSON-002.md, etc.). Before running threat analysis, relevant lessons are loaded as context to avoid repeating blind spots from prior analyses.

### Validation Gates
Before publishing to Confluence or creating Jira tickets, a validation gate checks:
- STRIDE category coverage (≥4/6 required, 6/6 recommended)
- Severity distribution (flags >80% Critical as suspicious)
- Mitigation presence (each threat must have remediation)
- Component specificity (threats must reference real components, not be generic)
- DFD-to-analysis alignment (DFD should reference components from the threats)

If validation fails, the pipeline blocks and reports errors. Fix the analysis before proceeding.

## Pipeline Phases

| # | Phase | Gate? | Description |
|---|-------|-------|-------------|
| 0 | Preflight | ✓ | Verify credentials, folder structure, spec exists |
| 1 | Fetch Spec | — | Fetch Confluence pages and/or repository code |
| 2 | Threat Analysis | — | STRIDE analysis with knowledge-base context |
| 3 | Validate Analysis | ✓ | Automated quality checks on output |
| 4 | Generate DFD | — | Draw.io data flow diagram |
| 5 | Generate Report | — | HTML + CSV report files |
| 6 | Publish to Confluence | ✓ | Writeback threat table + DFD attachment |
| 7 | Create Jira Tickets | ✓ | Issues for Critical/High threats |
| 8 | Wrapup | — | Capture lessons learned → knowledge base |

## Folder Structure (CRITICAL for Scan Workspace)

**⚠️ NEVER create a "Products/", "products/", "Projects/", or any wrapper folder. The product name folder goes DIRECTLY inside the workspace root.**

The dashboard's "Scan Workspace" expects this **exact** directory layout:
```
{workspace root}/
└── {ProductName}/              ← product folder DIRECTLY in workspace root (e.g. "MyApp")
    ├── knowledge/              ← lessons learned (product-level)
    └── {FeatureName}/          ← feature folder (e.g. "AuthService")
        └── {version}/          ← version folder (e.g. "v1.0" or "1.0")
            ├── feature-info.json    ← REQUIRED for scan pickup
            ├── pipeline-state.json  ← pipeline progress
            ├── jira-tickets.json    ← Jira dedup tracker
            ├── design/              ← only if Confluence URLs provided
            │   ├── threat-analysis.md
            │   └── dataflow-diagram.drawio
            └── repo/                ← only if repository URLs provided
                ├── threat-analysis.md
                └── dataflow-diagram.drawio
```

**Concrete example:** If workspace is `/home/user/threat-models` and product is "MyApp" with feature "Auth Service" version "1.0":
- ✅ CORRECT: `/home/user/threat-models/MyApp/Auth Service/1.0/repo/threat-analysis.md`
- ❌ WRONG: `/home/user/threat-models/Products/MyApp/Auth Service/1.0/repo/threat-analysis.md`

**Key rules:**
- `{featureFolder}` = `{workspace root}/{ProductName}/{FeatureName}/{version}/`
- `{productFolder}` = `{workspace root}/{ProductName}/`
- Scan Workspace picks up folders that have `feature-info.json` OR a `threat-analysis.md` in `design/` or `repo/`
- Product name and feature name should use readable names (spaces allowed, but underscores also work)

## Procedure

### Phase 0: Preflight
1. Read `pipeline-state.json` — if it exists, resume from last incomplete phase
2. **Create the folder structure directly in the workspace root** (NO "Products/" prefix):
   - Product folder: `{workspace root}/{ProductName}/`
   - Feature folder: `{workspace root}/{ProductName}/{FeatureName}/{version}/`
   - Only create `design/` subfolder if Confluence URLs are provided
   - Only create `repo/` subfolder if repository URLs are provided
   - Do NOT create `design/` if only repo URLs are given (and vice versa)
3. Create `{productFolder}/knowledge/` folder if it does not already exist
4. Create `{featureFolder}/feature-info.json` with all provided URLs and configuration (see format below). This is CRITICAL for the dashboard to pick up features via "Scan Workspace".
5. Check that at least one Confluence URL or repository URL is configured
6. If resuming, skip all phases already marked `completed` or `skipped`

**feature-info.json format:**
```json
{
  "name": "<feature name>",
  "version": "<version>",
  "confluenceUrls": ["<url1>", "<url2>"],
  "repositoryUrls": ["<repo-url1>"],
  "repositoryScope": "full",
  "confluenceWritebackUrl": "<writeback url if provided>",
  "jiraProjectKey": "<project key if provided>"
}
```

### Phase 1: Fetch Spec
**Only fetch sources that were actually provided. Do NOT fetch or generate content for missing sources.**

1. **If Confluence URLs are provided**: Fetch page content using `mcp_atlassian_getConfluencePage`
2. **If repository URLs are provided**:
   - **GitHub**: Use `mcp_mcp_github_get_file_contents` to browse repo structure and read key files
   - **Bitbucket (PR scope)**: Use Atlassian MCP tools to get PR changes for Bitbucket Cloud, or use the Bitbucket REST API for on-prem
   - **Bitbucket (full repo)**: Use Atlassian MCP tools to browse Bitbucket Cloud repositories. For on-prem Bitbucket, use the file browse REST API (`/rest/api/1.0/projects/{project}/repos/{repo}/browse/{path}`) if credentials are available.
3. If ONLY a repository URL is given and NO Confluence URLs exist → **skip Confluence fetch entirely. Do NOT produce any design-level output.**
4. If ONLY Confluence URLs are given and NO repository URLs exist → **skip repository fetch entirely. Do NOT produce any repo-level output.**
5. If Bitbucket MCP tools cannot browse files, note the limitation in `repo/threat-analysis.md`
6. Cache fetched content locally for use in subsequent phases

### Phase 2: Threat Analysis
1. Load relevant lessons from `{productFolder}/knowledge/` as prior context
2. Apply STRIDE methodology to all components, data flows, and trust boundaries
3. For each threat, document: Title, STRIDE Category, Severity, Component, Description, Impact, Mitigation
4. Follow the exact format defined in [STRIDE format rules](../../instructions/stride-format.instructions.md)
5. **Only if Confluence URLs were provided**: Save design analysis to `{featureFolder}/design/threat-analysis.md`
6. **Only if repository URLs were provided**: Save repo analysis to `{featureFolder}/repo/threat-analysis.md`
7. **Do NOT produce design analysis when only repository URLs are given** (and vice versa). Skip the subfolder entirely if no input was provided for it.

### Phase 3: Validate Analysis (GATE)
1. Run validation gate against all generated threat-analysis.md files
2. Check STRIDE coverage ≥ 4/6 categories (6/6 recommended)
3. Check severity distribution is realistic (not all Critical; flag if >80% are Critical)
4. Check every threat has mitigations
5. Check threats reference specific components (not generic)
6. If DFD already exists, check DFD-to-analysis alignment (DFD should reference components from the threats)
7. **If validation fails → STOP. Report errors. Do not proceed to Phase 4.**

### Phase 4: Generate DFD
1. Create data flow diagrams using draw.io XML format (see `.github/templates/dfd-template.drawio`)
2. Include: external entities, processes, data stores, data flows, trust boundaries
3. Ensure DFD components align with threats identified in Phase 2
4. **Only generate DFDs for the analyses that were produced in Phase 2:**
   - If design analysis was done → `{featureFolder}/design/dataflow-diagram.drawio`
   - If repo analysis was done → `{featureFolder}/repo/dataflow-diagram.drawio`

### Phase 5: Generate Report
1. **Do NOT generate HTML/CSV reports manually.** The extension dashboard generates formatted reports from the threat-analysis.md files with interactive tables, search, filter, sort, severity badges, and status tracking.
2. Instead, inform the user: "Reports are ready to generate. Use the Threat Modeling Dashboard → select the feature → click **Generate Report** to produce the formatted HTML and CSV reports."
3. If the user explicitly asks you to generate the report directly, open the ThreatWeaver Dashboard from the command palette and click **Generate Report**, or simply skip this phase.
4. Mark this phase as `completed` in pipeline-state.json

### Phase 6: Publish to Confluence (optional — skip if no writeback URL)
1. Validate again before publishing (re-run gate from Phase 3)
2. Ensure Confluence writeback page URL is configured in `feature-info.json`
3. Use `mcp_atlassian_updateConfluencePage` (or Confluence REST API `PUT /rest/api/content/{pageId}`) to update the page
4. Cloud URLs (`.atlassian.net`) use `/wiki` prefix in API paths; on-prem URLs do not
5. Upload `.drawio` DFD files as Confluence attachments via `POST /rest/api/content/{pageId}/child/attachment`

**Page structure to publish (must match dashboard output):**
```markdown
## Executive Summary
This threat model was automatically generated by ThreatWeaver on {date} for {featureName} (version {version}).
A total of {N} threats were identified using the STRIDE methodology:
| Severity | Count |
| --- | --- |
| 🔴 Critical | {count} |
| 🟠 High | {count} |
| 🟡 Medium | {count} |
| 🟢 Low | {count} |
| **Total** | **{total}** |

## 1. Context and Assumptions
- Source design documents and repositories listed here
- Analysis methodology: STRIDE

## 2. Data flow diagram
{{drawio:dfd-{label}.drawio:1200}}

## 3. STRIDE Threats & Mitigations
### 🔧 Repository Code Threats
| **Component / Trust Boundary** | **STRIDE Category** | **Threat Description** | **Threat Level** | **Mitigation** | **Mitigation Jira ticket** |
| --- | --- | --- | --- | --- | --- |
| {component} | {stride} | {description} | 🔴 Critical | • mitigation1<br/>• mitigation2 | [KEY-123](url) |

### 📄 Design-level Threats
(same table format)

## 4. Summary of Key Risks & Controls
(Only Critical/High threats listed here with their risk and control descriptions)
```

**Drawio macro format:** `{{drawio:filename.drawio:1200}}` — this gets converted to Confluence's `ac:structured-macro` during storage format conversion.

### Phase 7: Create Jira Tickets (optional — skip if no Jira config)
1. Requires Jira project key (from `feature-info.json`) and credentials configured
2. Parse threat-analysis.md and filter **Critical** and **High** severity threats only
3. Load existing `{featureFolder}/jira-tickets.json` to check for duplicates (match on `threatName`)
4. For each new Critical/High threat, create a Jira issue:
   - **Tool:** `mcp_jira_oss_jira_oss-jira_create_issue` (preferred) or REST API `POST /rest/api/2/issue`
   - **Summary:** `[Threat Model] {threat title}`
   - **Priority:** Critical severity → `Highest`, High severity → `High`
   - **Issue type:** `Task` (default) or as specified by user
   - **Description format:**
     ```
     **STRIDE Category:** {category}
     **Severity:** {severity}
     **Component:** {component}

     **Description**
     {description}

     **Impact**
     {impact}

     **Mitigations**
     - mitigation 1
     - mitigation 2
     ```
5. Save all created tickets to `{featureFolder}/jira-tickets.json`:
   ```json
   [
     {
       "threatName": "Threat title as it appears in analysis",
       "key": "SEC-123",
       "url": "https://jira.example.com/browse/SEC-123",
       "createdAt": "2026-05-05T10:30:00.000Z"
     }
   ]
   ```
6. If Confluence was already published, re-publish to include Jira ticket links in the table

### Phase 8: Wrapup
1. Ensure `{productFolder}/knowledge/` folder exists (create if missing)
2. Capture 1-3 lessons learned from this analysis as `{productFolder}/knowledge/LESSON-XXX.md` files
3. Each lesson file should use this format:
   ```markdown
   ---
   title: <short title>
   domain: <authentication|authorization|data-flow|networking|cryptography|input-validation|other>
   tags: [<relevant-tags>]
   product: <product-name>
   feature: <feature-name>
   createdAt: <ISO date>
   ---
   <insight body — 2-3 sentences about what was learned>
   ```
4. Mark pipeline as complete in `pipeline-state.json`

## Output Checklist
- [ ] `feature-info.json` — Feature metadata with URLs (REQUIRED for dashboard import)
- [ ] `pipeline-state.json` — Pipeline progress tracker (resumable)
- [ ] `design/threat-analysis.md` — Architecture-level threats **(only if Confluence URLs provided)**
- [ ] `design/dataflow-diagram.drawio` — Architecture data flow diagram **(only if Confluence URLs provided)**
- [ ] `repo/threat-analysis.md` — Code-level threats **(only if repository URLs provided)**
- [ ] `repo/dataflow-diagram.drawio` — Code-level data flow diagram **(only if repository URLs provided)**
- [ ] `jira-tickets.json` — Created Jira ticket references (if Jira enabled)
- [ ] Confluence writeback page updated (if publish enabled)
- [ ] `{productFolder}/knowledge/LESSON-XXX.md` — Lessons captured

**⚠️ CRITICAL RULE: If only repository URLs are given, produce ONLY `repo/` outputs. If only Confluence URLs are given, produce ONLY `design/` outputs. NEVER create outputs for a source that was not provided.**
