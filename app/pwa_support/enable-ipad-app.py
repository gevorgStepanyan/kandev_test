#!/usr/bin/env python3
"""Add missing iPad home-screen metadata to Ignis's HTML template."""

from html.parser import HTMLParser
from pathlib import Path
import re
import sys


TEMPLATE = Path("apps/ignis-server/server/assets/index.html")
METADATA = (
    ("apple-mobile-web-app-capable", "yes"),
    ("apple-mobile-web-app-title", "Obsidian"),
    ("apple-mobile-web-app-status-bar-style", "black"),
)


class HeadParser(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=True)
        self.source = source
        self.names = set()
        self.in_head = False
        self.head_end = None

    def handle_starttag(self, tag, attrs):
        if tag == "head":
            self.in_head = True
        if tag == "meta" and self.in_head:
            for key, value in attrs:
                if key == "name" and value is not None:
                    self.names.add(value.lower())

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "head" and self.in_head:
            line, column = self.getpos()
            self.head_end = sum(
                len(part) for part in self.source.splitlines(keepends=True)[:line - 1]
            ) + column
            self.in_head = False


def locate_template():
    for candidate in (Path("/app") / TEMPLATE, Path.cwd() / TEMPLATE):
        if candidate.is_file():
            return candidate
    raise ValueError(f"Ignis HTML template not found: /app/{TEMPLATE} or {Path.cwd() / TEMPLATE}")


def patch_template(path):
    original = path.read_bytes()
    # Latin-1 provides a one-to-one mapping so parser offsets remain byte offsets.
    source = original.decode("latin-1")
    parser = HeadParser(source)
    parser.feed(source)
    parser.close()
    if parser.head_end is None:
        raise ValueError(f"No closing </head> tag found in {path}")
    missing = [(name, value) for name, value in METADATA if name not in parser.names]
    if not missing:
        print(f"Unchanged: {path} (all metadata already present)")
        return
    match = re.search(rb"\r\n|\n|\r", original)
    newline = match.group() if match else b"\n"
    tags = newline.join(
        f'<meta name="{name}" content="{value}">'.encode("ascii")
        for name, value in missing
    )
    offset = parser.head_end
    prefix = b"" if original[:offset].endswith((b"\n", b"\r")) else newline
    path.write_bytes(original[:offset] + prefix + tags + newline + original[offset:])
    print(f"Updated: {path} (added {len(missing)} metadata tags)")


def main():
    try:
        patch_template(locate_template())
    except (OSError, ValueError) as error:
        print(f"enable-ipad-app: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
