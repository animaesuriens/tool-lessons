# tool-lessons

A tiny self-healing layer for [Claude Code](https://claude.com/claude-code) hooks.

When Claude hits a tool error (Read on a too-large file, Edit with a non-unique `old_string`, Bash with the wrong flag, etc.), this captures the error pattern, asks Claude to write a one-line preventive rule, and then quietly injects that rule before every future call to the same tool — so it doesn't make the same mistake twice.

Two Node scripts, three hook entries, zero dependencies.

---

## What you get

- **`tool-lesson-capture.js`** — `PostToolUse` + `PostToolUseFailure` hook. Detects tool errors, normalises them into a signature, dedupes, and nudges Claude to write a rule when it sees a novel pattern.
- **`tool-lesson-inject.js`** — `PreToolUse` hook. Before every tool call, looks up rules for that tool in `lessons.md` and prepends them to the model's context as a `<tool-lessons>` system reminder.
- **`lessons.example.md`** — a starter file with two example rules so you can see the format.

Runtime state (the registry of seen errors, the audit log, your accumulated rules) lives in `~/.claude/tool-lessons/` and is auto-created on first run.

---

## How it works

```
tool call errors
   │
   ▼
PostToolUse(Failure) hook  →  tool-lesson-capture.js
   │
   ├─ normalize error → sha1 signature
   ├─ if KNOWN sig in errors.json   → bump count, exit silently
   └─ if NOVEL sig                  → record, inject additionalContext
                                      nudging Claude to write a one-line
                                      rule into lessons.md
   ▼
[ later, on the next tool call ]
   │
PreToolUse hook  →  tool-lesson-inject.js
   │
   └─ reads lessons.md → finds the "## <ToolName>" section
                       → injects matching rules as <tool-lessons>
                         system-reminder before the tool runs
```

**Cost to Claude:**
- **Known error → zero Claude work.** Counter bump in `errors.json`, silent exit.
- **Novel error → one small Edit call.** Claude writes a new one-line rule to `lessons.md`. This is the "learning" event.
- **Every tool call thereafter → a handful of tokens.** The inject hook stitches the matching bullets into the context the upcoming tool call was already going to use. No extra API turn.

If a tool has no `## <ToolName>` section in `lessons.md`, the inject hook is silent.

---

## Install

### 1. Clone the scripts into your hooks directory

```bash
# macOS / Linux
mkdir -p ~/.claude/hooks
curl -fsSL https://raw.githubusercontent.com/animaesuriens/tool-lessons/main/tool-lesson-capture.js -o ~/.claude/hooks/tool-lesson-capture.js
curl -fsSL https://raw.githubusercontent.com/animaesuriens/tool-lessons/main/tool-lesson-inject.js  -o ~/.claude/hooks/tool-lesson-inject.js
```

```powershell
# Windows (PowerShell)
$dest = "$env:USERPROFILE\.claude\hooks"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/animaesuriens/tool-lessons/main/tool-lesson-capture.js" -OutFile "$dest\tool-lesson-capture.js"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/animaesuriens/tool-lessons/main/tool-lesson-inject.js"  -OutFile "$dest\tool-lesson-inject.js"
```

Or just clone the repo and copy the two `.js` files in.

### 2. Wire the hooks into `~/.claude/settings.json`

Add these three entries under `"hooks"`. If you already have other hooks, merge — don't replace.

**macOS / Linux:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/tool-lesson-inject.js", "timeout": 5 }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/tool-lesson-capture.js", "timeout": 5 }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/tool-lesson-capture.js", "timeout": 5 }
        ]
      }
    ]
  }
}
```

**Windows:** swap the command for the absolute `node.exe` path and the userprofile path:

```json
{ "type": "command",
  "command": "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/YOU/.claude/hooks/tool-lesson-inject.js\"",
  "timeout": 5 }
```

(Replace `YOU` with your Windows username. The same applies to the capture entries.)

Empty `"matcher": ""` means the hook fires on **every** tool — `Read`, `Edit`, `Bash`, `Grep`, anything. The inject hook silently does nothing for tools that have no rules yet.

### 3. (Optional) Seed `lessons.md`

```bash
# macOS / Linux
mkdir -p ~/.claude/tool-lessons
cp lessons.example.md ~/.claude/tool-lessons/lessons.md
```

```powershell
# Windows
$d = "$env:USERPROFILE\.claude\tool-lessons"
New-Item -ItemType Directory -Force -Path $d | Out-Null
Copy-Item lessons.example.md "$d\lessons.md"
```

Without this step the directory is auto-created on the first captured error and `lessons.md` starts empty.

### 4. Restart any open Claude Code sessions

Hooks are loaded at session start.

---

## Rule format

```markdown
## ToolName
- One-line preventive rule, cross-project, tool-discipline focused.
- Another rule.

## OtherTool
- ...
```

The inject hook only picks up lines starting with `-` under a `## ToolName` header.

**Good rules:**
- Tool-discipline focused — describe **how to call the tool**, not which file failed.
- Cross-project — generalise beyond one repo.
- One line, no preamble.
- Phrased preventively. "When X, do Y." / "Pass Z to avoid W."

| | |
|---|---|
| ✅ | `- When reading an unknown-size file, probe with limit: 100 first; switch to Grep if still too large.` |
| ❌ | `- STATE.md in myproject was too big to read without a limit.` |

---

## Runtime files (auto-created in `~/.claude/tool-lessons/`)

| File | Purpose | Owner |
|---|---|---|
| `lessons.md` | Active rules grouped by tool | Claude writes, inject hook reads |
| `errors.json` | Registry of error signatures → `{tool, normalized_error, count, first_seen, last_seen}` | capture hook |
| `audit.jsonl` | Append-only log of capture / dedup decisions, for debugging | capture hook |

None of these need to be committed anywhere — they're per-machine state.

---

## Disabling

Comment out or remove the three hook entries in `~/.claude/settings.json`. The scripts and runtime files can stay where they are; they do nothing without the hooks wiring them in.

---

## License

MIT. See `LICENSE`.
