#!/usr/bin/env python3
import re
import sys
from pathlib import Path

NOISE_PATTERNS = [
    re.compile(r"^\[steam-integration\] (Using cached|Cached) "),
    re.compile(r"^task finished "),
    re.compile(r"^\[steam-integration\] dispatched response to "),
    re.compile(r"^\[fatboy-unpack\] dispatched response to "),
    re.compile(r"^\[steamrip-addon\] dispatched response to "),
    re.compile(r"^Checking for updates for "),
    re.compile(r"^\[steam-integration\] Checking for updates for "),
    re.compile(r"^Setting events-available to "),
]

IMPORTANT_PATTERNS = [
    re.compile(r"Error|UnhandledPromiseRejection|fatal:|failed|Failed|ENOENT|AxiosError|NetworkError|Cloudflare|not a git repository|readyState|timeout|SIGTERM|AbortError", re.I),
    re.compile(r"Addon .*updates?|updated successfully|addons failed", re.I),
    re.compile(r"Starting addon|Stopping addon|All addons started|Stopping server|Addon Server", re.I),
]

DUMP_START_PATTERNS = [
    re.compile(r"^\[fatboy-unpack\] directHeader HTMLHeadingElement"),
    re.compile(r"^\s+\[Symbol\(impl\)\]:"),
]

DUMP_END_PATTERNS = [
    re.compile(r"^\[Error:"),
    re.compile(r"^\[[^\]]+\]"),
    re.compile(r"^task finished "),
    re.compile(r"^Sent app details"),
    re.compile(r"^dispatched response"),
]

STACK_CONTINUATION = re.compile(r"^\s+(at |code:|killed:|signal:|cmd:|errno:|syscall:|path:|message:|name:|stack:|isAxiosError:|})")

def is_noise(line: str) -> bool:
    return any(p.search(line) for p in NOISE_PATTERNS)

def is_important(line: str) -> bool:
    return any(p.search(line) for p in IMPORTANT_PATTERNS)

def clean_log(src: Path, dst: Path) -> None:
    lines = src.read_text(errors="replace").splitlines()
    out = []
    skipped_noise = 0
    skipped_dump = 0
    in_dump = False
    previous_kept_was_blank = False

    for i, line in enumerate(lines, start=1):
        if in_dump:
            if any(p.search(line) for p in DUMP_END_PATTERNS):
                out.append(f"[clean-log] omitted {skipped_dump} lines of verbose object dump")
                out.append("")
                in_dump = False
                skipped_dump = 0
                # fall through and process this line normally
            else:
                skipped_dump += 1
                continue

        if any(p.search(line) for p in DUMP_START_PATTERNS):
            out.append(f"{i}: {line}")
            in_dump = True
            skipped_dump = 0
            continue

        if is_noise(line) and not is_important(line):
            skipped_noise += 1
            continue

        keep = is_important(line) or STACK_CONTINUATION.search(line) or line.strip() == "" or line.startswith("From ") or line.startswith("Updating ") or line.startswith("Fast-forward")

        if keep:
            if line.strip() == "":
                if previous_kept_was_blank:
                    continue
                previous_kept_was_blank = True
                out.append("")
            else:
                previous_kept_was_blank = False
                out.append(f"{i}: {line}")

    if in_dump:
        out.append(f"[clean-log] omitted {skipped_dump} lines of verbose object dump")

    header = [
        f"Cleaned log: {src}",
        f"Original lines: {len(lines)}",
        f"Removed low-value repeated lines: {skipped_noise}",
        "",
    ]
    dst.write_text("\n".join(header + out) + "\n")

if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print(f"Usage: {sys.argv[0]} INPUT_LOG [OUTPUT_LOG]", file=sys.stderr)
        sys.exit(2)

    src = Path(sys.argv[1]).expanduser()
    dst = Path(sys.argv[2]).expanduser() if len(sys.argv) == 3 else src.with_suffix(src.suffix + ".cleaned")
    clean_log(src, dst)
    print(dst)
