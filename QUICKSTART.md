# 🛡️ ThreatWeaver — Quick Start Guide

> AI-powered threat modeling inside VS Code & Cursor IDE. From design spec to Jira ticket — automatically.

---

## 📐 How It Works

![Architecture Diagram](resources/Architecture_diagram.png)

---

## 🎬 See It In Action

> **Video walkthrough** — watch the full end-to-end demo before you begin.

https://github.com/Samiksha138/ThreatWeaver/assets/ThreatWeaver_Walkthrough.mp4

---

## ⚡ Installation (2 minutes)

1. Download **`threatweaver-latest.vsix`** from [GitHub Releases](https://github.com/Samiksha138/ThreatWeaver/releases/download/v0.0.1/threatweaver-latest.vsix)
2. Open **VS Code** or **Cursor IDE**
3. Go to **Extensions** → `⋯` menu → **"Install from VSIX…"**
4. Select the downloaded file — done ✅

**Prerequisites:** VS Code 1.85.0+ (or Cursor IDE) · GitHub Copilot active subscription

---

## 🔑 Step 1 — Configure Credentials

Click the **🛡️ Shield icon** in the sidebar → **"🔑 Configure Credentials"**

| Credential | Required For | Where to Get It |
|------------|-------------|-----------------|
| Atlassian email + API token | Publish to Confluence | [id.atlassian.com → API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| GitHub PAT (`ghp_…`) | GitHub repo + PR analysis | GitHub → Settings → Developer settings → PATs |
| Jira PAT + Base URL | Create Jira tickets (on-prem) | Jira → Profile → Personal Access Tokens |

> 💡 Atlassian credentials are **required** for Confluence publish. GitHub/Jira are optional.

<img width="841" height="506" alt="image" src="https://github.com/user-attachments/assets/cba8a834-5f17-4917-ac1d-f9084b24d425" />

---

## ▶️ Step 2 — Start MCP Servers

Click **"▶️ Start MCP Servers"** in the sidebar.

Wait for: *"✅ MCP Servers are running"*

<img width="346" height="35" alt="image" src="https://github.com/user-attachments/assets/15ca4cdc-18a3-4721-a43f-3a121ea9439d" />

---

## 🖥️ Way 1 — Use the Dashboard

### Open the Dashboard

Click **"🛡️ Open Dashboard"** in the sidebar.

<img width="972" height="482" alt="image" src="https://github.com/user-attachments/assets/11722549-1610-4126-bba0-8b854b563d34" />

---

### Add a Product

1. **Products** tab → **"+ Add Product"**
2. Enter a name (e.g., `PaymentService`) and select your workspace folder

<img width="733" height="476" alt="image" src="https://github.com/user-attachments/assets/f528149a-15a4-4de8-8340-4673789bd319" />

---

### Add a Feature

Click **"+ Add Feature"** under your product and fill in:

| Field | Example | Notes |
|-------|---------|-------|
| Feature Name | `Authentication Module` | What you're analyzing |
| Version | `1.0` | |
| Confluence URL(s) | `https://your-wiki.atlassian.net/wiki/…` | One or more design spec pages |
| Repository URL | `https://github.com/org/repo` | GitHub or Bitbucket |
| Repo Analysis Mode | `PR` / `Sub-directory` / `Whole Repo` | |
| Confluence Writeback URL | *(optional)* | Where to publish the threat model back |

> At least one URL (Confluence or Repository) is required.

<img width="725" height="512" alt="image" src="https://github.com/user-attachments/assets/ce1275f6-17d1-478f-8524-eaeaf73a355b" />

---

### Run Threat Analysis

1. Go to the **Threats** tab
2. Click **"🔍 Analyze Threats"** on your feature
3. Copilot Chat opens with the STRIDE analysis prompt — let it run

<img width="725" height="505" alt="image" src="https://github.com/user-attachments/assets/aabd6cc4-73fc-41c8-9f19-658efbd8c088" />



<img width="259" height="604" alt="image" src="https://github.com/user-attachments/assets/3f160ce4-c280-4532-b1a9-c9fb373d7588" />

---

### Generate & Publish Report

| Action | Tab | What It Does |
|--------|-----|-------------|
| **Generate Report** | Reports | Creates an interactive HTML + CSV report |
| **Publish to Confluence** | Threats | Writes threat model back to your wiki with DFD attached |
| **Create Jira Issues** | Threats | Auto-creates tickets for all Critical/High threats |


<img width="1195" height="719" alt="image" src="https://github.com/user-attachments/assets/503780e6-9526-4322-9570-c05824ffc275" />


<img width="794" height="701" alt="image" src="https://github.com/user-attachments/assets/7ce7de4a-6556-4ac5-bded-90f334596b00" />

---

## 💬 Way 2 — Use Copilot Chat

No dashboard needed. Just chat.

### VS Code

| What to type | What it does |
|--------------|-------------|
| `@threat-modeler` | Opens the security architect agent — describe your feature in natural language |
| `/full-threat-pipeline` | Runs the complete 8-phase pipeline end-to-end from a single prompt |
| `/threat-analyze` | One-off STRIDE analysis for a feature |
| `/pr-security-review` | Reviews only the changed lines in a PR |
| `/delta-reanalyze` | Re-analyzes only what changed since the last run |

### Cursor IDE

Attach the `@threat-modeler.md` agent file and type `/full-threat-pipeline`.

> 💡 After using Chat, click **"⟳ Scan Workspace"** in the Products tab to import results into the Dashboard automatically.


<img width="212" height="569" alt="image" src="https://github.com/user-attachments/assets/97a5da61-25af-47e8-925f-7c4b03903e1e" />


---

## 👁️ Optional — Enable Auto-Watch

Set it and forget it. ThreatWeaver watches for changes and triggers analysis automatically.

| Watcher | Toggle | Behaviour |
|---------|--------|-----------|
| **PR Watch** | Threats tab → 🔀 checkbox | Detects new/updated PRs every 5 min → auto-analyzes |
| **Doc Watch** | Threats tab → 📄 checkbox | Detects Confluence spec changes → auto-triggers delta re-analysis |


<img width="725" height="454" alt="image" src="https://github.com/user-attachments/assets/22bdebba-e188-4650-a4e5-62c3bb4e213b" />


---

## 📊 Understanding the Dashboard Tabs

| Tab | What you'll find |
|-----|----------------|
| 📦 **Products** | All your products and features — add, edit, scan workspace |
| ⚠️ **Threats** | Run analysis, toggle watchers, publish, create Jira tickets |
| 📊 **Reports** | Generate and view HTML reports |
| 📈 **Risk Score** | Security posture score (0–100) with severity breakdown per feature |

---

## 🗂️ Where Files Are Saved

```
WorkspaceRoot/
└── ProductName/
    ├── knowledge/              ← lessons learned (auto-built over time)
    └── FeatureName/v1.0/
        ├── design/
        │   ├── threat-analysis.md
        │   └── dataflow-diagram.drawio
        ├── repo/
        │   ├── threat-analysis.md
        │   └── dataflow-diagram.drawio
        └── threat-report-combined-[timestamp].html
```

---

## 🛟 Quick Troubleshooting

| Problem | Fix |
|---------|-----|
| MCP servers not starting | Check Node.js is installed (`node --version`). On macOS: `brew install node` |
| "Copilot not available" | Install GitHub Copilot extension and sign in |
| Confluence publish fails | Verify Atlassian email + API token in credentials panel |
| Analysis produces no output | Ensure at least one URL (Confluence or repo) is set on the feature |
| macOS "spawn npx ENOENT" | Add `export PATH="/opt/homebrew/bin:$PATH"` to `~/.zshrc` and restart IDE |

> **Output logs:** `View → Output` → select **"MCP Confluence Server"** or **"MCP Repository Analysis"**

---

## 📚 More

- Full documentation: [README.md](README.md)
- GitHub Releases: [github.com/Samiksha138/ThreatWeaver/releases](https://github.com/Samiksha138/ThreatWeaver/releases)
