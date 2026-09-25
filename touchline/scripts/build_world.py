#!/usr/bin/env python3
"""Builds public/data/world.json, the game's starting database (season 2025/26).

Sources:
  * EA FC 26 player dataset (sofifa scrape, 2025-09-19) - real squads for the top two
    divisions of England, Spain, Germany, Italy and France.
    https://github.com/ismailoksuz/EAFC26-DataHub  (data/players.csv)
  * kadishay/israeli-league-charts - the real 2025/26 Ligat ha'Al and Liga Leumit clubs,
    their Hebrew names and kit colours. https://github.com/kadishay/israeli-league-charts
    No open source for Israeli squads was reachable, so Israeli players are generated
    (flagged with "gen": 1) and can be replaced by editing world.json.

Usage:
  python3 scripts/build_world.py path/to/players.csv path/to/israeli-league-charts
"""

import csv
import json
import random
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "world.json"
SEASON_YEAR = 2025

COUNTRIES = [
    {"id": "eng", "name": "אנגליה", "flag": "\U0001F3F4\U000E0067\U000E0062\U000E0065\U000E006E\U000E0067\U000E007F"},
    {"id": "esp", "name": "ספרד", "flag": "🇪🇸"},
    {"id": "ger", "name": "גרמניה", "flag": "🇩🇪"},
    {"id": "ita", "name": "איטליה", "flag": "🇮🇹"},
    {"id": "fra", "name": "צרפת", "flag": "🇫🇷"},
    {"id": "isr", "name": "ישראל", "flag": "🇮🇱"},
]

# fc league id -> our league. "down"/"up" = clubs relegated/promoted at season end.
LEAGUES = [
    {"id": "eng1", "fc": "13.0", "country": "eng", "tier": 1, "name": "Premier League", "down": 3, "rep": 100},
    {"id": "eng2", "fc": "14.0", "country": "eng", "tier": 2, "name": "Championship", "up": 3, "rep": 60},
    {"id": "esp1", "fc": "53.0", "country": "esp", "tier": 1, "name": "La Liga", "down": 3, "rep": 92},
    {"id": "esp2", "fc": "54.0", "country": "esp", "tier": 2, "name": "La Liga 2", "up": 3, "rep": 45},
    {"id": "ger1", "fc": "19.0", "country": "ger", "tier": 1, "name": "Bundesliga", "down": 2, "rep": 88},
    {"id": "ger2", "fc": "20.0", "country": "ger", "tier": 2, "name": "2. Bundesliga", "up": 2, "rep": 50},
    {"id": "ita1", "fc": "31.0", "country": "ita", "tier": 1, "name": "Serie A", "down": 3, "rep": 88},
    {"id": "ita2", "fc": "32.0", "country": "ita", "tier": 2, "name": "Serie B", "up": 3, "rep": 42},
    {"id": "fra1", "fc": "16.0", "country": "fra", "tier": 1, "name": "Ligue 1", "down": 2, "rep": 80},
    {"id": "fra2", "fc": "17.0", "country": "fra", "tier": 2, "name": "Ligue 2", "up": 2, "rep": 40},
    {"id": "isr1", "country": "isr", "tier": 1, "name": "ליגת העל", "down": 2, "rep": 35},
    {"id": "isr2", "country": "isr", "tier": 2, "name": "הליגה הלאומית", "up": 2, "rep": 15},
]

# Kit colours for top-flight clubs (primary, secondary). Others get a stable generated pair.
KITS = {
    "Arsenal": ("#EF0107", "#FFFFFF"), "Aston Villa": ("#670E36", "#95BFE5"), "AFC Bournemouth": ("#DA291C", "#000000"),
    "Brentford": ("#E30613", "#FFFFFF"), "Brighton & Hove Albion": ("#0057B8", "#FFFFFF"), "Burnley": ("#6C1D45", "#99D6EA"),
    "Chelsea": ("#034694", "#FFFFFF"), "Crystal Palace": ("#1B458F", "#C4122E"), "Everton": ("#003399", "#FFFFFF"),
    "Fulham": ("#FFFFFF", "#000000"), "Leeds United": ("#FFFFFF", "#1D428A"), "Liverpool": ("#C8102E", "#FFFFFF"),
    "Manchester City": ("#6CABDD", "#FFFFFF"), "Manchester United": ("#DA291C", "#FBE122"), "Newcastle United": ("#241F20", "#FFFFFF"),
    "Nottingham Forest": ("#DD0000", "#FFFFFF"), "Sunderland": ("#EB172B", "#FFFFFF"), "Tottenham Hotspur": ("#FFFFFF", "#132257"),
    "West Ham United": ("#7A263A", "#1BB1E7"), "Wolverhampton Wanderers": ("#FDB913", "#231F20"),
    "Real Madrid": ("#FFFFFF", "#FEBE10"), "FC Barcelona": ("#A50044", "#004D98"), "Atlético Madrid": ("#CB3524", "#FFFFFF"),
    "Athletic Club": ("#EE2523", "#FFFFFF"), "Real Sociedad": ("#0067B1", "#FFFFFF"), "Real Betis": ("#00954C", "#FFFFFF"),
    "Villarreal CF": ("#FFE667", "#005187"), "Valencia CF": ("#FFFFFF", "#EE3524"), "Sevilla FC": ("#FFFFFF", "#D80A1E"),
    "RC Celta": ("#8AC3EE", "#FFFFFF"), "CA Osasuna": ("#D91A21", "#0A346F"), "Getafe CF": ("#005999", "#FFFFFF"),
    "Girona FC": ("#DA291C", "#FFFFFF"), "RCD Mallorca": ("#E20613", "#000000"), "Rayo Vallecano": ("#FFFFFF", "#E53027"),
    "Deportivo Alavés": ("#0761AF", "#FFFFFF"), "RCD Espanyol de Barcelona": ("#007FC8", "#FFFFFF"), "Elche CF": ("#FFFFFF", "#05642C"),
    "Levante UD": ("#004D98", "#A50044"), "Real Oviedo": ("#0047AB", "#FFFFFF"),
    "FC Bayern München": ("#DC052D", "#FFFFFF"), "Borussia Dortmund": ("#FDE100", "#000000"), "Bayer 04 Leverkusen": ("#E32221", "#000000"),
    "RB Leipzig": ("#FFFFFF", "#DD0741"), "Eintracht Frankfurt": ("#000000", "#E1000F"), "VfB Stuttgart": ("#FFFFFF", "#E32219"),
    "SC Freiburg": ("#000000", "#E2001A"), "VfL Wolfsburg": ("#65B32E", "#FFFFFF"), "Borussia Mönchengladbach": ("#FFFFFF", "#000000"),
    "1. FSV Mainz 05": ("#C3141E", "#FFFFFF"), "TSG Hoffenheim": ("#1C63B7", "#FFFFFF"), "1. FC Union Berlin": ("#EB1923", "#FFFFFF"),
    "FC Augsburg": ("#BA3733", "#46714D"), "SV Werder Bremen": ("#1D9053", "#FFFFFF"), "1. FC Heidenheim 1846": ("#E30613", "#003B79"),
    "FC St. Pauli": ("#624839", "#FFFFFF"), "Hamburger SV": ("#FFFFFF", "#0A3F86"), "1. FC Köln": ("#FFFFFF", "#ED1C24"),
    "Inter": ("#010E80", "#000000"), "AC Milan": ("#FB090B", "#000000"), "Juventus": ("#FFFFFF", "#000000"),
    "Napoli": ("#12A0D7", "#FFFFFF"), "Roma": ("#8E1F2F", "#F0BC42"), "Lazio": ("#87D8F7", "#FFFFFF"),
    "Atalanta": ("#1E71B8", "#000000"), "Fiorentina": ("#482E92", "#FFFFFF"), "Bologna": ("#A21C26", "#1A2F48"),
    "Torino": ("#8A1E03", "#FFFFFF"), "Genoa": ("#AD1919", "#002147"), "Udinese": ("#FFFFFF", "#000000"),
    "Cagliari": ("#B01028", "#002350"), "Lecce": ("#FFED00", "#DA291C"), "Parma": ("#FFFFFF", "#FFD200"),
    "Como": ("#1E3F8A", "#FFFFFF"), "Hellas Verona": ("#FFD700", "#00236D"), "Sassuolo": ("#00A752", "#000000"),
    "Cremonese": ("#E3001B", "#9B9B9B"), "Pisa": ("#000000", "#1A4AB5"),
    "Paris Saint-Germain": ("#004170", "#DA291C"), "Olympique de Marseille": ("#FFFFFF", "#2FAEE0"), "AS Monaco": ("#E7001B", "#FFFFFF"),
    "LOSC Lille": ("#E01E13", "#20325F"), "Olympique Lyonnais": ("#FFFFFF", "#DA001A"), "OGC Nice": ("#C8102E", "#000000"),
    "RC Lens": ("#FFD700", "#E4032E"), "Stade Rennais FC": ("#E13327", "#000000"), "RC Strasbourg Alsace": ("#009FE3", "#FFFFFF"),
    "Stade Brestois 29": ("#E10613", "#FFFFFF"), "Toulouse FC": ("#5B2C83", "#FFFFFF"), "FC Nantes": ("#FCD405", "#00843D"),
    "AJ Auxerre": ("#FFFFFF", "#0055A4"), "Angers SCO": ("#FFFFFF", "#000000"), "Le Havre AC": ("#87CEEB", "#00205B"),
    "FC Lorient": ("#F58113", "#000000"), "FC Metz": ("#8B0E3A", "#FFFFFF"), "Paris FC": ("#0B1D45", "#FFFFFF"),
}

# Rough strength (avg first-team overall) of Israeli clubs, 2025/26.
IL_STRENGTH = {
    "Maccabi Tel Aviv": 72, "Hapoel Be'er Sheva": 71, "Maccabi Haifa": 71, "Beitar Jerusalem": 70,
    "Hapoel Tel Aviv": 67, "Hapoel Haifa": 65, "Maccabi Netanya": 65, "Hapoel Jerusalem": 64,
    "Hapoel Petah Tikva": 64, "Maccabi Bnei Reineh": 63, "Ironi Kiryat Shmona": 63, "Bnei Sakhnin": 63,
    "Ashdod S.C.": 63, "Ironi Tiberias": 62,
}
IL_ARAB_CLUBS = {"Bnei Sakhnin", "Maccabi Bnei Reineh", "M.S. Kafr Qasim", "Hapoel Nof HaGalil", "Hapoel Umm al-Fahm", "Maccabi Ahi Nazareth"}
IL_HE_FALLBACK = {"M.S. Kiryat Yam": "מ.ס. קריית ים"}

HE_FIRST = ["יונתן", "עומר", "דור", "אליאור", "שון", "רועי", "אופיר", "נועם", "תומר", "איתי", "עידו", "יובל", "ליאור",
            "מתן", "אביב", "גיא", "שחר", "אלון", "רז", "בן", "אור", "סתיו", "אדיר", "מאור", "דניאל", "איתמר", "אליאל",
            "עמית", "ניר", "אלמוג", "הראל", "שגיא", "טל", "ירין", "עדן", "אסף", "אייל", "נתנאל", "אביאל", "אלעד",
            "עוז", "רון", "יהב", "אושר", "אורי", "ליעד", "עמרי", "נדב", "אריאל", "שלו"]
HE_LAST = ["כהן", "לוי", "פרץ", "ביטון", "אזולאי", "מזרחי", "דהן", "אברהם", "פרידמן", "שפירא", "גבאי", "אוחיון", "חדד",
           "אלמוג", "מלכה", "עמר", "יוסף", "חזן", "אדרי", "סויסה", "בוזגלו", "אלון", "שושן", "טל", "גולן", "בר",
           "נחום", "שמעוני", "רוזן", "קליין", "זילברמן", "אשכנזי", "ברק", "סבג", "אלקבץ", "טייב", "שטרית", "וקנין",
           "ששון", "נגר", "בן חיים", "בן דוד", "אבוטבול", "חביב", "מימון", "קורן", "רביבו", "אסולין", "זכאי", "דיין"]
AR_FIRST = ["מוחמד", "אחמד", "מחמוד", "עלי", "חסן", "מוניס", "איאד", "סאלח", "כרים", "יוסף", "ח'אלד", "עומר",
            "מוסא", "עבד", "סאמר", "ראמי", "פאדי", "אנאס", "ווסים", "זיאד", "טארק", "האני", "בילאל", "ג'יהאד"]
AR_LAST = ["אבו זייד", "חלאילה", "ג'אבר", "סעדי", "ח'טיב", "עבד אל חלים", "גנאים", "מסארווה", "זועבי", "טאהא",
           "עאמר", "בדיר", "נסאר", "חמדאן", "עותמאן", "ח'ליל", "סלאמה", "אבו רומי", "קאסם", "מוסטפא", "עיסא", "שלאעטה"]

SQUAD_TEMPLATE = ["GK", "GK", "GK", "CB", "CB", "CB", "CB", "CB", "LB", "LB", "RB", "RB", "CDM", "CDM", "CM", "CM", "CM",
                  "CAM", "CAM", "LM", "RM", "LW", "RW", "ST", "ST", "ST"]
POS_ATTR = {  # attribute bias per position: pace, shooting, passing, dribbling, defending, physical
    "CB": (-6, -25, -8, -12, 8, 6), "LB": (4, -18, -3, -2, 2, 0), "RB": (4, -18, -3, -2, 2, 0),
    "CDM": (-6, -12, 0, -4, 4, 6), "CM": (-3, -4, 4, 1, -6, 0), "CAM": (0, 2, 5, 6, -25, -6),
    "LM": (6, -2, 1, 4, -18, -4), "RM": (6, -2, 1, 4, -18, -4), "LW": (8, 0, 0, 6, -30, -6),
    "RW": (8, 0, 0, 6, -30, -6), "ST": (4, 6, -6, 1, -35, 4),
}


def slug(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def kit(name):
    if name in KITS:
        return list(KITS[name])
    rnd = random.Random(name)
    palette = ["#C8102E", "#0033A0", "#006B3F", "#FFD100", "#000000", "#FFFFFF", "#6CACE4", "#7A263A", "#F47B20", "#5B2C83"]
    a = rnd.choice(palette)
    b = rnd.choice([c for c in palette if c != a])
    return [a, b]


def num(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


def main(fc_csv, il_repo):
    random.seed(2025)
    rows = list(csv.DictReader(open(fc_csv, encoding="utf-8")))
    by_fc = {lg["fc"]: lg for lg in LEAGUES if "fc" in lg}
    clubs, players, club_index = [], [], {}

    def add_club(name, league, colors, he=None):
        cid = slug(name)
        club = {"id": cid, "name": he or name, "en": name, "league": league["id"], "colors": colors}
        clubs.append(club)
        club_index[(league["id"], name)] = club
        return club

    # ---- real players (FC 26) ----
    for r in rows:
        lg = by_fc.get(r["league_id"])
        if not lg:
            continue
        key = (lg["id"], r["club_name"])
        club = club_index.get(key) or add_club(r["club_name"], lg, kit(r["club_name"]))
        positions = [p.strip() for p in r["player_positions"].split(",")]
        pos = positions[0]
        if pos == "GK":
            attrs = [num(r[k]) for k in ("goalkeeping_diving", "goalkeeping_handling", "goalkeeping_kicking",
                                         "goalkeeping_reflexes", "goalkeeping_speed", "goalkeeping_positioning")]
        else:
            attrs = [num(r[k]) for k in ("pace", "shooting", "passing", "dribbling", "defending", "physic")]
        players.append({
            "id": len(players) + 1, "n": r["short_name"], "fn": r["long_name"], "c": club["id"],
            "pos": pos, "alt": positions[1:], "age": num(r["age"]), "ovr": num(r["overall"]), "pot": num(r["potential"]),
            "at": attrs, "v": num(r["value_eur"]), "w": num(r["wage_eur"]), "nat": r["nationality_name"],
            "ft": (r["preferred_foot"] or "Right")[0], "no": num(r["club_jersey_number"]),
            "ctr": num(r["club_contract_valid_until_year"], SEASON_YEAR + 2),
        })

    # ---- Israeli clubs (real) + generated squads ----
    il = Path(il_repo)
    seasons = list(csv.DictReader(open(il / "data" / "seasons.csv", encoding="utf-8")))
    colors = json.load(open(il / "data" / "club_colors.json", encoding="utf-8"))["colors"]
    he_names = {}
    for name, c in colors.items():
        he_names[name] = re.sub(r"\s*\(.*\)\s*$", "", c["article"])
    he_names.update(IL_HE_FALLBACK)
    latin = re.compile(r"^[A-Za-z\u00C0-\u024F' .-]+$")
    foreign_pool = [r for r in rows if r["league_id"] not in by_fc and latin.match(r["long_name"] or "")]

    for lg_name, league in (("Ligat ha'Al", LEAGUES[10]), ("Liga Leumit", LEAGUES[11])):
        names = [r["club"] for r in seasons if r["season_start"] == str(SEASON_YEAR) and r["league"] == lg_name]
        for name in names:
            c = colors.get(name, {})
            col = [c.get("color", "#0033A0"), c.get("secondary", "#FFFFFF")]
            club = add_club(name, league, col, he_names.get(name, name))
            base = IL_STRENGTH.get(name, 59 + random.randint(-2, 2)) - 2
            arab_share = 0.7 if name in IL_ARAB_CLUBS else 0.12
            n_foreign = 6 if league["tier"] == 1 else 2
            used_numbers = set()
            foreign_slots = set(random.sample(range(len(SQUAD_TEMPLATE)), n_foreign))
            for i, pos in enumerate(SQUAD_TEMPLATE):
                age = random.choice(range(18, 35))
                # foreigners are usually among the better players; every third slot is a backup
                ovr = int(round(base + random.gauss(0, 2.5) + (2 if i in foreign_slots else 0) - (4 if i % 3 == 2 else 0)))
                ovr = max(48, min(80, ovr - (6 if age < 20 else 0)))
                pot = max(ovr, min(88, ovr + max(0, (24 - age)) * random.randint(1, 3)))
                if i in foreign_slots:
                    a, b = random.sample(foreign_pool, 2)
                    first = a["long_name"].split()[0]
                    last = b["long_name"].split()[-1]
                    name_str, nat = f"{first} {last}", a["nationality_name"]
                    full = name_str
                elif random.random() < arab_share:
                    name_str = f"{random.choice(AR_FIRST)} {random.choice(AR_LAST)}"
                    nat, full = "Israel", None
                else:
                    name_str = f"{random.choice(HE_FIRST)} {random.choice(HE_LAST)}"
                    nat, full = "Israel", None
                if pos == "GK":
                    attrs = [max(30, min(90, ovr + random.randint(-4, 4))) for _ in range(6)]
                    attrs[4] = max(30, ovr - 25 + random.randint(-5, 5))
                else:
                    attrs = [max(25, min(92, ovr + bias + random.randint(-5, 5))) for bias in POS_ATTR[pos]]
                value = int(round(max(50_000, (1.18 ** (ovr - 55)) * 120_000 * (1.3 if age < 24 else 0.8 if age > 30 else 1)), -4))
                wage = int(round(max(800, (1.14 ** (ovr - 55)) * 1_200), -2))
                no = 1 if pos == "GK" and 1 not in used_numbers else random.choice([n for n in range(2, 40) if n not in used_numbers])
                used_numbers.add(no)
                players.append({
                    "id": len(players) + 1, "n": name_str, "fn": full or name_str, "c": club["id"], "pos": pos, "alt": [],
                    "age": age, "ovr": ovr, "pot": pot, "at": attrs, "v": value, "w": wage, "nat": nat,
                    "ft": "L" if random.random() < 0.22 else "R", "no": no, "ctr": SEASON_YEAR + random.randint(1, 4), "gen": 1,
                })

    # ---- club finances & reputation ----
    squad = defaultdict(list)
    for p in players:
        squad[p["c"]].append(p)
    league_by_id = {lg["id"]: lg for lg in LEAGUES}
    for club in clubs:
        sq = sorted(squad[club["id"]], key=lambda p: -p["ovr"])
        top = sq[:16]
        avg = sum(p["ovr"] for p in top) / len(top)
        value = sum(p["v"] for p in sq)
        lg = league_by_id[club["league"]]
        club["rep"] = round(avg)
        club["budget"] = int(round(max(300_000, value * (0.14 if lg["tier"] == 1 else 0.09)), -5))
        club["wageBudget"] = int(round(sum(p["w"] for p in sq) * 1.1, -3))

    leagues_out = [{k: v for k, v in lg.items() if k != "fc"} for lg in LEAGUES]
    world = {
        "version": 1, "season": SEASON_YEAR, "countries": COUNTRIES, "leagues": leagues_out, "clubs": clubs,
        "players": players,
        "sources": {
            "players": "EA FC 26 dataset via github.com/ismailoksuz/EAFC26-DataHub (2025-09-19)",
            "israel": "Clubs from github.com/kadishay/israeli-league-charts; Israeli squads are generated",
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(world, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = defaultdict(int)
    for c in clubs:
        counts[c["league"]] += 1
    print(f"wrote {OUT} - {len(clubs)} clubs, {len(players)} players")
    for lg in LEAGUES:
        print(f"  {lg['id']}: {counts[lg['id']]} clubs")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
