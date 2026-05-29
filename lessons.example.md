# Tool Lessons

Preventive rules learned from past tool-call errors. The PreToolUse hook
surfaces the matching section before each tool runs.

See `README.md` for format and contribution rules.


## Read
- When reading an unknown-size file, probe with `limit: 100` first; switch to Grep if still too large.

## Edit
- If "old_string not unique", add 2-3 surrounding lines for context, or use replace_all when renaming.
