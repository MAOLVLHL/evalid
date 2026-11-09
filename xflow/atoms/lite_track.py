#!/usr/bin/env python3
"""
M4 lite fast-track: diff-size classifier (slice 1).

Decides whether a change is small enough to skip the spec ritual and run
seal (i6b) + clean replay only. The verdict is measured against the change's
merge-base, reusing M3 slice 2's importable parts from
``i6d_assertion_execution``: ``resolve_diff_base`` for the branch point,
``changed_lines`` / ``changed_lines_from_diff`` for the changed-line map.
Line/file counts come from ``git diff --numstat`` (added + removed, which
also catches deletion-only and binary files that the changed-line map
excludes by design).

Thresholds (initial values, see evalid #97 for the calibration):

* ``max_files = 10``, ``max_lines = 300`` (added + removed). This repo's own
  merged PRs calibrate it: routine slices / fixes / releases land at 4-28
  lines; the only recent feature slice above the line is P1-3 (#34, 330
  lines), which correctly stays full-track.
* Force-full overrides: any touched path under ``specs/`` or ``workflows/``
  flips the verdict to ``full`` -- the spec ritual exists precisely to catch
  drift there, so a small diff touching spec/workflow definitions must not
  skip it. An empty diff classifies ``lite``.
* Workflow-generated artifacts under ``specs/changes/<id>/`` do not count
  (slice 4, evalid #103): the workflow itself rewrites ``status.json``
  (+268 lines in the M4 demo) and writes proof artifacts (``tdd/``,
  ``cr/``, ``verify_proof.json``, ``spec_delta_review.*``) during a run,
  so a resume re-measuring the worktree would otherwise flip an auto-lite
  change to full on its own state. Human-authored spec files
  (``proposal.md`` / ``plan.md`` / ``tasks.md``) still force full.

CLI (always prints one JSON object; exit 0, exit 2 on git/usage errors)::

    python3 lite_track.py --repo . [--diff-base main] [--json]
    python3 lite_track.py --repo . --diff-file patch.diff [--json]
    python3 lite_track.py --repo . --max-files 10 --max-lines 300

The classifier is the *decision procedure*; the enforcement switch is the
explicit ``--lite`` flag on ``xflow workflow run``. Run the classifier
first and add ``--lite`` only when it says ``lite`` -- slice 1 does no
silent auto-switching.
"""

import argparse
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from i6d_assertion_execution import (  # noqa: E402
    changed_lines,
    changed_lines_from_diff,
    resolve_diff_base,
)

DEFAULT_MAX_FILES = 10
DEFAULT_MAX_LINES = 300
FORCE_FULL_PREFIXES = ("specs/", "workflows/")
VERSION = 1

# Files the workflow itself writes under specs/changes/<id>/ -- machine
# state and proof artifacts, not spec prose (slice 4, evalid #103).
GENERATED_CHANGE_FILES = (
    "status.json",
    "verify_proof.json",
    "spec_delta_review.json",
    "spec_delta_review.md",
)
GENERATED_CHANGE_DIRS = ("tdd/", "cr/")


def _is_generated_change_artifact(path):
    """True when ``path`` is workflow-generated state under a change dir.

    ``specs/changes/<id>/status.json`` is rewritten by the workflow on
    every run (stage transitions, integrity block); ``tdd/`` / ``cr/``
    hold sealed proofs and review output, ``verify_proof.json`` and
    ``spec_delta_review.*`` likewise. None of these is a human spec edit,
    so none of them may force the full track or inflate the measured
    diff. Anything else under ``specs/changes/<id>/`` -- in particular
    ``proposal.md`` / ``plan.md`` / ``tasks.md`` -- still counts.
    """
    parts = path.split("/")
    if len(parts) < 4 or parts[0] != "specs" or parts[1] != "changes":
        return False
    rest = parts[3:]
    if len(rest) == 1 and rest[0] in GENERATED_CHANGE_FILES:
        return True
    return bool(rest) and (rest[0] + "/") in GENERATED_CHANGE_DIRS


def _git(repo, *argv):
    proc = subprocess.run(
        ["git", *argv], cwd=repo, capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"git {' '.join(argv)} failed ({proc.returncode}): "
            f"{proc.stderr.strip()}"
        )
    return proc.stdout


def _numstat(repo, base_sha):
    """``{relpath: (added, removed)}`` from ``git diff --numstat``.

    Binary files report ``-`` counts; they count as a touched file with
    zero counted lines.
    """
    raw = _git(repo, "diff", "--numstat", base_sha, "HEAD", "--")
    stats = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        added_s, removed_s, path = line.split("\t", 2)
        added = 0 if added_s == "-" else int(added_s)
        removed = 0 if removed_s == "-" else int(removed_s)
        stats[path] = (added, removed)
    return stats


def _diff_text_files_and_counts(diff_text):
    """``(files, added, removed)`` parsed from a unified diff text.

    Counts ``+``/``-`` lines (excluding the ``+++``/``---`` headers);
    files come from the ``+++`` headers so deletion-only files are
    included, unlike the changed-line map.
    """
    files = []
    added = 0
    removed = 0
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target in ("/dev/null", ""):
                continue
            if target.startswith("b/"):
                target = target[2:]
            if len(target) >= 2 and target.startswith('"') and target.endswith('"'):
                target = json.loads(target)
            files.append(target)
        elif line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            removed += 1
    return files, added, removed


def _verdict(files, added, removed, max_files, max_lines):
    """Shared verdict logic. ``files`` are repo-relative paths."""
    total = added + removed
    force_full = sorted({path for path in files if path.startswith(FORCE_FULL_PREFIXES)})
    if force_full:
        which = "specs/" if any(p.startswith("specs/") for p in force_full) else "workflows/"
        return "full", (
            f"touches {which} paths ({', '.join(force_full)}): "
            "spec/workflow drift needs the full track"
        ), force_full
    if len(files) > max_files:
        return "full", (
            f"exceeds file budget: {len(files)} files > {max_files} max_files"
        ), []
    if total > max_lines:
        return "full", (
            f"exceeds line budget: {total} lines > {max_lines} max_lines"
        ), []
    if not files:
        return "lite", "empty diff: nothing to ritualise", []
    return "lite", (
        f"within thresholds ({len(files)} files, {total} lines "
        f"<= {max_files} files, {max_lines} lines)"
    ), []


def _numstat_worktree(repo, base_sha):
    """``{relpath: (added, removed)}`` from ``git diff --numstat`` of the
    working tree (staged + unstaged) against ``base_sha``.

    Binary files report ``-`` counts; they count as a touched file with
    zero counted lines.
    """
    raw = _git(repo, "diff", "--numstat", base_sha, "--")
    stats = {}
    for line in raw.splitlines():
        if not line.strip():
            continue
        added_s, removed_s, path = line.split("\t", 2)
        stats[path] = (
            0 if added_s == "-" else int(added_s),
            0 if removed_s == "-" else int(removed_s),
        )
    return stats


def classify_repo(repo, base="main", max_files=DEFAULT_MAX_FILES,
                  max_lines=DEFAULT_MAX_LINES, uncommitted=False):
    """Classify the committed (or, with ``uncommitted``, working-tree) diff."""
    base_sha = resolve_diff_base(repo, base)
    _, changed = changed_lines(repo, base, uncommitted=uncommitted)
    if uncommitted:
        # changed_lines(..., uncommitted=True) unions the working tree, so
        # the numstat side must measure that same union: the worktree diff
        # against the base. Merging the committed and worktree numstats
        # with max() overcounts whenever the worktree partially reverts
        # committed lines (a branch that added 10 lines, cut back by 5 in
        # the worktree, read as 15 changed lines instead of the true 5).
        stats = _numstat_worktree(repo, base_sha)
    else:
        stats = _numstat(repo, base_sha)
    # Workflow-generated artifacts under specs/changes/<id>/ are the
    # workflow's own state, not the change under review (slice 4): drop
    # them before the verdict so a resume cannot flip to full on its own
    # status.json rewrite, and so their lines cannot inflate the budget.
    stats = {
        path: counts
        for path, counts in stats.items()
        if not _is_generated_change_artifact(path)
    }
    files = sorted(stats)
    added = sum(a for a, _ in stats.values())
    removed = sum(r for _, r in stats.values())
    track, reason, force_full = _verdict(files, added, removed, max_files, max_lines)
    return {
        "version": VERSION,
        "track": track,
        "reason": reason,
        "files": len(files),
        "added": added,
        "removed": removed,
        "total": added + removed,
        "max_files": max_files,
        "max_lines": max_lines,
        "base": base_sha,
        "force_full": force_full,
        "changed_new_lines": sum(len(lines) for lines in changed.values()),
        "source": "repo",
    }


def classify_diff_text(diff_text, repo, max_files=DEFAULT_MAX_FILES,
                       max_lines=DEFAULT_MAX_LINES):
    """Classify a unified diff *text* (e.g. ``gh pr diff`` output)."""
    changed = changed_lines_from_diff(diff_text, repo)
    files, added, removed = _diff_text_files_and_counts(diff_text)
    track, reason, force_full = _verdict(files, added, removed, max_files, max_lines)
    return {
        "version": VERSION,
        "track": track,
        "reason": reason,
        "files": len(files),
        "added": added,
        "removed": removed,
        "total": added + removed,
        "max_files": max_files,
        "max_lines": max_lines,
        "base": None,
        "force_full": force_full,
        "changed_new_lines": sum(len(lines) for lines in changed.values()),
        "source": "diff-text",
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="M4 lite fast-track diff-size classifier.")
    parser.add_argument("--repo", default=".", help="repo to classify (default: .)")
    parser.add_argument("--diff-base", default="main", help="base branch (default: main)")
    parser.add_argument("--diff-file", default=None, help="classify a unified diff file instead of the repo diff")
    parser.add_argument("--max-files", type=int, default=DEFAULT_MAX_FILES)
    parser.add_argument("--max-lines", type=int, default=DEFAULT_MAX_LINES)
    parser.add_argument("--uncommitted", action="store_true",
                        help="include uncommitted working-tree edits (repo mode)")
    parser.add_argument("--json", action="store_true", help="print the verdict as JSON (default output)")
    args = parser.parse_args(argv)

    repo = os.path.realpath(args.repo)
    try:
        if args.diff_file:
            with open(args.diff_file, encoding="utf-8") as handle:
                diff_text = handle.read()
            result = classify_diff_text(diff_text, repo, args.max_files, args.max_lines)
        else:
            result = classify_repo(repo, args.diff_base, args.max_files, args.max_lines, args.uncommitted)
    except (RuntimeError, OSError) as exc:
        print(f"lite_track: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
