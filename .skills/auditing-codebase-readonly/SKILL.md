---
name: auditing-codebase-readonly
description: Performs evidence-based, read-only audits of a codebase or workspace and reports what actually exists on disk rather than what a specification assumes. Use when asked to audit, inspect, or verify a repository, run a "Phase 0" audit, produce an implementation map (existing / missing / broken / duplicated / unsafe / needs refactor / blocked), verify which files and frameworks are really present, or assess a codebase without modifying anything. Covers absence-claim verification, spec-versus-reality mismatch reporting, and correcting unverified claims repeated from earlier reports.
---

## Overview

A read-only audit is a search for truth about a filesystem, not a confirmation of a document. It fails in one characteristic way: the auditor reports "missing" from a single check that could not have succeeded, and the report becomes fiction. Guard against that above all else.

The second failure mode is politeness toward the spec. If a brief names directories, frameworks, or files that do not exist, say so plainly and then audit the codebase that *is* there. Never inventory the requested paths as though they existed, and never imply you inspected something you could not open.

## When to apply

- "Audit the workspace / repository", "inspection only", "do not modify anything".
- "Verify what is actually on disk", "check whether X exists".
- A "Phase 0" audit, an implementation map, or a status review before starting work.
- Any request to assess whether earlier claims about a codebase still hold.

## Steps

1. **Enumerate before reading.** List the top level and the two levels below it before opening any file. Establish the real shape first; it tells you which of the named paths are even plausible.

2. **Check each specifically named path individually.** For every path the request names, test existence and print the verdict, rather than eyeballing a directory listing:
   `for f in <path1> <path2>; do [ -e "$f" ] && echo "EXISTS: $f" || echo "MISSING: $f"; done`

3. **Clear a whole stack in one combined search.** When a spec implies a language or framework, prove or disprove its presence with a single search covering several marker files at once (`*.py`, `pyproject.toml`, `alembic.ini`, `requirements*.txt`, `Pipfile`). One combined search settles a whole namespace; searching markers one at a time wastes turns and invites partial conclusions. Repeat the same idea for the framework's characteristic artifacts (migration directories, ORM model files, lockfiles).

4. **Re-verify every absence claim by a second, independent method before writing "missing".** A zero-result search is evidence you ran a search, not evidence of absence. Before publishing a MISSING finding, confirm it with a different pattern, a different case sensitivity, or a direct directory listing.

5. **Reorient and inventory what does exist.** Once you know the real stack, walk the actual tree: applications, packages, database layer, routes, auth, configuration, tests, CI, deployment. Read the entry points and the central config module — these reveal the architecture faster than any directory listing.

6. **Audit against the real codebase, not the assumed one.** Headline the mismatch first, then report each item of the original checklist against what exists (for example, an ORM-model checklist against a raw-SQL repository layer: report it as a naming caveat, not a defect). Do not invent an inventory for a stack that is not present.

7. **Categorize each finding** into the buckets the request asks for — typically EXISTING AND VALID, EXISTING BUT INCOMPLETE, BROKEN, MISSING, DUPLICATED, UNSAFE, NEEDS REFACTOR, BLOCKED BY EXTERNAL DEPENDENCY — naming the file and line for each and stating what would need to happen.

8. **Distinguish blocks from gaps.** An abstraction with a correct boundary and clearly reported unconfigured state (for instance, missing provider credentials surfacing an explicit not-configured error) is BLOCKED, not BROKEN and not MISSING. Say which external dependency is missing.

9. **Cross-check claimed features against their wiring.** A declaration is not an implementation. Confirm that a declared job, permission, constant, or route is actually registered, mounted, and reachable. Corpus evidence of a dead path is often a test asserting the dead behavior or a schema comment referring to it — those are strong signals, so quote them.

10. **Never repeat a number or claim from an earlier report without re-deriving it.** If you cannot re-verify it in this pass, mark it unconfirmed. Explicitly correct earlier claims that do not survive inspection; a correction is more valuable than consistency.

## Pitfalls

- **Malformed alternation in search patterns.** Escaped and unescaped forms are not interchangeable across tools: an escaped alternation passed to a tool expecting unescaped syntax, or vice versa, can silently match everything or nothing. If an alternation returns zero hits when you expected hits, suspect the pattern before concluding absence.
- **Case sensitivity.** A search for a lowercase identifier can miss the schema's uppercase form, and vice versa. When existence matters, drop case sensitivity or test both.
- **Piping output through `head`.** It converts a truncated result into an apparent total. If you limit output, say that you limited it.
- **Trusting a directory listing over a per-path test**, and trusting one grep over an independent second check.
- **Inventing the requested structure.** If the brief names a stack that is absent, that absence *is* the lead finding. Do not soften it, and do not fill the report with the missing shape.
- **Reading config values while auditing.** Print keys only, or lengths and non-secret flags, when you need to characterize a configuration file. Never surface secrets, even in an audit.

## Verification

- Every path the user named has an explicit EXISTS / MISSING verdict in the report.
- Every absence claim is backed by two independent checks, and the method is stated.
- The report names the real stack and flags any mismatch with the specification in the first section, not buried at the end.
- Each finding carries a file reference and an action, and is filed under one of the requested categories.
- No file was created, modified, or deleted, and no commit was attempted — state this explicitly when the request was read-only.
- Any claim you could not re-verify this pass is labelled unconfirmed rather than repeated.
