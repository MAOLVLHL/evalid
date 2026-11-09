#!/usr/bin/env python3
"""
I6d assertion-execution gate, slice 1: pytest-side assertion tracking.

M3 (parent #69) asks the green phase to prove that every added/changed
assertion really executed -- an assertion that never runs must not count
as green. The static I6c review already catches three decidable shapes
of wrong assertions; this module adds the runtime half for pytest:

* statically, AST-collect every ``assert`` statement in the collected
  test files (file, line, source, enclosing test);
* at runtime, trace executed lines with ``sys.settrace`` while pytest runs;
* afterwards, write evidence JSON: which asserts executed, which did not,
  and which belong to tests that were skipped or never selected (those are
  reported as skipped, not red -- only asserts in tests that actually ran
  and never hit their line fail the gate).

Use as a pytest plugin (``-p i6d_assertion_execution``) or through the CLI
below, which runs pytest for you and exits 0 on pass, 1 when unexecuted
assertions (or a failing pytest run) are found, 2 on misuse/errors.

Out of scope for slice 1 (later slices): scoping to added/changed asserts
only (needs git diff), asserts in non-test helper modules, non-pytest
runners, and wiring into ``xflow audit`` replay / the I6c gate.

Slice 2 adds that diff scoping as reusable pieces (importable, so slice 3
can reuse them when it wires the gate into ``xflow audit`` replay):

* ``resolve_diff_base(repo, base)`` -- the merge-base of HEAD and ``base``
  (default ``main``), i.e. the commit the current branch forked from;
* ``changed_lines(repo, base)`` -- ``{abspath: {new-side line numbers}}``
  from ``git diff <merge-base> HEAD -U0`` (committed changes only;
  uncommitted working-tree edits are *not* in scope);
* ``assert_in_scope(entry, changed)`` -- an assert is in scope when any
  of its lines [line, end_line] was added/changed.

The plugin honours ``EVALID_I6D_ONLY_CHANGED=1`` (+ ``EVALID_I6D_DIFF_BASE``)
and the CLI exposes the same as ``--only-changed`` / ``--diff-base``.
With scoping on, asserts outside the diff are reported as ``outOfScope``
(never red), an empty diff passes (exit 0), and only in-scope unexecuted
asserts fail the gate. Without the flag, slice 1 behaviour is unchanged.

Slice 3 wires the gate into ``xflow audit`` replay and the I6c gate:

* ``changed_lines_from_diff(diff_text, repo)`` -- the same changed-lines
  shape as ``changed_lines`` but parsed from a unified diff *text* (the
  audit's --diff / PR diff, which may be uncommitted or carry context
  lines), so the audit can scope the gate without committing anything;
* ``changed_lines(..., uncommitted=True)`` -- additionally unions
  ``git diff HEAD`` (working tree + staged), for the workflow atom, where
  the change under review is still uncommitted;
* atom mode (``--change-id`` / ``--project-root``, as invoked by the
  workflow executor): evidence lands in
  ``specs/changes/<id>/tdd/i6d-0.json`` and stdout is a single JSON line
  (``{ok, verdict, proof_file, ...}``), so the executor can parse it and
  the I6c review can fold the verdict into quality-0.json. With no
  changed Python test files the atom passes without running pytest.
"""

import argparse
import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EVIDENCE_ENV = "EVALID_I6D_EVIDENCE"
DIFF_ONLY_ENV = "EVALID_I6D_ONLY_CHANGED"
DIFF_BASE_ENV = "EVALID_I6D_DIFF_BASE"
DIFF_FILE_ENV = "EVALID_I6D_DIFF_FILE"
INCLUDE_UNCOMMITTED_ENV = "EVALID_I6D_INCLUDE_UNCOMMITTED"
VERSION = 3


def is_python_test_file(path):
    """True for files pytest collects as tests by default.

    Mirrors pytest's default ``python_files`` (``test_*.py`` /
    ``*_test.py``); kept in sync with ``isPythonTestFile`` in
    ``src/core/audit.js``.
    """
    name = os.path.basename(str(path))
    return name.endswith(".py") and (
        name.startswith("test_") or name.endswith("_test.py")
    )


# ---------------------------------------------------------------------------
# Static collection
# ---------------------------------------------------------------------------

def _source_lines(path):
    return Path(path).read_text(encoding="utf-8").splitlines()


def collect_assertions(path):
    """Return every ``assert`` statement in one test file.

    Each entry: ``{file, line, end_line, source, test}`` where ``test`` is
    the outermost enclosing function whose name starts with ``test`` (the
    test that owns the assert, even when the assert sits inside a nested
    callback), or the outermost enclosing function, or None for module level.
    """
    abspath = os.path.realpath(path)
    lines = _source_lines(abspath)
    tree = ast.parse("\n".join(lines), filename=abspath)
    found = []

    def enclosing_test(stack):
        for node in stack:
            if node.name.startswith("test"):
                return node.name
        return stack[0].name if stack else None

    def visit(node, stack):
        if isinstance(node, ast.Assert):
            segment = ast.get_source_segment("\n".join(lines), node)
            source = (segment or lines[node.lineno - 1]).strip()
            found.append({
                "file": abspath,
                "line": node.lineno,
                "end_line": node.end_lineno,
                "source": source,
                "test": enclosing_test(stack),
            })
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            stack = [*stack, node]
        for child in ast.iter_child_nodes(node):
            visit(child, stack)

    visit(tree, [])
    return found


# ---------------------------------------------------------------------------
# Diff scoping (slice 2) -- reusable pieces for slice 3
# ---------------------------------------------------------------------------

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


def resolve_diff_base(repo, base="main"):
    """Merge-base SHA of HEAD and ``base`` (the branch point of this work)."""
    return _git(repo, "merge-base", "HEAD", base).strip()


_HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@")


def _parse_unified_diff(diff_text, repo):
    """``{abspath: {new-side line numbers}}`` from a unified diff text.

    Only lines actually added (``+`` lines inside a hunk) count -- context
    lines and hunk-header ranges do not, so a -U3 diff (``gh pr diff``,
    the audit's --diff input) scopes exactly like a -U0 one. Deleted
    lines do not advance the new-side number; ``\\ No newline`` lines
    neither. Deleted files and files with no added lines contribute
    nothing.
    """
    changed = {}
    current = None
    new_lineno = None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target in ("/dev/null", ""):
                current = None
                new_lineno = None
                continue
            if target.startswith("b/"):
                target = target[2:]
            if len(target) >= 2 and target.startswith('"') and target.endswith('"'):
                target = json.loads(target)
            current = os.path.realpath(os.path.join(repo, target))
            changed.setdefault(current, set())
            new_lineno = None
        elif line.startswith("@@ ") and current is not None:
            match = _HUNK_RE.match(line)
            new_lineno = int(match.group(1)) if match else None
        elif current is None or new_lineno is None:
            continue
        elif line.startswith("+") and not line.startswith("+++"):
            changed[current].add(new_lineno)
            new_lineno += 1
        elif line.startswith("-") and not line.startswith("---"):
            pass  # deleted line: the new-side number does not advance
        elif line.startswith("\\"):
            pass  # "\ No newline at end of file": no advance
        else:
            new_lineno += 1  # context line
    return {path: lines for path, lines in changed.items() if lines}


def changed_lines_from_diff(diff_text, repo):
    """Changed lines from a unified diff *text* (slice 3, for the audit).

    Unlike :func:`changed_lines` this needs no git state: the audit
    replays an uncommitted diff (or a PR diff) in a scratch clone, where
    the change is not a commit yet. Same return shape as
    :func:`changed_lines` minus the merge-base.
    """
    return _parse_unified_diff(diff_text, repo)


def changed_lines(repo, base="main", uncommitted=False):
    """Return ``(merge_base_sha, {abspath: {new-side line numbers}})``.

    The diff is ``git diff <merge-base> HEAD -U0``: committed changes on
    this branch only. With ``uncommitted=True`` the working tree + staged
    changes vs HEAD (``git diff HEAD -U0``) are unioned in, for the
    workflow atom, where the change under review is still uncommitted.
    A file's changed lines are its added lines. Deleted files contribute
    nothing; without ``uncommitted``, uncommitted working-tree edits are
    not included.
    """
    merge_base = resolve_diff_base(repo, base)
    raw = _git(repo, "diff", merge_base, "HEAD", "-U0", "--")
    changed = _parse_unified_diff(raw, repo)
    if uncommitted:
        raw_wt = _git(repo, "diff", "HEAD", "-U0", "--")
        for path, lines in _parse_unified_diff(raw_wt, repo).items():
            changed.setdefault(path, set()).update(lines)
    return merge_base, changed


def assert_in_scope(entry, changed):
    """True when any line of the assert (line..end_line) changed in the diff."""
    lines = changed.get(os.path.realpath(entry["file"]))
    if not lines:
        return False
    return any(
        lineno in lines
        for lineno in range(entry["line"], (entry.get("end_line") or entry["line"]) + 1)
    )


def load_diff_scope(repo, base="main", uncommitted=False):
    """``{'base': <merge-base sha>, 'changed': {path: [lines]}}`` (JSON-safe)."""
    merge_base, changed = changed_lines(repo, base, uncommitted=uncommitted)
    return {
        "base": merge_base,
        "changed": {path: sorted(lines) for path, lines in changed.items()},
    }


# ---------------------------------------------------------------------------
# Pytest plugin
# ---------------------------------------------------------------------------

class _AssertionExecutionPlugin:
    def __init__(self, rootdir):
        self.rootdir = os.path.realpath(rootdir)
        self.executed = set()          # {(realpath, lineno)}
        self.asserts = []              # collect_assertions() entries
        self.outcomes = {}             # nodeid -> 'passed' | 'failed' | 'skipped'
        self._old_trace = None
        self.diff_changed = None       # None = no scoping; else {path: set(lines)}
        self.diff_base = None
        self.diff_error = None

    # -- tracing ---------------------------------------------------------
    def _global_trace(self, frame, event, arg):
        if event != "call":
            return None
        filename = frame.f_code.co_filename
        if not filename.endswith(".py"):
            return None
        if os.path.realpath(filename).startswith(self.rootdir + os.sep):
            return self._local_trace
        return None

    def _local_trace(self, frame, event, arg):
        if event == "line":
            self.executed.add(
                (os.path.realpath(frame.f_code.co_filename), frame.f_lineno)
            )
        return self._local_trace

    # -- hooks -----------------------------------------------------------
    def pytest_sessionstart(self, session):
        self._old_trace = sys.gettrace()
        sys.settrace(self._global_trace)
        if os.environ.get(DIFF_FILE_ENV):
            # Slice 3 (audit): scope from a diff text, not from git state --
            # the audited change may be uncommitted in a scratch clone.
            try:
                text = Path(os.environ[DIFF_FILE_ENV]).read_text(encoding="utf-8")
                self.diff_changed = changed_lines_from_diff(text, self.rootdir)
                self.diff_base = None
            except Exception as exc:  # noqa: BLE001 - surface as evidence, not a crash
                self.diff_error = str(exc)
        elif os.environ.get(DIFF_ONLY_ENV):
            try:
                base = os.environ.get(DIFF_BASE_ENV) or "main"
                self.diff_base, self.diff_changed = changed_lines(
                    self.rootdir, base,
                    uncommitted=bool(os.environ.get(INCLUDE_UNCOMMITTED_ENV)),
                )
            except Exception as exc:  # noqa: BLE001 - surface as evidence, not a crash
                self.diff_error = str(exc)

    def pytest_collection_modifyitems(self, session, config, items):
        seen_files = set()
        for item in items:
            path = str(item.path)
            if path not in seen_files:
                seen_files.add(path)
                self.asserts.extend(collect_assertions(path))

    def pytest_runtest_logreport(self, report):
        if report.skipped:
            self.outcomes[report.nodeid] = "skipped"
        elif report.when == "call":
            self.outcomes[report.nodeid] = report.outcome

    def pytest_sessionfinish(self, session, exitstatus):
        sys.settrace(self._old_trace)
        evidence = build_evidence(
            rootdir=self.rootdir,
            asserts=self.asserts,
            executed=self.executed,
            outcomes=self.outcomes,
            pytest_exit=exitstatus,
            changed=self.diff_changed,
            diff_base=self.diff_base,
            diff_error=self.diff_error,
        )
        write_evidence(evidence)


_PLUGIN = None


def pytest_sessionstart(session):
    global _PLUGIN
    _PLUGIN = _AssertionExecutionPlugin(session.config.rootdir)
    _PLUGIN.pytest_sessionstart(session)


def pytest_collection_modifyitems(session, config, items):
    _PLUGIN.pytest_collection_modifyitems(session, config, items)


def pytest_runtest_logreport(report):
    _PLUGIN.pytest_runtest_logreport(report)


def pytest_sessionfinish(session, exitstatus):
    _PLUGIN.pytest_sessionfinish(session, exitstatus)


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------

def _test_function_name(nodeid):
    """Last :: component of a nodeid, without parametrisation."""
    last = nodeid.rsplit("::", 1)[-1]
    return last.split("[", 1)[0]


def _test_ran(nodeid_file, test_name, outcomes):
    """True when at least one collected item for this test actually ran."""
    if test_name is None:
        # Module-level asserts execute at import, i.e. during collection.
        return True
    for nodeid, outcome in outcomes.items():
        if outcome not in ("passed", "failed"):
            continue
        if _test_function_name(nodeid) != test_name:
            continue
        item_file = nodeid.split("::", 1)[0]
        if os.path.realpath(item_file) == os.path.realpath(nodeid_file):
            return True
    return False


def build_evidence(*, rootdir, asserts, executed, outcomes, pytest_exit,
                   changed=None, diff_base=None, diff_error=None):
    """Classify collected asserts.

    Without ``changed`` (slice 1): executed / unexecuted-in-ran-tests /
    skipped. With ``changed`` (slice 2 diff scoping): asserts outside the
    diff go to ``outOfScope`` first and are never red; only in-scope
    unexecuted asserts fail the gate, so an empty diff passes.
    """
    executed_list = []
    unexecuted = []
    skipped = []
    out_of_scope = []
    for entry in asserts:
        if changed is not None and not assert_in_scope(entry, changed):
            out_of_scope.append(entry)
            continue
        key = (entry["file"], entry["line"])
        if key in executed:
            executed_list.append(entry)
        elif _test_ran(entry["file"], entry["test"], outcomes):
            unexecuted.append(entry)
        else:
            skipped.append(entry)
    if diff_error is not None:
        verdict = "diff_error"
    elif unexecuted:
        verdict = "unexecuted_assertions"
    elif pytest_exit != 0:
        verdict = "pytest_failed"
    else:
        verdict = "pass"
    evidence = {
        "tool": "i6d_assertion_execution",
        "version": VERSION,
        "root": os.path.realpath(rootdir),
        "pytestExit": pytest_exit,
        "verdict": verdict,
        "total": len(asserts),
        "executed": len(executed_list),
        "unexecuted": unexecuted,
        "skipped": skipped,
    }
    if changed is not None or diff_base is not None or diff_error is not None:
        evidence["diffBase"] = diff_base
        evidence["inScope"] = len(executed_list) + len(unexecuted) + len(skipped)
        evidence["outOfScope"] = out_of_scope
    if diff_error is not None:
        evidence["diffError"] = diff_error
    return evidence


def evidence_path():
    override = os.environ.get(EVIDENCE_ENV)
    if override:
        return override
    return os.path.join(os.getcwd(), ".evalid-i6d-evidence.json")


def write_evidence(evidence):
    path = evidence_path()
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2)
    return path


# ---------------------------------------------------------------------------
# CLI: run pytest under the plugin, then judge the evidence
# ---------------------------------------------------------------------------

def _pytest_available(pytest_python):
    """True when ``pytest_python`` can import pytest."""
    try:
        proc = subprocess.run(
            [pytest_python, "-c", "import pytest"],
            capture_output=True, text=True, timeout=60,
        )
    except OSError:
        return False
    return proc.returncode == 0


def _atom_summary(*, ok, verdict, proof_file, evidence, pytest_exit):
    return {
        "ok": ok,
        "verdict": verdict,
        "proof_file": str(proof_file),
        "executed": evidence.get("executed", 0),
        "total": evidence.get("total", 0),
        "unexecuted": len(evidence.get("unexecuted", [])),
        "skipped": len(evidence.get("skipped", [])),
        "pytest_exit": pytest_exit,
    }


def run_gate(*, root, output, pytest_python, pytest_args,
             only_changed=False, diff_base="main", diff_file=None,
             include_uncommitted=False, change_id=None, project_root=None):
    """Run pytest under the plugin, then judge the evidence.

    Slice 3 additions: ``diff_file`` scopes from a diff text instead of a
    git range (the audit's case); ``include_uncommitted`` unions the
    working tree into the git-range scope; ``change_id`` switches on atom
    mode (evidence to ``specs/changes/<id>/tdd/i6d-0.json``, stdout a
    single JSON line for the workflow executor). Atom mode always counts
    uncommitted changes -- the change under review is still uncommitted
    when the workflow runs -- and passes without running pytest when the
    diff touches no Python test files.
    """
    atom_mode = change_id is not None
    if atom_mode:
        root = project_root or root
        include_uncommitted = True
    root = os.path.realpath(root)
    output = os.path.abspath(output)
    parent = os.path.dirname(output)
    if parent:
        os.makedirs(parent, exist_ok=True)

    # Resolve the diff scope before running pytest: the audit and the
    # atom both need the changed Python test files as pytest targets, and
    # the atom short-circuits when there are none.
    changed = None
    diff_base_out = None
    diff_source = None
    diff_error = None
    if only_changed:
        try:
            if diff_file is not None:
                with open(diff_file, encoding="utf-8") as handle:
                    changed = changed_lines_from_diff(handle.read(), root)
                diff_source = "diff-file"
            else:
                diff_base_out, changed = changed_lines(
                    root, diff_base, uncommitted=include_uncommitted,
                )
                diff_source = (
                    "git-range+uncommitted" if include_uncommitted
                    else "git-range"
                )
        except Exception as exc:  # noqa: BLE001 - surface as evidence, not a crash
            diff_error = str(exc)

    targets = []
    if only_changed and changed is not None and not pytest_args:
        targets = sorted(
            os.path.relpath(path, root)
            for path, lines in changed.items()
            if is_python_test_file(path) and lines
            and os.path.exists(path)
        )
        pytest_args = targets

    if atom_mode and only_changed and not pytest_args and diff_error is None:
        # No changed Python test files: nothing for the gate to judge.
        # Slice 2's empty-diff contract is "pass", so the atom passes
        # without running pytest at all.
        evidence = {
            "tool": "i6d_assertion_execution",
            "version": VERSION,
            "root": root,
            "pytestExit": None,
            "verdict": "pass",
            "total": 0,
            "executed": 0,
            "unexecuted": [],
            "skipped": [],
            "diffBase": diff_base_out,
            "diffSource": diff_source,
            "inScope": 0,
            "outOfScope": [],
            "notApplicable": "no_python_test_changes",
        }
        with open(output, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
        print(json.dumps(_atom_summary(
            ok=True, verdict="pass", proof_file=output,
            evidence=evidence, pytest_exit=None,
        )))
        return 0

    if diff_error is not None:
        evidence = {
            "tool": "i6d_assertion_execution",
            "version": VERSION,
            "root": root,
            "pytestExit": None,
            "verdict": "diff_error",
            "total": 0,
            "executed": 0,
            "unexecuted": [],
            "skipped": [],
            "diffBase": diff_base_out,
            "diffSource": diff_source,
            "diffError": diff_error,
        }
        with open(output, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
        if atom_mode:
            print(json.dumps(_atom_summary(
                ok=False, verdict="diff_error", proof_file=output,
                evidence=evidence, pytest_exit=None,
            )))
        else:
            print(f"i6d: diff_error: {diff_error}", file=sys.stderr)
        return 2

    atoms_dir = str(Path(__file__).resolve().parent)
    env = dict(os.environ)
    env[EVIDENCE_ENV] = output
    if only_changed:
        env[DIFF_ONLY_ENV] = "1"
        env[DIFF_BASE_ENV] = diff_base
        if diff_file is not None:
            env[DIFF_FILE_ENV] = os.path.abspath(diff_file)
        if include_uncommitted:
            env[INCLUDE_UNCOMMITTED_ENV] = "1"
    env["PYTHONPATH"] = atoms_dir + os.pathsep + env.get("PYTHONPATH", "")

    if not _pytest_available(pytest_python):
        # The gate cannot judge anything without pytest. When the diff
        # touches Python test files this is a real gap (exit 2), not a
        # silent pass; statically count the asserts at stake for the
        # evidence so the failure names what could not be judged.
        total = 0
        for target in (pytest_args or []):
            candidate = target if os.path.isabs(target) else os.path.join(root, target)
            if is_python_test_file(candidate) and os.path.exists(candidate):
                try:
                    total += len(collect_assertions(candidate))
                except Exception:  # noqa: BLE001 - best effort only
                    pass
        evidence = {
            "tool": "i6d_assertion_execution",
            "version": VERSION,
            "root": root,
            "pytestExit": None,
            "verdict": "pytest_unavailable",
            "total": total,
            "executed": 0,
            "unexecuted": [],
            "skipped": [],
            "diffBase": diff_base_out,
            "diffSource": diff_source,
            "inScope": total if only_changed else None,
            "outOfScope": [],
        }
        with open(output, "w", encoding="utf-8") as handle:
            json.dump(evidence, handle, indent=2)
        if atom_mode:
            print(json.dumps(_atom_summary(
                ok=False, verdict="pytest_unavailable", proof_file=output,
                evidence=evidence, pytest_exit=None,
            )))
        else:
            print("i6d: pytest_unavailable: "
                  f"{pytest_python} cannot import pytest", file=sys.stderr)
        return 2

    command = [pytest_python, "-m", "pytest", "-p", "i6d_assertion_execution", *pytest_args]
    try:
        # Atom mode: the workflow executor parses stdout as one JSON line,
        # so pytest's own session output must not leak onto stdout. Capture
        # it; the evidence JSON carries the verdict, and the tail is only
        # surfaced when no evidence was written.
        if atom_mode:
            proc = subprocess.run(command, cwd=root, env=env,
                                  capture_output=True, text=True)
        else:
            proc = subprocess.run(command, cwd=root, env=env)
    except OSError as exc:
        print(f"i6d: could not run pytest: {exc}", file=sys.stderr)
        return 2
    try:
        with open(output, encoding="utf-8") as handle:
            evidence = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        detail = f"pytest exit {proc.returncode}"
        if atom_mode and getattr(proc, "stdout", None):
            detail += f"; pytest output tail: {(proc.stdout or '')[-500:]}"
        print(f"i6d: no evidence written ({exc}); {detail}", file=sys.stderr)
        return 2
    evidence["pytestExit"] = proc.returncode
    if diff_source is not None:
        evidence["diffSource"] = diff_source
    if evidence["verdict"] == "unexecuted_assertions" and proc.returncode == 0:
        pass  # verdict already reflects the gate; pytest itself passed.
    elif proc.returncode != 0 and not evidence["unexecuted"]:
        evidence["verdict"] = "pytest_failed"
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2)
    if atom_mode:
        ok = evidence["verdict"] == "pass"
        print(json.dumps(_atom_summary(
            ok=ok, verdict=evidence["verdict"], proof_file=output,
            evidence=evidence, pytest_exit=proc.returncode,
        )))
        return 0 if ok else 1
    summary = (
        f"i6d: {evidence['verdict']} "
        f"({evidence['executed']}/{evidence['total']} assertions executed, "
        f"{len(evidence['unexecuted'])} unexecuted, "
        f"{len(evidence['skipped'])} skipped; pytest exit {proc.returncode})"
    )
    if "outOfScope" in evidence:
        summary += f" [{len(evidence['outOfScope'])} out of diff scope, base {evidence.get('diffBase')}]"
    print(summary)
    for entry in evidence["unexecuted"]:
        print(f"  unexecuted: {entry['file']}:{entry['line']}: {entry['source']}")
    if evidence["verdict"] == "diff_error":
        print(f"  diff error: {evidence.get('diffError')}", file=sys.stderr)
        return 2
    return 0 if evidence["verdict"] == "pass" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="I6d assertion-execution gate: prove every assert in "
        "the pytest run really executed (slice 2 adds --only-changed to "
        "judge only asserts added/changed vs a diff base, default main; "
        "slice 3 adds --diff-file to scope from a diff text, and "
        "--change-id atom mode for the workflow executor)."
    )
    parser.add_argument("--root", default=os.getcwd(), help="project root to run pytest in")
    parser.add_argument("--project-root", default=None,
                        help="alias for --root (workflow executor passes this)")
    parser.add_argument("--output", default=None,
                        help="where to write the evidence JSON "
                        "(default: specs/changes/<id>/tdd/i6d-0.json in atom mode, "
                        ".evalid-i6d-evidence.json otherwise)")
    parser.add_argument("--pytest-python", default=sys.executable,
                        help="python binary to run pytest with")
    parser.add_argument("--only-changed", action="store_true",
                        help="only judge asserts in the diff vs --diff-base")
    parser.add_argument("--diff-base", default="main",
                        help="diff base ref (merge-base of HEAD and this ref; default main)")
    parser.add_argument("--diff-file", default=None,
                        help="scope from a unified diff file instead of a git range")
    parser.add_argument("--include-uncommitted", action="store_true",
                        help="union working-tree + staged changes vs HEAD into the scope")
    parser.add_argument("--change-id", default=None,
                        help="atom mode: write evidence to specs/changes/<id>/tdd/i6d-0.json "
                        "and print a single JSON summary line")
    parser.add_argument("pytest_args", nargs="*", help="arguments passed to pytest (after --)")
    args = parser.parse_args(argv)
    root = args.project_root or args.root
    if args.output:
        output = args.output
    elif args.change_id:
        output = os.path.join(
            root, "specs", "changes", args.change_id, "tdd", "i6d-0.json")
    else:
        output = ".evalid-i6d-evidence.json"
    # argparse keeps a literal "--" out of pytest_args already.
    return run_gate(
        root=root,
        output=output,
        pytest_python=args.pytest_python,
        pytest_args=args.pytest_args,
        only_changed=args.only_changed,
        diff_base=args.diff_base,
        diff_file=args.diff_file,
        include_uncommitted=args.include_uncommitted,
        change_id=args.change_id,
        project_root=args.project_root,
    )


if __name__ == "__main__":
    raise SystemExit(main())
