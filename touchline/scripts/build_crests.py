#!/usr/bin/env python3
"""Builds public/data/crests.json: club id -> path of its crest in github.com/luukhopman/football-logos.

Only the paths are stored in this repository. The images themselves are club trademarks, so they are
downloaded onto your own server by deploy/fetch_crests.sh (run by install.sh) and never committed.

Usage:
  git clone --depth 1 --filter=blob:none --no-checkout https://github.com/luukhopman/football-logos logos
  git -C logos ls-tree -r --name-only HEAD > logo_files.txt
  python3 scripts/build_crests.py logo_files.txt
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORLD = ROOT / "public" / "data" / "world.json"
OUT = ROOT / "public" / "data" / "crests.json"
COUNTRIES = ("England", "Spain", "Germany", "Italy", "France", "Israel")

# our English club name -> crest file name (without .png), where normalisation is not enough
ALIASES = {
    "Hapoel Be'er Sheva": "Hapoel Beer Sheva",
    "Bnei Sakhnin": "Ihud Bnei Sakhnin",
    "Ashdod S.C.": "FC Ashdod",
    "Inter": "Inter Milan",
    "Roma": "AS Roma",
    "Lazio": "SS Lazio",
    "Napoli": "SSC Napoli",
    "FC Bayern München": "Bayern Munich",
    "Borussia Mönchengladbach": "Borussia Mönchengladbach",
    "Bayer 04 Leverkusen": "Bayer 04 Leverkusen",
    "Olympique de Marseille": "Olympique Marseille",
    "Olympique Lyonnais": "Olympique Lyon",
    "LOSC Lille": "LOSC Lille",
    "Paris Saint-Germain": "Paris Saint-Germain",
    "RCD Espanyol de Barcelona": "RCD Espanyol Barcelona",
    "RC Celta": "Celta de Vigo",
    "Atlético Madrid": "Atlético de Madrid",
    "Real Betis": "Real Betis Balompié",
    "Deportivo Alavés": "Deportivo Alavés",
    "Stade Brestois 29": "Stade Brestois 29",
    "RC Strasbourg Alsace": "RC Strasbourg Alsace",
    "Hellas Verona": "Hellas Verona",
    "Wolverhampton Wanderers": "Wolverhampton Wanderers",
    "Tottenham Hotspur": "Tottenham Hotspur",
    "1. FC Heidenheim 1846": "1.FC Heidenheim 1846",
    "1. FC Union Berlin": "1.FC Union Berlin",
    "1. FC Köln": "1.FC Köln",
    "1. FSV Mainz 05": "1.FSV Mainz 05",
    "TSG Hoffenheim": "TSG 1899 Hoffenheim",
    "Pisa": "Pisa Sporting Club",
}

STOP = r"\b(fc|cf|ac|as|sc|afc|ssc|us|ud|cd|rc|rcd|sv|vfl|vfb|tsg|fsv|ogc|losc|club|calcio|football|futbol|sad|ss|bc)\b"


def norm(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\d+", " ", s)
    s = re.sub(STOP, " ", s)
    return re.sub(r"[^a-z]", "", s)


def main(listing):
    files = [l.strip() for l in open(listing, encoding="utf-8") if l.strip().endswith(".png")]
    files = [f for f in files if any(f"/{c} - " in f"/{f.split('/', 2)[-2] if f.startswith('history/') else f.split('/')[1]}" or f.split("/")[-2].startswith(c) for c in COUNTRIES)]

    # newest first: logos/ (current season), then history/ newest season first
    def rank(f):
        if f.startswith("logos/"):
            return "9999"
        return f.split("/")[1]

    files.sort(key=rank, reverse=True)
    by_exact, by_norm = {}, {}
    for f in files:
        stem = f.rsplit("/", 1)[1][:-4]
        by_exact.setdefault(stem, f)
        by_norm.setdefault(norm(stem), f)

    world = json.loads(WORLD.read_text(encoding="utf-8"))
    out, missing = {}, []
    for c in world["clubs"]:
        name = c["en"]
        f = by_exact.get(ALIASES.get(name, name)) or by_norm.get(norm(ALIASES.get(name, name)))
        if not f:
            k = norm(name)
            cands = {v for n, v in by_norm.items() if len(n) > 4 and len(k) > 4 and (n in k or k in n)}
            if len(cands) == 1:
                f = cands.pop()
        if f:
            out[c["id"]] = f
        else:
            missing.append((c["league"], name))
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    print(f"wrote {OUT}: {len(out)} of {len(world['clubs'])} clubs have a crest")
    for lg, name in sorted(missing):
        print(f"  no crest: {lg} {name}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1])
