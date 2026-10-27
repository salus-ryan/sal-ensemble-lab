#!/usr/bin/env python3
"""Apply a bounded Sal audition recipe to aligned member recordings.

This is an offline development mixer, not the evidence-bound production renderer.
It expects member-1 through member-5 audio files generated from the same Sal render.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
from typing import Any

MEMBER_PANS = (-0.70, -0.35, 0.0, 0.35, 0.70)
MEMBER_SPREAD = (-1.0, -0.5, 0.0, 0.5, 1.0)
MEMBER_SELECTIONS = {
    1: (2,),
    2: (1, 3),
    3: (0, 2, 4),
    4: (0, 1, 3, 4),
    5: (0, 1, 2, 3, 4),
}


def bounded_number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    result = float(value)
    if not math.isfinite(result) or not minimum <= result <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return result


def validate_recipe(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("recipe must be a JSON object")
    if value.get("schema") != "sal-ensemble-audition-v1":
        raise ValueError("unsupported recipe schema")
    members = value.get("members")
    if isinstance(members, bool) or not isinstance(members, int) or members not in MEMBER_SELECTIONS:
        raise ValueError("members must be an integer from 1 through 5")
    return {
        "schema": "sal-ensemble-audition-v1",
        "development_only": True,
        "members": members,
        "register_semitones": bounded_number(
            value.get("register_semitones", 0), "register_semitones", -4, 4
        ),
        "tone": bounded_number(value.get("tone", 0), "tone", -1, 1),
        "stereo_width": bounded_number(
            value.get("stereo_width", 1), "stereo_width", 0, 1.5
        ),
        "maximum_delay_ms": bounded_number(
            value.get("maximum_delay_ms", 8), "maximum_delay_ms", 0, 16
        ),
        "member_variation_cents": bounded_number(
            value.get("member_variation_cents", 0),
            "member_variation_cents",
            0,
            16,
        ),
        "ambience": bounded_number(value.get("ambience", 0), "ambience", 0, 0.3),
        "gender_label": None,
        "identity_note": "Acoustic presentation is not gender identity.",
    }


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def find_member(assets: Path, number: int) -> Path:
    for suffix in (".wav", ".flac", ".mp3", ".ogg", ".m4a"):
        candidate = assets / f"member-{number}{suffix}"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"member-{number} audio was not found in {assets}")


def build_filter(recipe: dict[str, Any], member_indices: tuple[int, ...]) -> str:
    chains: list[str] = []
    labels: list[str] = []
    count = len(member_indices)
    weight = 1.0 / count
    for active_index, member_index in enumerate(member_indices):
        variation = MEMBER_SPREAD[member_index] * recipe["member_variation_cents"] / 100
        semitones = recipe["register_semitones"] + variation
        pitch = 2 ** (semitones / 12)
        delay = 0 if count == 1 else recipe["maximum_delay_ms"] * active_index / (count - 1)
        pan = max(-1.0, min(1.0, MEMBER_PANS[member_index] * recipe["stereo_width"]))
        angle = (pan + 1) * math.pi / 4
        left = math.cos(angle) * math.sqrt(2)
        right = math.sin(angle) * math.sqrt(2)
        label = f"m{active_index}"
        chains.append(
            f"[{active_index}:a]aformat=sample_rates=44100:channel_layouts=mono,"
            f"rubberband=tempo=1:pitch={pitch:.8f}:formant=preserved:pitchq=quality,"
            f"adelay={delay:.3f}:all=1,"
            f"pan=stereo|c0={left:.8f}*c0|c1={right:.8f}*c0,"
            f"volume={weight:.8f}[{label}]"
        )
        labels.append(f"[{label}]")

    low_gain = -recipe["tone"] * 5.0
    high_gain = recipe["tone"] * 6.0
    final = (
        f"{''.join(labels)}amix=inputs={count}:normalize=0:dropout_transition=0,"
        f"bass=g={low_gain:.3f}:f=220:w=0.7,"
        f"treble=g={high_gain:.3f}:f=3400:w=0.7"
    )
    if recipe["ambience"] > 0:
        decay_one = min(0.7, recipe["ambience"] * 1.8)
        decay_two = min(0.5, recipe["ambience"] * 1.2)
        final += f",aecho=0.82:0.88:65|125:{decay_one:.4f}|{decay_two:.4f}"
    final += ",highpass=f=60,lowpass=f=9200,alimiter=limit=0.92:attack=5:release=50[out]"
    chains.append(final)
    return ";".join(chains)


def render(recipe_path: Path, assets: Path, output: Path) -> dict[str, Any]:
    recipe = validate_recipe(json.loads(recipe_path.read_text(encoding="utf-8")))
    member_indices = MEMBER_SELECTIONS[recipe["members"]]
    sources = [find_member(assets, index + 1) for index in member_indices]
    filters = build_filter(recipe, member_indices)
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp.wav")
    command = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    for source in sources:
        command.extend(["-i", str(source)])
    command.extend(
        [
            "-filter_complex",
            filters,
            "-map",
            "[out]",
            "-c:a",
            "pcm_s24le",
            str(temporary),
        ]
    )
    subprocess.run(command, check=True)
    temporary.replace(output)
    provenance = {
        "mode": "development-offline-audition",
        "recipe": recipe,
        "recipe_path": str(recipe_path.resolve()),
        "sources": [
            {"path": str(path.resolve()), "sha256": file_sha256(path)} for path in sources
        ],
        "output": str(output),
        "output_sha256": file_sha256(output),
        "ffmpeg_filter": filters,
        "production_ready": False,
    }
    provenance_path = output.with_suffix(output.suffix + ".json")
    provenance_path.write_text(
        json.dumps(provenance, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return provenance


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--assets-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = render(args.recipe, args.assets_dir, args.output)
    print(result["output"])
    print(f"sha256={result['output_sha256']}")
    print("production_ready=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
