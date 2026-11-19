"""Cell protocol for one isolated Python process."""

import ast
import base64
import codeop
import contextlib
import io
import json
import os
import sys
import traceback

# Keep ordinary Python output and subprocess file descriptors off the wire.
requests = os.fdopen(os.dup(0), encoding="utf-8")
responses = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
with open(os.devnull, "r+b") as null:
    for descriptor in (0, 1, 2):
        os.dup2(null.fileno(), descriptor)

OUTPUT_CHARS = 24 * 1024
OUTPUT_IMAGE_BYTES = 2 * 1024 * 1024
namespace = {"__name__": "__main__"}
compiler = codeop.Compile()
count = 0


class Capture(io.TextIOBase):
    def __init__(self):
        self.parts = []
        self.remaining = OUTPUT_CHARS
        self.truncated = False

    def write(self, value):
        if len(value) > self.remaining:
            self.truncated = True
        if self.remaining and value:
            part = value[:self.remaining]
            self.parts.append(part)
            self.remaining -= len(part)
        return len(value)

    def text(self):
        return "".join(self.parts) + ("\n[…]" if self.truncated else "")


class BoundedBytesIO(io.BytesIO):
    def write(self, value):
        if self.tell() + len(value) > OUTPUT_IMAGE_BYTES:
            raise OSError("notebook image output exceeded its size limit")
        return super().write(value)


def run(code, number):
    filename = "<notebook-cell-%d>" % number
    stdout, stderr = Capture(), Capture()
    result = None
    error = None
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            tree = compile(code, filename, "exec", ast.PyCF_ONLY_AST | compiler.flags, dont_inherit=True)
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                expression = ast.Expression(tree.body.pop().value)
                exec(compiler(tree, filename, "exec"), namespace)
                value = eval(compiler(expression, filename, "eval"), namespace)
                if value is not None:
                    result = repr(value)[:OUTPUT_CHARS]
                    namespace["_"] = value
            else:
                exec(compiler(tree, filename, "exec"), namespace)
    except BaseException as exc:
        frames = traceback.TracebackException.from_exception(exc, limit=24)
        error = {
            "output_type": "error",
            "ename": type(exc).__name__[:256],
            "evalue": str(exc)[:4096],
            "traceback": ["".join(frames.format())[:OUTPUT_CHARS]],
        }
    outputs = []
    for name, capture in (("stdout", stdout), ("stderr", stderr)):
        if capture.parts:
            outputs.append({"output_type": "stream", "name": name, "text": capture.text()})
    if result is not None:
        outputs.append({"output_type": "execute_result", "data": {"text/plain": result},
                        "execution_count": number, "metadata": {}})
    if error is not None:
        outputs.append(error)
    if error is None:
        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is not None:
            for figure_number in list(pyplot.get_fignums())[:4]:
                image = BoundedBytesIO()
                try:
                    pyplot.figure(figure_number).savefig(image, format="png", dpi=100)
                    outputs.append({"output_type": "display_data",
                                    "data": {"image/png": base64.b64encode(image.getvalue()).decode("ascii")},
                                    "metadata": {}})
                except BaseException:
                    pass
                finally:
                    pyplot.close(figure_number)
    return {"executionCount": number, "outputs": outputs, "ok": error is None}


responses.write('{"ready":true}\n')
for line in requests:
    count += 1
    responses.write(json.dumps(run(json.loads(line)["code"], count), ensure_ascii=True) + "\n")
