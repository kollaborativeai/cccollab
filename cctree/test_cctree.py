#!/usr/bin/env python3
"""Unit tests for cctree.

cctree is an extension-less script, so it is loaded by path rather than imported by name.
Run from this directory:  python3 -m unittest test_cctree -v
"""
import os, json, unittest, importlib.util, importlib.machinery

_spec = importlib.util.spec_from_loader(
    "cctree",
    importlib.machinery.SourceFileLoader(
        "cctree", os.path.join(os.path.dirname(os.path.abspath(__file__)), "cctree")))
cctree = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cctree)


# --- fixtures -------------------------------------------------------------------------------------
# Real shapes, abbreviated. `claude agents --json --all` returns a FLAT LIST; background entries carry
# `state` (terminal: done/failed), interactive ones carry `status` (busy/idle) and a pid.
FAILED_BG = {"id": "3cef9daa", "cwd": "/x", "kind": "background", "sessionId": "3cef9daa-1dab-4332-a5c0-ebfc386e93b3",
             "name": "Claude Code Session Organization Researcher", "state": "failed"}
DONE_BG   = {"pid": 47382, "id": "ca64123a", "cwd": "/x", "kind": "background", "sessionId": "ca64123a-d10a-434f-aea9-249e36dedbb9",
             "name": "background monitoring smoketest", "status": "idle", "state": "done"}
BUSY_INT  = {"pid": 245, "cwd": "/x", "kind": "interactive", "sessionId": "0c6fc953-1111-2222-3333-444455556666",
             "name": "AI Orchestration Researcher", "status": "busy"}
IDLE_INT  = {"pid": 22441, "cwd": "/x", "kind": "interactive", "sessionId": "c8a47022-4ebc-4cd5-adb2-eab8ec0136b4",
             "name": "finance-architect", "status": "idle"}
AGENTS = {e["sessionId"][:8]: e for e in (FAILED_BG, DONE_BG, BUSY_INT, IDLE_INT)}


def row(sid, pid=None, **kw):
    """A c9watch row. c9watch's `id` is the FULL 36-char sessionId, not the 8-char prefix."""
    return dict({"id": sid, "pid": pid}, **kw)


class DeadAgentTest(unittest.TestCase):
    """is_dead_agent: reap c9watch rows for background agents `claude agents` reports as terminal.
    c9watch keeps emitting them long after they finish or fail, so their stale names linger in the tree."""

    def test_failed_background_agent_is_reaped(self):
        # the reported bug: a failed background agent still listed by c9watch (as "Connecting", pid 245).
        self.assertTrue(cctree.is_dead_agent(row(FAILED_BG["sessionId"], 245, status="Connecting"), AGENTS))

    def test_done_background_agent_is_reaped(self):
        # c9watch showed this finished throwaway agent as WaitingForInput; its process is even still
        # alive. State is the signal, not liveness.
        self.assertTrue(cctree.is_dead_agent(row(DONE_BG["sessionId"], 47382, status="WaitingForInput"), AGENTS))

    def test_session_absent_from_agents_map_is_kept(self):
        # CRITICAL REGRESSION GUARD. c9watch legitimately sees sessions `claude agents` does not (the
        # Claude Desktop app ones — ~27 rows vs ~21 agents). Absence is NOT evidence of death.
        self.assertFalse(cctree.is_dead_agent(row("deadbeef-0000-0000-0000-000000000000", 999), AGENTS))

    def test_interactive_agents_are_never_reaped(self):
        # interactive entries have no `state` key at all — busy and idle alike must survive.
        self.assertFalse(cctree.is_dead_agent(row(BUSY_INT["sessionId"], 245), AGENTS))
        self.assertFalse(cctree.is_dead_agent(row(IDLE_INT["sessionId"], 22441), AGENTS))

    def test_empty_agents_map_reaps_nothing(self):
        # graceful degradation: `claude agents` unavailable -> nothing is hidden, not even the known-dead.
        self.assertFalse(cctree.is_dead_agent(row(FAILED_BG["sessionId"], 245, status="Connecting"), {}))

    def test_row_without_id_is_kept(self):
        self.assertFalse(cctree.is_dead_agent({"pid": 245}, AGENTS))


class SessionPidTest(unittest.TestCase):
    """session_pid: `claude agents` is authoritative. c9watch mis-attributes pids — it welded a live
    unrelated claude's pid onto a dead agent's row, and pointed a live row at another session's MCP
    child. That pid drives jump/kill, so trusting it can kill the wrong process."""

    def test_agents_pid_overrides_c9watch_pid(self):
        # c9watch claims 88053 for this row; `claude agents` says the session is really pid 22441.
        self.assertEqual(cctree.session_pid(row(IDLE_INT["sessionId"], 88053), AGENTS), 22441)

    def test_falls_back_to_c9watch_pid_when_agents_has_none(self):
        # background entries usually carry no pid — keep whatever c9watch offered.
        self.assertEqual(cctree.session_pid(row(FAILED_BG["sessionId"], 245), AGENTS), 245)

    def test_empty_agents_map_falls_back_to_c9watch_pid(self):
        # graceful degradation: `claude agents` unavailable -> behave exactly as before this fix.
        self.assertEqual(cctree.session_pid(row(IDLE_INT["sessionId"], 88053), {}), 88053)

    def test_session_absent_from_agents_map_falls_back(self):
        self.assertEqual(cctree.session_pid(row("deadbeef-0000-0000-0000-000000000000", 777), AGENTS), 777)


class FullUuidCorrelationTest(unittest.TestCase):
    """The correlation key is the 8-char sessionId prefix, but c9watch emits the FULL 36-char sessionId.
    Both sides must be sliced. Dropping the [:8] on the c9watch side makes every lookup miss and turns
    the whole fix into a silent no-op (no reaping, no pid override) — guard that explicitly."""

    def test_agents_map_is_keyed_by_eight_char_prefix(self):
        self.assertEqual(sorted(AGENTS), ["0c6fc953", "3cef9daa", "c8a47022", "ca64123a"])

    def test_full_uuid_c9watch_id_still_correlates(self):
        r = row("ca64123a-d10a-434f-aea9-249e36dedbb9", 1)   # 36 chars, as c9watch really emits
        self.assertEqual(len(r["id"]), 36)
        self.assertTrue(cctree.is_dead_agent(r, AGENTS))
        self.assertEqual(cctree.session_pid(r, AGENTS), 47382)


class ClaudeAgentsTest(unittest.TestCase):
    """claude_agents(): parse the flat list into a prefix-keyed map; never raise, whatever the CLI does."""

    def stub_run(self, out):
        real = cctree.run
        cctree.run = lambda cmd, inp=None: out
        self.addCleanup(lambda: setattr(cctree, "run", real))

    def test_parses_flat_list_into_prefix_keyed_map(self):
        self.stub_run(json.dumps([FAILED_BG, BUSY_INT]))
        self.assertEqual(cctree.claude_agents(), {"3cef9daa": FAILED_BG, "0c6fc953": BUSY_INT})

    def test_missing_binary_or_empty_output_degrades_to_empty(self):
        self.stub_run("")                       # run() returns "" when the binary is missing / errors
        self.assertEqual(cctree.claude_agents(), {})

    def test_bad_json_degrades_to_empty(self):
        self.stub_run("not json at all")
        self.assertEqual(cctree.claude_agents(), {})

    def test_unexpected_shape_degrades_to_empty(self):
        self.stub_run(json.dumps({"sessions": []}))   # a dict instead of the expected list
        self.assertEqual(cctree.claude_agents(), {})

    def test_entries_without_session_id_are_skipped(self):
        self.stub_run(json.dumps([{"pid": 1, "kind": "interactive"}, BUSY_INT]))
        self.assertEqual(cctree.claude_agents(), {"0c6fc953": BUSY_INT})


if __name__ == "__main__":
    unittest.main()
