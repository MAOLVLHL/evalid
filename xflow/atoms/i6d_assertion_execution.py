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
VERSION = 2


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


def changed_lines(repo, base="main"):
    """Return ``(merge_base_sha, {abspath: {new-side line numbers}})``.

    The diff is ``git diff <merge-base> HEAD -U0``: committed changes on
    this branch only. A file's changed lines are the new-side lines of
    every hunk (for a brand-new file, every line). Deleted files contribute
    nothing; uncommitted working-tree edits are not included.
    """
    merge_base = resolve_diff_base(repo, base)
    raw = _git(repo, "diff", merge_base, "HEAD", "-U0", "--")
    changed = {}
    current = None
    for line in raw.splitlines():
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target in ("/dev/null", ""):
                current = None
                continue
            if target.startswith("b/"):
                target = target[2:]
            if len(target) >= 2 and target.startswith('"') and target.endswith('"'):
                target = json.loads(target)
            current = os.path.realpath(os.path.join(repo, target))
            changed.setdefault(current, set())
        elif line.startswith("@@ ") and current is not None:
            match = _HUNK_RE.match(line)
            if match is None:
                continue
            start = int(match.group(1))
            count = int(match.group(2)) if match.group(2) is not None else 1
            changed[current].update(range(start, start + count))
    return merge_base, {path: lines for path, lines in changed.items() if lines}


def assert_in_scope(entry, changed):
    """True when any line of the assert (line..end_line) changed in the diff."""
    lines = changed.get(os.path.realpath(entry["file"]))
    if not lines:
        return False
    return any(
        lineno in lines
        for lineno in range(entry["line"], (entry.get("end_line") or entry["line"]) + 1)
    )


def load_diff_scope(repo, base="main"):
    """``{'base': <merge-base sha>, 'changed': {path: [lines]}}`` (JSON-safe)."""
    merge_base, changed = changed_lines(repo, base)
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
        if os.environ.get(DIFF_ONLY_ENV):
            try:
                base = os.environ.get(DIFF_BASE_ENV) or "main"
                self.diff_base, self.diff_changed = changed_lines(
                    self.rootdir, base
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

def run_gate(*, root, output, pytest_python, pytest_args,
             only_changed=False, diff_base="main"):
    atoms_dir = str(Path(__file__).resolve().parent)
    env = dict(os.environ)
    env[EVIDENCE_ENV] = os.path.abspath(output)
    if only_changed:
        env[DIFF_ONLY_ENV] = "1"
        env[DIFF_BASE_ENV] = diff_base
    env["PYTHONPATH"] = atoms_dir + os.pathsep + env.get("PYTHONPATH", "")
    command = [pytest_python, "-m", "pytest", "-p", "i6d_assertion_execution", *pytest_args]
    try:
        proc = subprocess.run(command, cwd=root, env=env)
    except OSError as exc:
        print(f"i6d: could not run pytest: {exc}", file=sys.stderr)
        return 2
    try:
        with open(os.path.abspath(output), encoding="utf-8") as handle:
            evidence = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"i6d: no evidence written ({exc}); pytest exit {proc.returncode}", file=sys.stderr)
        return 2
    evidence["pytestExit"] = proc.returncode
    if evidence["verdict"] == "unexecuted_assertions" and proc.returncode == 0:
        pass  # verdict already reflects the gate; pytest itself passed.
    elif proc.returncode != 0 and not evidence["unexecuted"]:
        evidence["verdict"] = "pytest_failed"
    with open(os.path.abspath(output), "w", encoding="utf-8") as handle:
        json.dump(evidence, handle, indent=2)
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
        "judge only asserts added/changed vs a diff base, default main)."
    )
    parser.add_argument("--root", default=os.getcwd(), help="project root to run pytest in")
    parser.add_argument("--output", default=".evalid-i6d-evidence.json",
                        help="where to write the evidence JSON")
    parser.add_argument("--pytest-python", default=sys.executable,
                        help="python binary to run pytest with")
    parser.add_argument("--only-changed", action="store_true",
                        help="only judge asserts in the diff vs --diff-base")
    parser.add_argument("--diff-base", default="main",
                        help="diff base ref (merge-base of HEAD and this ref; default main)")
    parser.add_argument("pytest_args", nargs="*", help="arguments passed to pytest (after --)")
    args = parser.parse_args(argv)
    # argparse keeps a literal "--" out of pytest_args already.
    return run_gate(
        root=args.root,
        output=args.output,
        pytest_python=args.pytest_python,
        pytest_args=args.pytest_args,
        only_changed=args.only_changed,
        diff_base=args.diff_base,
    )


if __name__ == "__main__":
    raise SystemExit(main())
