// Zero-dependency tests for the tool-lessons hooks.
// Run with:  node --test   (Node 18+)
//
// Each test points TOOL_LESSONS_DIR at a fresh temp dir so the suite never
// touches your real ~/.claude/tool-lessons state.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CAPTURE = path.join(__dirname, 'tool-lesson-capture.js');
const INJECT = path.join(__dirname, 'tool-lesson-inject.js');

function freshBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tl-test-'));
}

// Run a hook with a JSON payload on stdin. Hooks always exit 0; stdout is
// either '' (silent) or a JSON hookSpecificOutput object.
function runHook(script, payload, base) {
  return execFileSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    env: { ...process.env, TOOL_LESSONS_DIR: base },
    encoding: 'utf8',
  });
}

function readErrors(base) {
  return JSON.parse(fs.readFileSync(path.join(base, 'errors.json'), 'utf8'));
}

// Unwrap the injected context string from a hook's JSON stdout ('' if silent).
function context(out) {
  if (!out) return '';
  return JSON.parse(out).hookSpecificOutput.additionalContext;
}

// ─── capture: the bug this release fixes ─────────────────────────────────────

test('captures a failed Bash command from the top-level `error` field', () => {
  const base = freshBase();
  const out = runHook(CAPTURE, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'gsd-sdk query config-get workflow.model_profile' },
    error: 'Exit code 1\nError: Key not found: workflow.model_profile',
    is_interrupt: false,
  }, base);

  assert.match(out, /tool-lesson-capture/);
  assert.match(out, /Error: Key not found/);
  assert.doesNotMatch(out, /Exit code 1/); // "Exit code N" prefix stripped

  const entries = Object.values(readErrors(base));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'Bash');
  assert.equal(entries[0].error_normalized, 'Error: Key not found: workflow.model_profile');
});

test('skips user-interrupted tools (is_interrupt: true)', () => {
  const base = freshBase();
  const out = runHook(CAPTURE, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'long-running' },
    error: 'Exit code 130\nInterrupted by user',
    is_interrupt: true,
  }, base);

  assert.equal(out, '');
  assert.ok(!fs.existsSync(path.join(base, 'errors.json')));
});

test('skips a non-zero exit with no message (e.g. grep no-match)', () => {
  const base = freshBase();
  const out = runHook(CAPTURE, {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'grep foo missing.txt' },
    error: 'Exit code 1',
    is_interrupt: false,
  }, base);

  assert.equal(out, '');
  assert.ok(!fs.existsSync(path.join(base, 'errors.json')));
});

test('dedupes a repeated error and stays silent the second time', () => {
  const base = freshBase();
  const payload = {
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'x' },
    error: 'Exit code 2\nError: something broke',
    is_interrupt: false,
  };

  const first = runHook(CAPTURE, payload, base);
  assert.match(first, /tool-lesson-capture/);

  const second = runHook(CAPTURE, payload, base);
  assert.equal(second, ''); // known signature → silent

  const entries = Object.values(readErrors(base));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 2);
});

// ─── capture: pre-existing paths must keep working ───────────────────────────

test('still captures bare-string error responses (Read on a missing file)', () => {
  const base = freshBase();
  const out = runHook(CAPTURE, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/nope' },
    tool_response: 'Error: File does not exist.',
  }, base);

  assert.match(out, /tool-lesson-capture/);
  assert.equal(Object.values(readErrors(base))[0].tool, 'Read');
});

test('ignores a successful tool call', () => {
  const base = freshBase();
  const out = runHook(CAPTURE, {
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi', stderr: '', interrupted: false },
  }, base);

  assert.equal(out, '');
  assert.ok(!fs.existsSync(path.join(base, 'errors.json')));
});

// ─── inject ──────────────────────────────────────────────────────────────────

test('inject surfaces only the matching tool section', () => {
  const base = freshBase();
  fs.writeFileSync(
    path.join(base, 'lessons.md'),
    '## Bash\n- Quote paths that contain spaces.\n\n## Read\n- Probe with limit first.\n',
  );

  const out = runHook(INJECT, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'x' },
  }, base);

  const ctx = context(out);
  assert.match(ctx, /tool-lessons tool="Bash"/);
  assert.match(ctx, /Quote paths that contain spaces/);
  assert.doesNotMatch(ctx, /Probe with limit/); // Read section must not leak
});

test('inject stays silent when no section matches', () => {
  const base = freshBase();
  fs.writeFileSync(path.join(base, 'lessons.md'), '## Read\n- Probe with limit first.\n');

  const out = runHook(INJECT, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: {},
  }, base);

  assert.equal(out, '');
});
