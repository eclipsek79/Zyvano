---
name: rotating-and-validating-secrets
description: Rotates, sets, and validates secrets (AUTH_SECRET, API keys, .env credentials) inside a repository without exposing the value in transcripts, logs, or argv, and verifies it against the project's real configuration gate. Use when the user asks to set, generate, rotate, update, or validate a secret such as AUTH_SECRET, a .env value, an API key, a token, or credentials, or to confirm a secret meets production requirements.
---

## Overview

The dangerous part of secret work is not writing the value — it's **proving it works without ever printing it**. A single off-by-one in masking code can leak a live credential into the transcript, where it is unrecoverable. Treat leakage as a hard failure requiring rotation, not an apology.

## When to apply

- "Set AUTH_SECRET in the workspace", "generate a secure secret", "rotate this key"
- "Validate the secret end to end", "does this meet the production requirement"
- Any .env / environment-variable credential change followed by a restart and behavior check

## Steps

1. **Never route the value through argv or a shell command line.** Anything in a command line lands in shell history, `ps`, and logs. Generate inside the writing process:
   ```js
   const next = execFileSync('python', ['-c', 'import secrets; print(secrets.token_urlsafe(64))']).toString('utf8').trim();
   ```
   `execFileSync` with an **argv array** (not a shell string) keeps the value out of `ps` too.

2. **Patch the file atomically, asserting exactly one match.** Read → `split('\n')` → map lines matching `/^AUTH_SECRET=/` → **fail if the count is not exactly 1** → write to `file + '.tmp'` with `{ mode: 0o600 }` → `renameSync` over the original. This avoids both duplicate keys and a truncated file on crash.

3. **Mask safely.** Build the mask from the value itself; never hand-count an offset:
   ```js
   const mask = (v) => v.slice(0, 4) + '*'.repeat(Math.max(0, v.length - 8)) + v.slice(-4);
   ```
   If slicing the value out of a line, derive the offset — `line.slice('AUTH_SECRET='.length)` — never a literal like `slice(11)`.

4. **Verify against the real gate, not a re-implementation.** Import the project's actual config module and vary **only** the variable under test, in an otherwise valid production-shaped environment (set every other production requirement so the case can't fail for an unrelated reason). Always include deliberately-failing control cases:
   - the real value → expect accepted
   - one unit below the minimum (e.g. 63 chars) → expect the specific error
   - a placeholder-prefixed value long enough to pass length → expect the placeholder error

   Without the failing controls, an "accepted" result proves nothing.

5. **Leak-scan the workspace.** Walk all files (skip `node_modules`, `.git`, `dist`), skipping binaries and files > ~5 MB, searching for both the **full value** and a distinctive ~24-char prefix. Report counts and paths only — never the match.

6. **Prove ignore rules with real semantics.** If the workspace has no `.git`, create a throwaway repo in `/tmp`, copy the `.gitignore` in, and run `git check-ignore -v` plus `git status --untracked-files=all`. Include a file that should *not* be ignored as a control.

7. **Restart every consumer** (API, worker) and confirm clean startup — no config errors, no stack traces.

8. **Test runtime behavior and report what you OBSERVE.** Do not echo the requester's assumption. If they expect rotation to invalidate sessions, actually replay a pre-rotation cookie and report the real status code, then explain the code-level reason if it differs.

## Pitfalls

- **Masking bugs leak secrets.** A hand-counted slice offset printed the middle of a length-86 secret into the transcript. **If a secret leaks: generate a new value, rotate immediately, re-verify, and say plainly that it happened.** Do not leave the exposed value in place.
- **tsx harness scripts must live inside the workspace.** A script in `/tmp` fails with `Cannot find module 'dotenv'` because `node_modules` resolution walks up from the script's location. Put scratch harnesses in a gitignored dir (e.g. `.zyvano/`) so they cannot pollute tracked files.
- **Top-level await fails** under tsx's CJS output (`ERR_REQUIRE_ASYNC_MODULE`). Wrap in `void (async () => { ... })()`.
- **`execFileSync` with `stdio: ['ignore','pipe','ignore']` hides the child's stderr**, producing an opaque `Command failed` with no message. Use `spawnSync` and read `res.stdout` / `res.stderr` so failures are diagnosable — otherwise you cannot tell a TypeScript error from a missing module.
- **Harness load order matters:** call `dotenv.config({ path })` **first** so required variables (e.g. `DATABASE_URL`) exist, then apply per-case overrides.
- **Error status codes collide.** Different guards can share one status (e.g. CSRF and email-verification are both 403). Discriminate on the error **code** in the body, and prove a gate passed by showing the code *changed*, not that the status changed.
- **A secret may be inert.** Config validation passing does not mean the value is consumed. Search for its consumers; if nothing reads it, rotation has no security effect — report that as the finding rather than claiming success.
- Confirm characters are pure ASCII so the JS string length and UTF-8 byte length agree; a byte-vs-char mismatch can make a length check mislead.

## Verification

Produce, at minimum, this evidence:

- masked value + exact character length + whether it starts with a placeholder prefix
- file mode of the target (expect `600`)
- the config-gate table: real value accepted, plus each failing control correctly rejected
- leak-scan file count and the count of non-target files containing the value (expect 0)
- ignore-rule proof from `git check-ignore`
- restart logs showing clean startup for every consumer
- observed auth/session behavior with the specific status codes
- a plain statement of what was **not** verified (e.g. no git repo present, so nothing was committed)
