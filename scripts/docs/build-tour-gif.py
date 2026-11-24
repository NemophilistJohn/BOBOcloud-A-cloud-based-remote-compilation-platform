"""Build a GitHub-friendly captioned GIF from an edited screenshot sequence.

Requires Pillow. The manifest is a JSON list of file/duration/en/zh records.
Input files stay outside the published media directory. No service credentials
or application profiles are read by this renderer.
"""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--locale", choices=("en", "zh"), default="en")
    parser.add_argument("--font", type=Path, required=True)
    args = parser.parse_args()
    records = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(records, list) or not records:
        raise ValueError("The manifest must contain captured frames")
    title_font = ImageFont.truetype(str(args.font), 19)
    caption_font = ImageFont.truetype(str(args.font), 22)
    frames, durations = [], []
    for index, record in enumerate(records):
        source = Path(record["file"])
        if not source.is_absolute():
            source = args.manifest.parent / source
        with Image.open(source) as image:
            body = image.convert("RGB")
        body.thumbnail((1080, 675), Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", (1080, 777), "#101311")
        draw = ImageDraw.Draw(canvas)
        draw.text((22, 10), "BOBOCLOUD  /  CLOUD FORGE", fill="#d8a63f", font=title_font)
        draw.text((870, 10), f"{index + 1:02d} / {len(records):02d}", fill="#aab2aa", font=title_font)
        canvas.paste(body, ((1080 - body.width) // 2, 42))
        caption = record[args.locale]
        if draw.textbbox((0, 0), caption, font=caption_font)[2] > 1036:
            raise ValueError("Caption is too long for the frame")
        draw.text((22, 726), caption, fill="#edf0ed", font=caption_font)
        frames.append(canvas.quantize(colors=192, method=Image.Quantize.MEDIANCUT))
        duration = int(record["duration"])
        if not 100 <= duration <= 10000:
            raise ValueError("Frame duration must be between 100 and 10000 ms")
        durations.append(duration)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(args.output, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, optimize=True, disposal=2)
    print(f"{args.output}: {len(frames)} edited frames, {sum(durations)} ms, {args.output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
