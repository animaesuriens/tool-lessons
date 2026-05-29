#!/usr/bin/env node
// PreToolUse hook.
// - Reads ~/.claude/tool-lessons/lessons.md
// - Finds the "## <ToolName>" section matching the upcoming tool
// - If non-empty, injects the bullet lines as <tool-lessons> additionalContext
// - Silent (no output) when no matching section or no lessons exist

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const LESSONS_FILE = path.join(HOME, '.claude', 'tool-lessons', 'lessons.md');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function extractToolSection(content, tool) {
  const lines = content.split(/\r?\n/);
  const rules = [];
  let inSection = false;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      inSection = m[1].trim() === tool;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) rules.push(trimmed);
  }
  return rules;
}

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const tool = input.tool_name;
  if (!tool) process.exit(0);

  let content;
  try { content = fs.readFileSync(LESSONS_FILE, 'utf8'); } catch { process.exit(0); }
  const lessons = extractToolSection(content, tool);
  if (lessons.length === 0) process.exit(0);

  const reminder = [
    `<tool-lessons tool="${tool}">`,
    `From past errors with this tool, avoid the following:`,
    ...lessons,
    `</tool-lessons>`,
  ].join('\n');

  const output = {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: reminder,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch(() => process.exit(0));
