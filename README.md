# PG Analyst — PostgreSQL MCP Workbench

A full-stack data analyst workbench consisting of:
- **MCP Server** — PostgreSQL-backed Model Context Protocol server
- **Next.js Client** — Browser UI for data analysts

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Next.js Client (port 3000)                              │
│  ┌────────────┐ ┌───────────┐ ┌──────────┐ ┌─────────┐ │
│  │  Schema    │ │  SQL      │ │ Analysis │ │   AI    │ │
│  │  Explorer  │ │  Runner   │ │  Tools   │ │ Prompts │ │
│  └─────┬──────┘ └─────┬─────┘ └────┬─────┘ └────┬────┘ │
│        └──────────────┴────────────┴─────────────┘      │
│                        HTTP/SSE (MCP)                    │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  MCP Server (port 3001)                                  │
│                                                          │
│  Resources:          Tools:           Prompts:           │
│  • schemas://list    • execute_query  • explore_table    │
│  • schema://{name}   • sample_table  • funnel_analysis  │
│  • table://{s}/{t}   • column_stats  • cohort_analysis  │
│  • stats://database  • top_values    • anomaly_detect.  │
│                      • time_series   • join_analysis    │
│                      • correlation   • executive_summ.  │
│                      • data_quality                     │
│                      • search_value                     │
└──────────────────────┬───────────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────────┐
│  PostgreSQL Database                                     │
└──────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1. Configure the MCP Server

```bash
cd mcp-server
cp .env.example .env
# Edit .env with your PostgreSQL credentials
npm install
```

**`.env` settings:**
```env
PG_HOST=localhost
PG_PORT=5432
PG_DATABASE=your_database
PG_USER=your_username
PG_PASSWORD=your_password
PG_SSL=false
MCP_TRANSPORT=http          # Use 'http' for the Next.js UI
MCP_SERVER_PORT=3001
ALLOWED_ORIGIN=http://localhost:3000
```

### 2. Start the MCP Server

```bash
cd mcp-server
npm start
# → MCP server running on http://localhost:3001/mcp
# → Health check: http://localhost:3001/health
```

### 3. Configure the Next.js Client

```bash
cd nextjs-client
cp .env.local.example .env.local
# .env.local: NEXT_PUBLIC_MCP_SERVER_URL=http://localhost:3001/mcp
npm install
npm run dev
# → http://localhost:3000
```

### 4. Log In

| Username | Password      | Role    |
|----------|---------------|---------|
| admin    | analyst2024!  | Admin   |
| analyst  | data@pass1    | Analyst |
| viewer   | view0nly!     | Viewer  |

---

## MCP Resources

| URI | Description |
|-----|-------------|
| `schemas://list` | All non-system schemas in the database |
| `schema://{schemaName}` | All tables in a schema with column counts |
| `table://{schema}/{table}` | Full schema: columns, indexes, foreign keys |
| `stats://database` | Table sizes, row counts, vacuum stats |

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `execute_query` | Run any read-only SELECT (write ops blocked) |
| `sample_table` | TABLESAMPLE rows from a table |
| `column_stats` | Min/max/avg/nulls/distinct for a column |
| `top_values` | Most frequent values with percentages |
| `time_series` | Aggregate metric over time (day/week/month…) |
| `correlation` | Pearson correlation between two numeric columns |
| `data_quality_check` | Null rates, duplicate count, per-column audit |
| `search_value` | Full-text search across all varchar/text columns |

---

## MCP Prompts

| Prompt | Use Case |
|--------|----------|
| `explore_table` | Full EDA: schema → samples → stats → quality report |
| `funnel_analysis` | Conversion funnel with ordered-step SQL |
| `cohort_analysis` | Retention cohort matrix |
| `anomaly_detection` | Z-score + IQR outlier detection |
| `join_analysis` | Cardinality check + optimized JOIN strategy |
| `executive_summary` | KPIs, trends, alerts for stakeholder reporting |

---

## Using with Claude Desktop (stdio mode)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pg-analyst": {
      "command": "node",
      "args": ["/path/to/mcp-server/src/index.js"],
      "env": {
        "PG_HOST": "localhost",
        "PG_PORT": "5432",
        "PG_DATABASE": "your_db",
        "PG_USER": "your_user",
        "PG_PASSWORD": "your_pass",
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## Security Notes

- All SQL queries run in **READ ONLY** transactions — INSERT/UPDATE/DELETE/DROP are blocked at the transaction level AND by keyword detection.
- Credentials in `authContext.tsx` are hardcoded for demo — replace with a real auth system (NextAuth, Clerk, etc.) for production.
- The MCP server validates CORS origin via `ALLOWED_ORIGIN` env var.
- Consider adding PostgreSQL row-level security (RLS) for multi-tenant scenarios.

## Local Setup (Mac)
- Install VSCode
- Install Git
  brew install git
  # Set up git identity
  git config --global user.name "Your Name"
  git config --global user.email "you@example.com"
  # Authenticate via SSH
  # Generate a key
  ssh-keygen -t ed25519 -C "you@example.com"

  # Copy the public key
  cat ~/.ssh/id_ed25519.pub | pbcopy

  # Then go to GitHub → Settings → SSH and GPG keys → New SSH key and paste it.

  # test Connection
  ssh -T git@github.com
  # Should say: Hi username! You've successfully authenticated.

- VS Code setup for Git
  # Install the code command so you can open VS Code from the terminal:

  # Open VS Code → press Cmd+Shift+P → type "Shell Command: Install 'code' command" → hit Enter

  # Now you can open any project:
  bashcd my-project
  code .

- Your first project workflow
  # Clone an existing repo
  git clone git@github.com:yourname/your-repo.git
  cd your-repo
  code .

  # --- OR --- start a new project
  mkdir my-project && cd my-project
  git init
  code .

- Git commands
  git status          # what's changed?
  git pull            # get latest from GitHub
  git checkout -b feature/my-feature   # create a new branch
  git add .           # stage all changes
  git commit -m "feat: add login page"
  git push origin feature/my-feature  # push branch to GitHub