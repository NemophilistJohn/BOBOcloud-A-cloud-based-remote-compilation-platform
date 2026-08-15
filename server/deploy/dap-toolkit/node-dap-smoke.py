#!/usr/bin/env python3
"""Release smoke for js-debug's parent/child TCP DAP topology.

The server broker uses the same protocol shape: a root connection receives
startDebugging, then a second connection launches with __pendingTargetId.
"""
import argparse
import json
import os
import queue
import socket
import subprocess
import tempfile
import threading
import time

TRACE = os.environ.get("BOBO_DAP_SMOKE_DEBUG") == "1"


class Client:
    def __init__(self, connection):
        self.connection = connection
        self.reader = connection.makefile("rb")
        self.writer = connection.makefile("wb")
        self.messages = queue.Queue()
        self.pending = []
        self.seq = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            while True:
                headers = {}
                while True:
                    line = self.reader.readline()
                    if not line:
                        raise EOFError("DAP socket closed")
                    if line in (b"\r\n", b"\n"):
                        break
                    name, value = line.decode("ascii").split(":", 1)
                    headers[name.lower()] = value.strip()
                payload = self.reader.read(int(headers["content-length"]))
                message = json.loads(payload.decode("utf-8"))
                if TRACE:
                    print(f"DAP <- {message}", flush=True)
                self.messages.put(message)
        except Exception as error:
            self.messages.put({"type": "bridge-error", "message": str(error)})

    def send(self, value):
        self.seq += 1
        message = dict(value, seq=self.seq)
        payload = json.dumps(message, separators=(",", ":")).encode("utf-8")
        self.writer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii") + payload)
        self.writer.flush()
        return self.seq

    def request(self, command, arguments=None):
        return self.send({"type": "request", "command": command, "arguments": arguments or {}})

    def respond(self, request, success=True, body=None, message=None):
        payload = {"type": "response", "request_seq": request["seq"], "command": request["command"], "success": success}
        if body is not None:
            payload["body"] = body
        if message:
            payload["message"] = message
        return self.send(payload)

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
                raise RuntimeError(message["message"])
            if predicate(message):
                return message
            self.pending.append(message)
        raise TimeoutError(f"timed out waiting for DAP message; pending={self.pending!r}")

    def response(self, request_seq, timeout=30):
        response = self.wait(lambda item: item.get("type") == "response" and item.get("request_seq") == request_seq, timeout)
        if not response.get("success"):
            raise RuntimeError(f"DAP request failed: {response}")
        return response

    def event(self, name, timeout=30):
        return self.wait(lambda item: item.get("type") == "event" and item.get("event") == name, timeout)

    def close(self):
        try:
            self.writer.close()
            self.reader.close()
            self.connection.close()
        except OSError:
            pass


def published_socket(socket_path):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if os.path.exists(socket_path):
            return socket_path
        time.sleep(0.1)
    raise RuntimeError("js-debug did not publish its private Unix socket")


def connect(socket_path):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.settimeout(1)
            connection.connect(socket_path)
            connection.settimeout(None)
            return Client(connection)
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("could not connect to js-debug")


def initialize(client):
    request = client.request("initialize", {
        "clientID": "bobocloud-node-smoke", "clientName": "BOBOCloud Node DAP smoke",
        "adapterID": "pwa-node", "pathFormat": "path", "linesStartAt1": True,
        "columnsStartAt1": True, "supportsVariableType": True, "supportsVariablePaging": True,
    })
    return client.response(request)


def run(image):
    with tempfile.TemporaryDirectory(prefix="bobocloud-node-dap-") as workspace, tempfile.TemporaryDirectory(prefix="bobocloud-node-dap-socket-") as socket_dir:
        source = os.path.join(workspace, "main.js")
        with open(source, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("const value = 41;\nconsole.log(value + 1);\n")
        network = subprocess.run(["docker", "network", "inspect", "bobocloud-dap-internal"], capture_output=True)
        if network.returncode:
            subprocess.run(["docker", "network", "create", "--internal", "bobocloud-dap-internal"], check=True)
        command = ["docker", "run", "--rm", "-d", "--network", "bobocloud-dap-internal", "-v", f"{socket_dir}:/bridge:rw", "-v", f"{workspace}:/workspace:rw", "-w", "/workspace", image]
        container = subprocess.check_output(command, text=True).strip()
        root = child = None
        try:
            socket_path = published_socket(os.path.join(socket_dir, "dap.sock"))
            root = connect(socket_path)
            initialize(root)
            launch = root.request("launch", {"type": "pwa-node", "request": "launch", "name": "smoke root", "program": "/workspace/main.js", "cwd": "/workspace", "console": "internalConsole", "stopOnEntry": True})
            root.event("initialized")
            provisional = root.request("setBreakpoints", {"source": {"path": "/workspace/main.js", "name": "main.js"}, "breakpoints": [{"line": 2}]})
            root.response(provisional)
            root_done = root.request("configurationDone", {})
            root.response(root_done)
            start = root.wait(lambda item: item.get("type") == "request" and item.get("command") == "startDebugging")
            configuration = start.get("arguments", {}).get("configuration", {})
            if not configuration.get("__pendingTargetId"):
                raise RuntimeError(f"js-debug did not provide a pending target id: {start}")
            child = connect(socket_path)
            initialize(child)
            child.send({"type": "request", "command": str(configuration.get("request", "launch")), "arguments": configuration})
            # js-debug may send initialized before or after launch response.
            child.event("initialized")
            child_done = child.request("configurationDone", {})
            child.response(child_done)
            root.respond(start, True, {})
            root.response(launch)
            entry = child.event("stopped")
            if entry.get("body", {}).get("reason") != "entry":
                raise RuntimeError(f"Node did not stop on entry: {entry}")
            thread_id = entry.get("body", {}).get("threadId")
            set_breakpoints = child.request("setBreakpoints", {"source": {"path": "/workspace/main.js", "name": "main.js"}, "breakpoints": [{"line": 2}]})
            result = child.response(set_breakpoints)
            if not result.get("body", {}).get("breakpoints", [{}])[0].get("verified"):
                raise RuntimeError(f"Node did not verify its breakpoint: {result}")
            continued = child.request("continue", {"threadId": thread_id})
            child.response(continued)
            stopped = child.event("stopped")
            if stopped.get("body", {}).get("reason") != "breakpoint":
                raise RuntimeError(f"Node did not stop at breakpoint: {stopped}")
            thread_id = stopped.get("body", {}).get("threadId")
            stack = child.request("stackTrace", {"threadId": thread_id, "startFrame": 0, "levels": 20})
            frames = child.response(stack).get("body", {}).get("stackFrames", [])
            if not frames or frames[0].get("line") != 2:
                raise RuntimeError(f"unexpected Node stack frames: {frames}")
            continued = child.request("continue", {"threadId": thread_id})
            child.response(continued)
            child.event("terminated")
            print(f"verified Node child-session DAP image {image}")
        finally:
            if child:
                child.close()
            if root:
                root.close()
            subprocess.run(["docker", "rm", "-f", container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    run(args.image)
