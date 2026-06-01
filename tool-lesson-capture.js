#!/usr/bin/env node
// PostToolUse / PostToolUseFailure hook.
// - Detects tool errors from the stdin JSON payload.
// - Computes a sha1 signature on (tool_name, normalized_error).
// - Known signature → bump count in errors.json and exit silently.
// - Novel signature → record + inject `additionalContext` nudging the model
//   to append a one-line rule to lessons.md.
//
// Reads ~/.claude/tool-lessons/{errors.json,audit.jsonl,lessons.md}.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || process.env.HOME;
const BASE = process.env.TOOL_LESSONS_DIR || path.join(HOME, '.claude', 'tool-lessons');
const ERRORS_FILE = path.join(BASE, 'errors.json');
const AUDIT_FILE = path.join(BASE, 'audit.jsonl');
const LESSONS_FILE = path.join(BASE, 'lessons.md');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function isErrorResponse(input) {
  if (input.hook_event_name === 'PostToolUseFailure') return true;
  const resp = input.tool_response;
  if (!resp) return false;
  if (resp.is_error === true) return true;
  if (typeof resp.error === 'string' && resp.error.length > 0) return true;
  // Only scan content for error patterns when the response is a bare string.
  // For object responses, `content` typically holds the tool's success payload
  // (e.g. the file body just written), which would generate false positives.
  if (typeof resp !== 'string') return false;
  return /^(error|inputvalidationerror|tool error|validation error)[:\s]/i.test(resp) ||
         /exceeds \d+ tokens? limit/i.test(resp) ||
         /file has not been read yet/i.test(resp) ||
         /string to replace not found in file/i.test(resp) ||
         /file does not exist/i.test(resp) ||
         /command not found/i.test(resp);
}

function extractErrorMessage(input) {
  // PostToolUseFailure (e.g. a failed Bash command, an errored Agent/MCP call)
  // carries the message at the top-level `error` field and ships no
  // `tool_response`. Read it first, stripping the leading "Exit code N" line so
  // the signature keys on the real message. Commands that exit non-zero with no
  // output collapse to '' and get filtered upstream (grep no-match, test, etc.).
  if (typeof input.error === 'string' && input.error.length > 0) {
    return input.error.replace(/^Exit code \d+\s*/i, '');
  }
  const resp = input.tool_response;
  if (!resp) return '';
  if (typeof resp === 'string') return resp;
  if (typeof resp.error === 'string') return resp.error;
  if (typeof resp.content === 'string') return resp.content;
  if (typeof resp.output === 'string') return resp.output;
  if (typeof resp.result === 'string') return resp.result;
  if (Array.isArray(resp.content)) {
    return resp.content.map((c) => (typeof c === 'string' ? c : (c && c.text) || '')).join('\n').slice(0, 800);
  }
  try { return JSON.stringify(resp).slice(0, 800); } catch { return ''; }
}

function normalizeError(msg) {
  return msg
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/[A-Z]:\\[^\s"']+/g, '<path>')
    .replace(/\/[^\s"']+\/[^\s"']+/g, '<path>')
    .replace(/['"][^'"\n]{1,80}['"]/g, '<value>')
    .replace(/\b\d{2,}\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function sig(tool, norm) {
  return crypto.createHash('sha1').update(`${tool}::${norm}`).digest('hex').slice(0, 12);
}

function audit(event) {
  try {
    if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  } catch {}
}

function loadErrors() {
  try { return JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf8') || '{}'); }
  catch { return {}; }
}

function saveErrors(errors) {
  const tmp = ERRORS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(errors, null, 2));
  fs.renameSync(tmp, ERRORS_FILE);
}

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!isErrorResponse(input)) process.exit(0);
  // User-cancelled / interrupted tools surface as failures but are not
  // tool-discipline traps worth learning from. Skip them.
  if (input.is_interrupt === true) process.exit(0);

  const tool = input.tool_name || 'unknown';
  const msg = extractErrorMessage(input);
  if (!msg) process.exit(0);
  const norm = normalizeError(msg);
  if (!norm) process.exit(0);
  const s = sig(tool, norm);

  if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true });

  const errors = loadErrors();
  const existing = errors[s];
  const now = new Date().toISOString();

  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.last_seen = now;
    saveErrors(errors);
    audit({ event: 'deduped', tool, sig: s, count: existing.count });
    process.exit(0);
  }

  errors[s] = {
    tool,
    error_normalized: norm,
    error_sample: msg.slice(0, 600),
    tool_input_sample: (() => {
      try { return JSON.stringify(input.tool_input || {}).slice(0, 400); }
      catch { return ''; }
    })(),
    first_seen: now,
    last_seen: now,
    count: 1,
  };
  saveErrors(errors);
  audit({ event: 'captured', tool, sig: s, novel: true });

  const excerpt = msg.replace(/\s+/g, ' ').trim().slice(0, 220);
  const nudge = [
    `<tool-lesson-capture>`,
    `A novel ${tool} error pattern was captured (sig: ${s}).`,
    `Error excerpt: ${excerpt}`,
    ``,
    `If this is a recurring trap (not a one-off transient failure), append a one-line preventive rule to ~/.claude/tool-lessons/lessons.md under a "## ${tool}" header (create the section if missing).`,
    ``,
    `Rule must be:`,
    `- Tool-discipline focused (how to call the tool, not which file failed)`,
    `- Cross-project (generalize beyond the current repo)`,
    `- One line, no preamble, phrased preventively`,
    ``,
    `Example shape:  - When reading an unknown-size file, probe with limit: 100 first; switch to Grep if still too large.`,
    ``,
    `If the error is transient or environmental, do nothing — the signature is already logged.`,
    `</tool-lesson-capture>`,
  ].join('\n');

  const evt = input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse';
  const output = {
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: evt,
      additionalContext: nudge,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

main().catch((e) => { audit({ event: 'capture_crash', error: String(e) }); process.exit(0); });
