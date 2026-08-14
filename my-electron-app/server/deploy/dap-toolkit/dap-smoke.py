#!/usr/bin/env python3
import argparse
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time


PROGRAMS = {
    "python": ("main.py", "value = 41\nvalue += 1\nprint(value)\n", 2, "value"),
    "go": ("main.go", 'package main\n\nimport "fmt"\n\nfunc main() {\n\tvalue := 41\n\tvalue++\n\tfmt.Println(value)\n}\n', 7, "value"),
}


class DAPClient:
    def __init__(self, process):
        self.process = process
        self.messages = queue.Queue()
        self.pending = []
        self.reverse_requests = []
        self.sequence = 0
        self.reader = threading.Thread(target=self._read_loop, daemon=True)
        self.reader.start()

    def _read_loop(self):
        try:
            while True:
                headers = {}
                while True:
                    line = self.process.stdout.readline()
                    if not line:
                        raise EOFError("adapter stdout closed")
                    if line in (b"\r\n", b"\n"):
                        break
                    name, value = line.decode("ascii").split(":", 1)
                    headers[name.lower()] = value.strip()
                length = int(headers["content-length"])
                payload = self.process.stdout.read(length)
                self.messages.put(json.loads(payload.decode("utf-8")))
        except Exception as error:
            self.messages.put({"type": "bridge-error", "message": str(error)})

    def send(self, message):
        self.sequence += 1
        message = dict(message)
        message["seq"] = self.sequence
        encoded = json.dumps(message, separators=(",", ":")).encode("utf-8")
        self.process.stdin.write(f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii") + encoded)
        self.process.stdin.flush()
        return self.sequence

    def request(self, command, arguments=None):
        seq = self.send({"type": "request", "command": command, "arguments": arguments or {}})
        return seq

    def wait(self, predicate, timeout=30):
        deadline = time.monotonic() + timeout
        for index, message in enumerate(self.pending):
            if predicate(message):
                return self.pending.pop(index)
        while time.monotonic() < deadline:
            try:
                message = self.messages.get(timeout=min(0.5, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if message.get("type") == "bridge-error":
                raise RuntimeError(message.get("message"))
            if message.get("type") == "request":
                self.reverse_requests.append(message)
                self.send({
                    "type": "response", "request_seq": message["seq"],
                    "success": False, "command": message.get("command", ""),
                    "message": "smoke client does not provide a terminal",
                })
                continue
            if predicate(message):
                return message
            self.pending.append(message)
        raise TimeoutError("timed out waiting for DAP message")

    def response(self, request_seq, timeout=30):
        response = self.wait(
            lambda message: message.get("type") == "response" and message.get("request_seq") == request_seq,
            timeout,
        )
        if not response.get("success"):
            raise RuntimeError(f"DAP request failed: {response}")
        return response

    def event(self, name, timeout=30):
        return self.wait(lambda message: message.get("type") == "event" and message.get("event") == name, timeout)

    def pending_output(self):
        return "".join(
            str(message.get("body", {}).get("output", ""))
            for message in self.pending
            if message.get("type") == "event" and message.get("event") == "output"
        )


def adapter_command(language, image, workspace):
    command = ["docker", "run", "--rm", "-i", "--network", "none", "-v", f"{workspace}:/workspace:rw", "-w", "/workspace"]
    if language == "go":
        command += ["--cap-add", "SYS_PTRACE", "--security-opt", "seccomp=unconfined"]
    command.append(image)
    if language == "python":
        command += ["python", "-m", "debugpy.adapter"]
    elif language == "go":
        command += ["/usr/local/bin/dap-stdio-bridge", "--listen", "127.0.0.1:4711", "--", "/usr/local/bin/dlv", "dap", "--listen=127.0.0.1:4711"]
    else:
        raise ValueError(f"unsupported release smoke language: {language}")
    return command


def launch_arguments(language, program):
    if language == "python":
        return {"request": "launch", "type": "python", "program": program, "cwd": "/workspace", "console": "internalConsole", "justMyCode": True}
    if language == "go":
        return {"request": "launch", "type": "go", "mode": "debug", "program": "/workspace", "cwd": "/workspace", "outputMode": "remote"}
    raise ValueError(f"unsupported release smoke language: {language}")


def prepare_workspace(language, workspace):
    filename, content, breakpoint_line, variable_name = PROGRAMS[language]
    source = os.path.join(workspace, filename)
    with open(source, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
    if language == "go":
        with open(os.path.join(workspace, "go.mod"), "w", encoding="utf-8", newline="\n") as handle:
            handle.write("module bobocloud.dev/dap-smoke\n\ngo 1.21\n")
    return filename, breakpoint_line, variable_name


def wait_for_launch(client, request_seq, timeout=30):
    deadline = time.monotonic() + timeout
    launch_response = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for DAP launch initialization")
        launch_state = client.wait(lambda message: (
            message.get("type") == "event" and message.get("event") == "initialized"
        ) or (
            message.get("type") == "response" and message.get("request_seq") == request_seq
        ), remaining)
        if launch_state.get("type") == "event":
            return launch_response
        if not launch_state.get("success"):
            adapter_output = client.pending_output().strip()
            suffix = f"\nadapter output:\n{adapter_output}" if adapter_output else ""
            raise RuntimeError(f"DAP launch failed: {launch_state}{suffix}")
        launch_response = launch_state


def run_smoke(language, image):
    with tempfile.TemporaryDirectory(prefix="bobocloud-dap-smoke-") as workspace:
        filename, breakpoint_line, variable_name = prepare_workspace(language, workspace)
        process = subprocess.Popen(
            adapter_command(language, image, workspace), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, bufsize=0,
        )
        stderr_lines = []
        threading.Thread(target=lambda: [stderr_lines.append(line.decode("utf-8", "replace")) for line in process.stderr], daemon=True).start()
        client = DAPClient(process)
        try:
            init = client.request("initialize", {
                "clientID": "bobocloud-smoke", "adapterID": language,
                "pathFormat": "path", "linesStartAt1": True, "columnsStartAt1": True,
                "supportsRunInTerminalRequest": False, "supportsVariableType": True,
            })
            client.response(init)
            launch = client.request("launch", launch_arguments(language, f"/workspace/{filename}"))
            launch_response = wait_for_launch(client, launch)
            set_breakpoints = client.request("setBreakpoints", {
                "source": {"name": filename, "path": f"/workspace/{filename}"},
                "breakpoints": [{"line": breakpoint_line}], "sourceModified": False,
            })
            breakpoint_response = client.response(set_breakpoints)
            breakpoints = breakpoint_response.get("body", {}).get("breakpoints", [])
            if not breakpoints:
                raise RuntimeError(f"adapter returned no breakpoint: {breakpoint_response}")
            configuration = client.request("configurationDone")
            client.response(configuration)
            if launch_response is None:
                client.response(launch)
            stopped = client.event("stopped")
            if stopped.get("body", {}).get("reason") != "breakpoint":
                raise RuntimeError(f"adapter did not stop at the breakpoint: {stopped}")
            thread_id = stopped.get("body", {}).get("threadId")
            threads = client.request("threads")
            thread_response = client.response(threads)
            if not thread_id:
                listed = thread_response.get("body", {}).get("threads", [])
                thread_id = listed[0]["id"] if listed else None
            if not thread_id:
                raise RuntimeError("adapter returned no stopped thread")
            stack = client.request("stackTrace", {"threadId": thread_id, "startFrame": 0, "levels": 20})
            frames = client.response(stack).get("body", {}).get("stackFrames", [])
            if not frames:
                raise RuntimeError("adapter returned no stack frames")
            if frames[0].get("line") != breakpoint_line:
                raise RuntimeError(f"adapter stopped on line {frames[0].get('line')}, expected {breakpoint_line}")
            scopes = client.request("scopes", {"frameId": frames[0]["id"]})
            scope_list = client.response(scopes).get("body", {}).get("scopes", [])
            variables_by_name = {}
            for scope in scope_list:
                reference = scope.get("variablesReference", 0)
                if reference:
                    variables = client.request("variables", {"variablesReference": reference})
                    for variable in client.response(variables).get("body", {}).get("variables", []):
                        if variable.get("name"):
                            variables_by_name[variable["name"]] = str(variable.get("value", ""))
            if variable_name not in variables_by_name:
                raise RuntimeError(f"expected variable {variable_name!r}, got {sorted(variables_by_name)}")
            if "41" not in variables_by_name[variable_name]:
                raise RuntimeError(f"unexpected initial value for {variable_name}: {variables_by_name[variable_name]!r}")
            step = client.request("next", {"threadId": thread_id})
            client.response(step)
            stepped = client.event("stopped")
            if stepped.get("body", {}).get("reason") not in ("step", "breakpoint"):
                raise RuntimeError(f"adapter did not stop after next: {stepped}")
            thread_id = stepped.get("body", {}).get("threadId") or thread_id
            continued = client.request("continue", {"threadId": thread_id})
            client.response(continued)
            output = client.event("output", timeout=30)
            if "42" not in output.get("body", {}).get("output", ""):
                # Adapters can emit several output events; search pending/new events.
                output = client.wait(lambda item: item.get("type") == "event" and item.get("event") == "output" and "42" in item.get("body", {}).get("output", ""), 10)
            client.event("terminated", timeout=30)
            disconnect = client.request("disconnect", {"terminateDebuggee": True})
            try:
                client.response(disconnect, timeout=5)
            except (EOFError, RuntimeError, TimeoutError):
                pass
        except Exception as error:
            pending = json.dumps(client.pending[-50:], ensure_ascii=False, indent=2)
            reverse_requests = json.dumps(client.reverse_requests[-20:], ensure_ascii=False, indent=2)
            raise RuntimeError(
                f"{language} DAP smoke failed: {error}\n"
                f"pending DAP messages:\n{pending}\n"
                f"adapter reverse requests:\n{reverse_requests}\n"
                f"adapter stderr:\n{''.join(stderr_lines[-50:])}"
            ) from error
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--language", choices=sorted(PROGRAMS), required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    run_smoke(args.language, args.image)
    print(f"verified {args.language} DAP image {args.image}")


if __name__ == "__main__":
    main()
