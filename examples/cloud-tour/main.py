"""A tiny cloud-ready report. No third-party packages required."""

import json
import statistics as stats
from pathlib import Path


def summarize(values):
    return {
        "samples": len(values),
        "mean": round(stats.mean(values), 2),
        "median": stats.median(values),
        "minimum": min(values),
        "maximum": max(values),
    }


if __name__ == "__main__":
    temperatures = [18.5, 20.0, 21.5, 19.0, 23.0, 22.5]
    report = summarize(temperatures)
    print("BOBOCLOUD | Weather station report")
    print("Local source -> Linux runtime -> verifiable result")
    print(json.dumps(report, indent=2))
