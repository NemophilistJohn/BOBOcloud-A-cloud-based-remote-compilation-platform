import importlib.util
import os
import queue
import shutil
import subprocess
import tempfile
import time
import unittest


MODULE_PATH = os.path.join(os.path.dirname(__file__), "dap-smoke.py")
SPEC = importlib.util.spec_from_file_location("bobocloud_dap_smoke", MODULE_PATH)
DAP_SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DAP_SMOKE)


def queued_client(*messages):
    client = object.__new__(DAP_SMOKE.DAPClient)
    client.messages = queue.Queue()
    client.pending = []
    for message in messages:
        client.messages.put(message)
    return client


class DAPSmokeTests(unittest.TestCase):
    def test_release_smoke_languages_exclude_node_until_child_sessions_exist(self):
        self.assertEqual(set(DAP_SMOKE.PROGRAMS), {"python", "go"})
        with self.assertRaisesRegex(ValueError, "unsupported release smoke language"):
            DAP_SMOKE.adapter_command("node", "unused", "unused")

    def test_go_workspace_is_a_buildable_module(self):
        go = shutil.which("go")
        if not go:
            self.skipTest("Go toolchain is not installed")
        environment = os.environ.copy()
        environment["GO111MODULE"] = "on"
        environment["GOWORK"] = "off"
        with tempfile.TemporaryDirectory(prefix="bobocloud-dap-smoke-test-") as workspace:
            with open(os.path.join(workspace, "main.go"), "w", encoding="utf-8", newline="\n") as handle:
                handle.write(DAP_SMOKE.PROGRAMS["go"][1])
            missing_module = subprocess.run(
                [go, "build", "."], cwd=workspace, env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30,
            )
            self.assertNotEqual(missing_module.returncode, 0)
            self.assertIn("go.mod file not found", missing_module.stderr)

            filename, breakpoint_line, variable_name = DAP_SMOKE.prepare_workspace("go", workspace)
            self.assertEqual((filename, breakpoint_line, variable_name), ("main.go", 7, "value"))
            with open(os.path.join(workspace, "go.mod"), encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "module bobocloud.dev/dap-smoke\n\ngo 1.21\n")
            build = subprocess.run(
                [go, "build", "."], cwd=workspace, env=environment,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30,
            )
            self.assertEqual(build.returncode, 0, build.stderr)

    def test_failed_launch_surfaces_adapter_build_output_immediately(self):
        client = queued_client(
            {"seq": 3, "type": "event", "event": "output", "body": {"category": "stderr", "output": "go: go.mod file not found\n"}},
            {"seq": 4, "type": "response", "request_seq": 2, "command": "launch", "success": False, "message": "Failed to launch"},
        )
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "go.mod file not found"):
            DAP_SMOKE.wait_for_launch(client, 2, timeout=5)
        self.assertLess(time.monotonic() - started, 1)

    def test_successful_launch_response_is_retained_until_initialized(self):
        response = {"seq": 3, "type": "response", "request_seq": 2, "command": "launch", "success": True}
        client = queued_client(response, {"seq": 4, "type": "event", "event": "initialized"})
        self.assertIs(DAP_SMOKE.wait_for_launch(client, 2, timeout=1), response)


if __name__ == "__main__":
    unittest.main()
