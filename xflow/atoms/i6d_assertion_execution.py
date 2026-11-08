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
"""

import argparse
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

EVIDENCE_ENV = "EVALID_I6D_EVIDENCE"
VERSION = 1


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
# Pytest plugin
# ---------------------------------------------------------------------------

class _AssertionExecutionPlugin:
    def __init__(self, rootdir):
        self.rootdir = os.path.realpath(rootdir)
        self.executed = set()          # {(realpath, lineno)}
        self.asserts = []              # collect_assertions() entries
        self.outcomes = {}             # nodeid -> 'passed' | 'failed' | 'skipped'
        self._old_trace = None

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


def build_evidence(*, rootdir, asserts, executed, outcomes, pytest_exit):
    executed_list = []
    unexecuted = []
    skipped = []
    for entry in asserts:
        key = (entry["file"], entry["line"])
        if key in executed:
            executed_list.append(entry)
        elif _test_ran(entry["file"], entry["test"], outcomes):
            unexecuted.append(entry)
        else:
            skipped.append(entry)
    if unexecuted:
        verdict = "unexecuted_assertions"
    elif pytest_exit != 0:
        verdict = "pytest_failed"
    else:
        verdict = "pass"
    return {
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

def run_gate(*, root, output, pytest_python, pytest_args):
    atoms_dir = str(Path(__file__).resolve().parent)
    env = dict(os.environ)
    env[EVIDENCE_ENV] = os.path.abspath(output)
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
    print(
        f"i6d: {evidence['verdict']} "
        f"({evidence['executed']}/{evidence['total']} assertions executed, "
        f"{len(evidence['unexecuted'])} unexecuted, "
        f"{len(evidence['skipped'])} skipped; pytest exit {proc.returncode})"
    )
    for entry in evidence["unexecuted"]:
        print(f"  unexecuted: {entry['file']}:{entry['line']}: {entry['source']}")
    return 0 if evidence["verdict"] == "pass" else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="I6d assertion-execution gate (slice 1): prove every "
        "assert in the pytest run really executed."
    )
    parser.add_argument("--root", default=os.getcwd(), help="project root to run pytest in")
    parser.add_argument("--output", default=".evalid-i6d-evidence.json",
                        help="where to write the evidence JSON")
    parser.add_argument("--pytest-python", default=sys.executable,
                        help="python binary to run pytest with")
    parser.add_argument("pytest_args", nargs="*", help="arguments passed to pytest (after --)")
    args = parser.parse_args(argv)
    # argparse keeps a literal "--" out of pytest_args already.
    return run_gate(
        root=args.root,
        output=args.output,
        pytest_python=args.pytest_python,
        pytest_args=args.pytest_args,
    )


if __name__ == "__main__":
    raise SystemExit(main())
