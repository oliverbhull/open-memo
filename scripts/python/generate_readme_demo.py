#!/usr/bin/env python3
"""Generate the lightweight animated README demo."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "assets" / "readme" / "open-memo-demo.gif"
WIDTH, HEIGHT = 960, 540
SCALE = 2
FPS = 20
FRAME_MS = 1000 // FPS
BG = "#FAF9F7"
INK = "#252321"
ACCENT = "#C26D50"
FONT_PATH = "/System/Library/Fonts/SFNS.ttf"
TEXT = "Send me the updated notes before tomorrow's meeting."


def font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size * SCALE)


def ease(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def frame_at(index: int) -> Image.Image:
    # Start one second into the original sequence so the waveform is already live.
    t = index / FPS + 1.0
    image = Image.new("RGB", (WIDTH * SCALE, HEIGHT * SCALE), BG)
    draw = ImageDraw.Draw(image)

    field = (150, 158, 810, 292)
    box = tuple(value * SCALE for value in field)
    draw.rounded_rectangle(
        box,
        radius=24 * SCALE,
        fill="#FFFFFF",
        outline="#DDD9D4",
        width=2 * SCALE,
    )

    body_font = font(25)

    # The complete dictated sentence lands at once on release, matching the app.
    text_start = 3.15
    shown = TEXT if t >= text_start else ""
    text_x, text_y = 178 * SCALE, 207 * SCALE
    draw.text((text_x, text_y), shown, font=body_font, fill=INK)

    # Cursor blinks before recording and after the dictated text appears.
    cursor_visible = (t < 0.7 or t >= text_start) and int(t * 2.5) % 2 == 0
    if cursor_visible:
        cursor_x = text_x + draw.textlength(shown, font=body_font)
        draw.rounded_rectangle(
            (cursor_x + 2 * SCALE, text_y + 2 * SCALE,
             cursor_x + 4 * SCALE, text_y + 35 * SCALE),
            radius=SCALE,
            fill=ACCENT,
        )

    # Fade the real seven-bar overlay in below the focused field.
    waveform_in = ease((t - 0.55) / 0.3)
    waveform_out = 1 - ease((t - 2.85) / 0.3)
    opacity = min(waveform_in, waveform_out)
    if opacity > 0:
        center_x = WIDTH / 2
        center_y = 351
        weights = [0.45, 0.65, 0.85, 1.0, 0.85, 0.65, 0.45]
        phase_offsets = [0.2, 1.7, 3.1, 4.8, 2.5, 5.6, 0.9]
        for bar_index, weight in enumerate(weights):
            wave = (
                0.46
                + 0.26 * math.sin(t * 10.5 + phase_offsets[bar_index])
                + 0.18 * math.sin(t * 18.0 + bar_index * 0.8)
            )
            level = max(0.08, min(1.0, wave))
            bar_height = (4 + level * weight * 42) * opacity
            x = center_x + (bar_index - 3) * 15
            y0 = center_y - bar_height / 2
            y1 = center_y + bar_height / 2
            color = tuple(
                round(bg + (fg - bg) * opacity)
                for bg, fg in zip((250, 249, 247), (194, 109, 80))
            )
            draw.rounded_rectangle(
                ((x - 4) * SCALE, y0 * SCALE, (x + 4) * SCALE, y1 * SCALE),
                radius=4 * SCALE,
                fill=color,
            )

    return image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)


def main() -> None:
    # 3.8 seconds preserves the original ending after trimming its first second.
    frame_count = int(3.8 * FPS)
    frames = [frame_at(index) for index in range(frame_count)]
    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=FRAME_MS,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"Wrote {OUTPUT} ({frame_count} frames)")


if __name__ == "__main__":
    main()
