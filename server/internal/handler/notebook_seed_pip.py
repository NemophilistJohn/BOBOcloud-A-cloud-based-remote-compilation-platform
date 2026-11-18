"""Copy a bounded subset of team pip cache files into the writable scratch space."""

import os
import stat
import time
from pathlib import Path

source = Path("/team-pip-cache")
target = Path(os.environ["PIP_CACHE_DIR"])
remaining = 16 * 1024 * 1024
visited = 0
copied = 0
deadline = time.monotonic() + 2

for directory, children, files, fd in os.fwalk(source, follow_symlinks=False) if source.is_dir() else ():
    visited += len(children) + len(files) + 1
    if visited > 8192 or copied >= 512 or remaining <= 0 or time.monotonic() >= deadline:
        break
    for name in files:
        if copied >= 512 or remaining <= 0 or time.monotonic() >= deadline:
            break
        try:
            with os.fdopen(os.open(name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=fd), "rb") as src:
                info = os.fstat(src.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > remaining:
                    continue
                destination = target / Path(directory).relative_to(source) / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                # Read at most the checked size, including during concurrent cache updates.
                with destination.open("wb") as dst:
                    dst.write(src.read(info.st_size))
                remaining -= info.st_size
                copied += 1
        except OSError:
            continue
