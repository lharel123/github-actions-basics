/* Touchline game engine: world state, match simulation, seasons, transfers and the Be a Pro career.
 * Pure logic, no DOM. Loaded as a classic script in the browser (window.Engine) and via require() in tests. */
(function (root, factory) {
  const E = factory();
  if (typeof module === 'object' && module.exports) module.exports = E;
  else root.Engine = E;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- random ----------
  let rngState = 0;
  let useSeed = false;
  function setSeed(seed) {
    rngState = seed >>> 0;
    useSeed = true;
  }
  function rnd() {
    if (!useSeed) return Math.random();
    // mulberry32
    rngState = (rngState + 0x6d2b79f5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function gauss() {
    let u = 0;
    for (let i = 0; i < 6; i++) u += rnd();
    return u - 3;
  }
  function weighted(items, weightFn) {
    let total = 0;
    const ws = items.map((it) => {
      const w = Math.max(0, weightFn(it));
      total += w;
      return w;
    });
    if (total <= 0) return items[0];
    let r = rnd() * total;
    for (let i = 0; i < items.length; i++) {
      r -= ws[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- constants ----------
  const SEASON_WEEKS = 46;
  const WINTER_WINDOW = [21, 25]; // weeks (January)
  const SUMMER_WINDOW_END = 3; // weeks 0..3 (until early September)

  const FORMATIONS = {
    '4-4-2': ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'],
    '4-3-3': ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CDM', 'CM', 'LW', 'ST', 'RW'],
    '4-2-3-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'LW', 'CAM', 'RW', 'ST'],
    '4-1-4-1': ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'LM', 'CM', 'CM', 'RM', 'ST'],
    '3-5-2': ['GK', 'CB', 'CB', 'CB', 'LM', 'CM', 'CDM', 'CM', 'RM', 'ST', 'ST'],
    '5-3-2': ['GK', 'LWB', 'CB', 'CB', 'CB', 'RWB', 'CM', 'CM', 'CM', 'ST', 'ST'],
  };
  const MENTALITIES = {
    defensive: { att: 0.94, def: 1.06, label: 'הגנתי' },
    balanced: { att: 1, def: 1, label: 'מאוזן' },
    attacking: { att: 1.06, def: 0.95, label: 'התקפי' },
  };
  const GROUP = {
    GK: 'G', CB: 'D', LB: 'D', RB: 'D', LWB: 'D', RWB: 'D',
    CDM: 'M', CM: 'M', CAM: 'M', LM: 'M', RM: 'M', LW: 'A', RW: 'A', ST: 'A', CF: 'A',
  };
  const NEAR = {
    LB: ['LWB', 'LM'], RB: ['RWB', 'RM'], LWB: ['LB', 'LM'], RWB: ['RB', 'RM'], CB: ['CDM'],
    CDM: ['CM', 'CB'], CM: ['CDM', 'CAM'], CAM: ['CM', 'CF', 'ST'], LM: ['LW', 'LB', 'LWB'], RM: ['RW', 'RB', 'RWB'],
    LW: ['LM', 'ST'], RW: ['RM', 'ST'], ST: ['CF', 'CAM'], CF: ['ST', 'CAM'],
  };
  const POS_HE = {
    GK: 'שוער', CB: 'בלם', LB: 'מגן שמאלי', RB: 'מגן ימני', LWB: 'כנף-מגן שמאלי', RWB: 'כנף-מגן ימני',
    CDM: 'קשר אחורי', CM: 'קשר', CAM: 'קשר התקפי', LM: 'קשר שמאלי', RM: 'קשר ימני',
    LW: 'כנף שמאלי', RW: 'כנף ימני', ST: 'חלוץ', CF: 'חלוץ מרכזי',
  };
  const ATTR_HE = ['מהירות', 'בעיטה', 'מסירה', 'כדרור', 'הגנה', 'פיזיות'];
  const GK_ATTR_HE = ['זינוק', 'תפיסה', 'בעיטה', 'רפלקסים', 'מהירות', 'מיקום'];

  function group(pos) {
    return GROUP[pos] || 'M';
  }

  // ---------- valuation ----------
  function valueFor(ovr, age, pot) {
    const d = ovr - 55;
    let v = 300000 * Math.exp(0.15 * d + 0.0015 * d * Math.abs(d));
    if (age <= 20) v *= 1.3;
    else if (age <= 26) v *= 1.1;
    else if (age >= 34) v *= 0.25;
    else if (age >= 32) v *= 0.45;
    else if (age >= 30) v *= 0.7;
    if (age < 24 && pot > ovr) v *= 1 + (pot - ovr) * 0.04;
    return Math.round(clamp(v, 20000, 200000000) / 10000) * 10000;
  }
  function wageFor(ovr) {
    const d = ovr - 55;
    return Math.round(clamp(1500 * Math.exp(0.12 * d + 0.001 * d * Math.abs(d)), 500, 400000) / 100) * 100;
  }

  // ---------- world setup ----------
  function newState(world, opts) {
    const state = {
      v: 1,
      mode: opts.mode,
      seasonYear: world.season,
      week: 0,
      countries: world.countries,
      leagues: world.leagues.map((l) => ({ ...l })),
      clubs: {},
      players: {},
      nextPlayerId: 1,
      tables: {},
      fixtures: {},
      inbox: [],
      history: [],
      news: [],
      user: null,
      pro: null,
      transfersLog: [],
    };
    for (const c of world.clubs) {
      state.clubs[c.id] = {
        ...c,
        colors: c.colors.slice(),
        balance: c.budget,
        income: Math.round(c.wageBudget * 1.02),
        formation: '4-4-2',
        mentality: 'balanced',
        lineup: null,
        form: [],
      };
    }
    for (const p of world.players) {
      state.players[p.id] = {
        ...p,
        at: p.at.slice(),
        alt: (p.alt || []).slice(),
        cond: 100,
        morale: 70,
        inj: 0,
        sus: 0,
        listed: false,
        st: emptyStats(),
      };
      state.nextPlayerId = Math.max(state.nextPlayerId, p.id + 1);
    }
    for (const c of Object.values(state.clubs)) {
      c.formation = bestFormation(state, c.id);
    }
    buildNamePools(state);
    startSeason(state);
    return state;
  }

  function emptyStats() {
    return { app: 0, gl: 0, as: 0, rt: 0, cs: 0, yc: 0, rc: 0, min: 0 };
  }

  function squad(state, clubId) {
    const out = [];
    for (const p of Object.values(state.players)) if (p.c === clubId) out.push(p);
    return out;
  }
  function clubsIn(state, leagueId) {
    return Object.values(state.clubs).filter((c) => c.league === leagueId);
  }
  function leagueOf(state, clubId) {
    const c = state.clubs[clubId];
    return state.leagues.find((l) => l.id === c.league);
  }

  // Name pools per country for youth/regens, built from the players already in that country.
  function buildNamePools(state) {
    const pools = {};
    for (const p of Object.values(state.players)) {
      const club = state.clubs[p.c];
      if (!club) continue;
      const lg = state.leagues.find((l) => l.id === club.league);
      const parts = String(p.fn || p.n).split(' ');
      if (parts.length < 2) continue;
      const key = lg.country + '|' + p.nat;
      const pool = pools[key] || (pools[key] = { first: [], last: [], nat: p.nat });
      if (pool.first.length < 400) pool.first.push(parts[0]);
      if (pool.last.length < 400) pool.last.push(parts[parts.length - 1]);
    }
    const byCountry = {};
    for (const [key, pool] of Object.entries(pools)) {
      const country = key.split('|')[0];
      (byCountry[country] || (byCountry[country] = [])).push(pool);
    }
    state.namePools = byCountry;
  }
  function randomName(state, country) {
    const pools = state.namePools[country] || [];
    const pool = weighted(pools, (p) => p.first.length * p.first.length);
    if (!pool) return { name: 'Player ' + state.nextPlayerId, nat: 'Unknown' };
    return { name: pick(pool.first) + ' ' + pick(pool.last), nat: pool.nat };
  }

  // ---------- lineups ----------
  function fit(p, slot) {
    if (p.pos === slot || (p.alt && p.alt.includes(slot))) return 1;
    if ((p.pos === 'GK') !== (slot === 'GK')) return 0.35;
    if (NEAR[p.pos] && NEAR[p.pos].includes(slot)) return 0.93;
    if (group(p.pos) === group(slot)) return 0.86;
    return 0.72;
  }
  function effective(p, slot) {
    const condF = 0.75 + 0.25 * (p.cond / 100);
    const moraleF = 0.97 + 0.06 * (p.morale / 100);
    return p.ovr * fit(p, slot) * condF * moraleF;
  }
  function available(p) {
    return p.inj <= 0 && p.sus <= 0;
  }

  function autoLineup(state, clubId, formation) {
    const slots = FORMATIONS[formation];
    const pool = squad(state, clubId).filter(available);
    const used = new Set();
    const xi = new Array(slots.length).fill(null);
    // fill GK first, then the slots with the fewest natural candidates
    const order = slots
      .map((s, i) => ({ s, i, n: pool.filter((p) => fit(p, s) === 1).length }))
      .sort((a, b) => (a.s === 'GK' ? -1 : b.s === 'GK' ? 1 : a.n - b.n));
    for (const { s, i } of order) {
      let best = null;
      let bestV = -1;
      for (const p of pool) {
        if (used.has(p.id)) continue;
        const v = effective(p, s);
        if (v > bestV) {
          bestV = v;
          best = p;
        }
      }
      if (best) {
        xi[i] = best.id;
        used.add(best.id);
      }
    }
    const rest = pool.filter((p) => !used.has(p.id)).sort((a, b) => b.ovr * (b.cond / 100) - a.ovr * (a.cond / 100));
    const bench = [];
    const gk = rest.find((p) => p.pos === 'GK');
    if (gk) bench.push(gk.id);
    for (const p of rest) {
      if (bench.length >= 9) break;
      if (!bench.includes(p.id)) bench.push(p.id);
    }
    return { formation, xi, bench };
  }

  function bestFormation(state, clubId) {
    let best = '4-4-2';
    let bestV = -1;
    for (const f of Object.keys(FORMATIONS)) {
      const lu = autoLineup(state, clubId, f);
      const v = lu.xi.reduce((s, id, i) => s + (id ? effective(state.players[id], FORMATIONS[f][i]) : 0), 0);
      if (v > bestV) {
        bestV = v;
        best = f;
      }
    }
    return best;
  }

  // Returns a valid lineup for a club: the manager's saved one (repaired if needed) or an automatic one.
  function lineupFor(state, clubId) {
    const club = state.clubs[clubId];
    const auto = autoLineup(state, clubId, club.formation);
    if (!club.lineup || club.lineup.formation !== club.formation) return auto;
    const valid = (id) => id && state.players[id] && state.players[id].c === clubId && available(state.players[id]);
    const used = new Set();
    const xi = club.lineup.xi.map((id) => (valid(id) && !used.has(id) ? (used.add(id), id) : null));
    // fill holes with the best remaining players for that slot
    xi.forEach((id, i) => {
      if (id) return;
      const slot = FORMATIONS[club.formation][i];
      const cand = squad(state, clubId)
        .filter((p) => available(p) && !used.has(p.id))
        .sort((a, b) => effective(b, slot) - effective(a, slot))[0];
      if (cand) {
        xi[i] = cand.id;
        used.add(cand.id);
      }
    });
    const bench = (club.lineup.bench || []).filter((id) => valid(id) && !used.has(id));
    for (const id of auto.bench) if (bench.length < 9 && !used.has(id) && !bench.includes(id)) bench.push(id);
    return { formation: club.formation, xi, bench };
  }

  // ---------- fixtures & tables ----------
  function roundRobin(ids) {
    const teams = ids.slice();
    if (teams.length % 2) teams.push(null);
    const n = teams.length;
    const rounds = [];
    for (let r = 0; r < n - 1; r++) {
      const round = [];
      for (let i = 0; i < n / 2; i++) {
        const a = teams[i];
        const b = teams[n - 1 - i];
        if (a && b) round.push(r % 2 === 0 ? [a, b] : [b, a]);
      }
      rounds.push(round);
      teams.splice(1, 0, teams.pop());
    }
    const second = rounds.map((round) => round.map(([h, a]) => [a, h]));
    return rounds.concat(second);
  }

  function startSeason(state) {
    state.week = 0;
    state.tables = {};
    state.fixtures = {};
    for (const lg of state.leagues) {
      const ids = shuffle(clubsIn(state, lg.id).map((c) => c.id));
      const rounds = roundRobin(ids);
      const R = rounds.length;
      state.fixtures[lg.id] = rounds.map((matches, r) => ({
        week: 1 + Math.round((r * (SEASON_WEEKS - 1)) / (R - 1)),
        matches: matches.map(([h, a]) => ({ h, a, hg: null, ag: null })),
      }));
      const table = {};
      for (const id of ids) table[id] = { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
      state.tables[lg.id] = table;
    }
    for (const c of Object.values(state.clubs)) c.form = [];
    for (const p of Object.values(state.players)) p.st = emptyStats();
  }

  function sortedTable(state, leagueId) {
    const t = state.tables[leagueId];
    return Object.entries(t)
      .map(([id, r]) => ({ id, ...r, gd: r.gf - r.ga }))
      .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || state.clubs[a.id].name.localeCompare(state.clubs[b.id].name));
  }

  function weekDate(state, week) {
    const d = new Date(Date.UTC(state.seasonYear, 7, 9));
    d.setUTCDate(d.getUTCDate() + 7 * week);
    return d;
  }
  function windowOpen(state) {
    return state.week <= SUMMER_WINDOW_END || (state.week >= WINTER_WINDOW[0] && state.week <= WINTER_WINDOW[1]);
  }
  function fixturesOfWeek(state, week) {
    const out = [];
    for (const lg of state.leagues) {
      for (const round of state.fixtures[lg.id]) {
        if (round.week === week) for (const m of round.matches) out.push({ league: lg.id, m });
      }
    }
    return out;
  }
  function clubFixture(state, clubId, week) {
    return fixturesOfWeek(state, week).find(({ m }) => m.h === clubId || m.a === clubId) || null;
  }
  function clubSchedule(state, clubId) {
    const lg = state.clubs[clubId].league;
    const out = [];
    for (const round of state.fixtures[lg]) {
      for (const m of round.matches) if (m.h === clubId || m.a === clubId) out.push({ week: round.week, m });
    }
    return out;
  }

  // ---------- match simulation ----------
  const T = {
    kickoff: ['שריקת הפתיחה! {h} מול {a} יוצא לדרך.'],
    half: ['שריקה למחצית. {score}.'],
    second: ['המחצית השנייה יוצאת לדרך.'],
    end: ['שריקת הסיום! {score}.'],
    goal: ['שער! {p} מבקיע ל{t}!', 'גוווול! {p} לא מפספס מול השער!', '{p} בועט... ברשת! {t} מבקיעה!', 'איזה שער של {p}! הכדור נכנס לפינה העליונה.', '{p} מנצל בלבול ברחבה ומבקיע!'],
    assist: [' הבישול של {a}.', ' מסירה נהדרת של {a}.', ' {a} עם ההכנה.'],
    save: ['{g} מציל בגדול את הבעיטה של {p}!', 'בעיטה חזקה של {p}, {g} הודף לקרן.', '{p} בועט למסגרת, {g} אוסף בביטחון.'],
    miss: ['{p} בועט מעל השער.', 'החמצה של {p}! הכדור עובר ליד הקורה.', '{p} מנסה מרחוק, רחוק מהמטרה.', 'הזדמנות טובה ל{t}, אבל {p} מחמיץ.'],
    post: ['קורה! הבעיטה של {p} נעצרת במשקוף!'],
    yellow: ['כרטיס צהוב ל{p} אחרי עבירה קשוחה.', '{p} מקבל צהוב.'],
    red: ['כרטיס אדום! {p} נשלח למקלחות.', 'צהוב שני ל{p} - והוא מורחק!'],
    injury: ['{p} נפצע ונזקק לטיפול. נראה רע.'],
    sub: ['חילוף ב{t}: {in} נכנס במקום {out}.'],
    chance: ['{t} לוחצת, {p} מנסה לחדור לרחבה.', 'התקפה מסוכנת של {t}.', '{p} מוביל התקפה מתפרצת!'],
  };
  function fill(tpl, vars) {
    return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
  }

  class MatchSim {
    constructor(state, homeId, awayId, opts = {}) {
      this.state = state;
      this.detail = !!opts.detail;
      this.proId = opts.proId || null;
      this.minute = 0;
      this.stoppage = [0, rint(2, 6)];
      this.events = [];
      this.done = false;
      this.pending = null;
      this.userSide = opts.userSide === undefined ? null : opts.userSide;
      this.sides = [homeId, awayId].map((id, i) => this.makeSide(id, i === 0));
      this.recalc();
      this.log('kickoff', null, {});
    }

    makeSide(clubId, home) {
      const club = this.state.clubs[clubId];
      const lu = lineupFor(this.state, clubId);
      const slots = FORMATIONS[lu.formation];
      const onPitch = lu.xi.map((id, i) => ({ id, slot: slots[i] })).filter((x) => x.id);
      return {
        clubId, home, club, formation: lu.formation, mentality: club.mentality,
        onPitch, bench: lu.bench.slice(), used: new Set(onPitch.map((x) => x.id)),
        subsLeft: 5, goals: 0, shots: 0, sot: 0, xg: 0, poss: 0, yellows: {}, reds: 0,
        rating: {}, played: {}, r: null,
      };
    }

    recalc() {
      for (const s of this.sides) {
        const ps = this.state.players;
        const byGroup = { G: [], D: [], M: [], A: [] };
        for (const x of s.onPitch) byGroup[group(x.slot)].push(effective(ps[x.id], x.slot));
        const avg = (a, fb) => (a.length ? a.reduce((u, v) => u + v, 0) / a.length : fb);
        const g = avg(byGroup.G, 30);
        const d = avg(byGroup.D, 40);
        const m = avg(byGroup.M, 40);
        const a = avg(byGroup.A, avg(byGroup.M, 40) * 0.9);
        const men = MENTALITIES[s.mentality] || MENTALITIES.balanced;
        const numF = s.onPitch.length / 11;
        const homeF = s.home ? 1.03 : 1;
        s.r = {
          att: (0.6 * a + 0.3 * m + 0.1 * d) * men.att * numF * homeF,
          def: (0.55 * d + 0.25 * m + 0.2 * g) * men.def * numF * homeF,
          ctl: (0.7 * m + 0.15 * a + 0.15 * d) * numF * homeF,
          gk: g,
        };
      }
    }

    name(pid) {
      return this.state.players[pid] ? this.state.players[pid].n : '?';
    }

    log(type, sideIdx, vars, extra = {}) {
      const s = sideIdx === null ? null : this.sides[sideIdx];
      const [h, a] = this.sides;
      const base = {
        h: h.club.name, a: a.club.name, t: s ? s.club.name : '',
        score: `${h.club.name} ${h.goals}, ${a.club.name} ${a.goals}`, ...vars,
      };
      let text = null;
      if (this.detail || type === 'goal' || type === 'red') {
        text = fill(pick(T[type]), base);
        if (type === 'goal' && vars.a) text += fill(pick(T.assist), base);
      }
      this.events.push({ min: this.minute, type, side: sideIdx, text, ...extra });
    }

    // Players on the pitch for a side, weighted pick
    pickPlayer(side, weightFn, exclude) {
      const cands = side.onPitch.filter((x) => x.id !== exclude);
      if (!cands.length) return null;
      return weighted(cands, (x) => weightFn(this.state.players[x.id], x.slot)).id;
    }

    step() {
      if (this.done || this.pending) return;
      this.minute++;
      const [H, A] = this.sides;
      if (this.minute === 46) this.log('second', null, {});
      if (this.minute % 5 === 0) this.recalc();

      // fatigue
      for (const s of this.sides) {
        for (const x of s.onPitch) {
          const p = this.state.players[x.id];
          const phy = p.pos === 'GK' ? 70 : p.at[5] || 60;
          p.cond = Math.max(20, p.cond - (0.36 - (phy - 60) * 0.004));
          s.played[x.id] = (s.played[x.id] || 0) + 1;
        }
      }

      // possession
      const ch = Math.pow(H.r.ctl, 3);
      const ca = Math.pow(A.r.ctl, 3);
      const pHome = ch / (ch + ca);
      const atkIdx = rnd() < pHome ? 0 : 1;
      this.sides[atkIdx].poss++;

      // pro player moment
      if (this.proId && this.proMoment(atkIdx)) return;

      this.maybeShot(atkIdx);
      for (let i = 0; i < 2; i++) this.discipline(i);
      if (this.minute >= 55) this.aiManage();
      if (this.minute === 45) this.log('half', null, {});
      if (this.minute >= 90 + this.stoppage[1]) this.finish();
    }

    maybeShot(atkIdx, forced) {
      const att = this.sides[atkIdx];
      const def = this.sides[1 - atkIdx];
      const ratio = clamp(att.r.att / def.r.def, 0.6, 1.55);
      const p = Math.min(0.36, 0.225 * Math.pow(ratio, 2));
      if (!forced && rnd() > p) {
        if (this.detail && rnd() < 0.05) {
          const pid = this.pickPlayer(att, (pl, slot) => (group(slot) === 'A' ? 3 : group(slot) === 'M' ? 2 : 0.3));
          if (pid) this.log('chance', atkIdx, { p: this.name(pid) });
        }
        return;
      }
      const shooter = forced ? forced.shooter : this.pickPlayer(att, (pl, slot) => {
        if (pl.id === this.proId) return 0; // the pro's shots come from his decision moments
        const g = group(slot);
        const w = g === 'A' ? 5 : g === 'M' ? 2 : g === 'D' ? 0.45 : 0;
        return w * Math.pow((pl.pos === 'GK' ? 20 : pl.at[1]) / 60, 2);
      });
      if (!shooter) return;
      const xg = forced ? forced.xg : (0.02 + 0.32 * Math.pow(rnd(), 2.5)) * clamp(Math.pow(ratio, 0.6), 0.7, 1.35);
      const sp = this.state.players[shooter];
      const gkId = (def.onPitch.find((x) => x.slot === 'GK') || def.onPitch[0] || {}).id;
      const gk = gkId ? this.state.players[gkId] : null;
      const gkR = gk ? effective(gk, 'GK') : 30;
      const shootR = sp.pos === 'GK' ? 20 : sp.at[1];
      const goalP = clamp(xg * Math.pow(shootR / 65, 0.7) * Math.pow(70 / gkR, 1.3), 0.005, 0.9);
      att.shots++;
      att.xg += xg;
      if (rnd() < goalP) {
        att.goals++;
        att.sot++;
        let assist = null;
        if (forced && forced.assist !== undefined) assist = forced.assist;
        else if (rnd() < 0.72) {
          assist = this.pickPlayer(att, (pl, slot) => (slot === 'GK' ? 0.05 : (group(slot) === 'D' ? 0.6 : 1.4) * Math.pow(pl.at[2] / 60, 2)), shooter);
        }
        this.bump(att, shooter, 1.1);
        if (assist) this.bump(att, assist, 0.6);
        for (const x of def.onPitch) this.bump(def, x.id, group(x.slot) === 'D' || x.slot === 'GK' ? -0.25 : -0.08);
        this.log('goal', atkIdx, { p: this.name(shooter), a: assist ? this.name(assist) : '' }, { scorer: shooter, assist });
        return 'goal';
      }
      const onTarget = rnd() < 0.4;
      if (onTarget) {
        att.sot++;
        if (gkId) this.bump(def, gkId, 0.18);
        this.log('save', atkIdx, { p: this.name(shooter), g: gkId ? this.name(gkId) : '' });
        return 'save';
      }
      if (rnd() < 0.06) this.log('post', atkIdx, { p: this.name(shooter) });
      else this.log('miss', atkIdx, { p: this.name(shooter) });
      return 'miss';
    }

    bump(side, pid, v) {
      side.rating[pid] = (side.rating[pid] || 0) + v;
    }

    discipline(i) {
      const s = this.sides[i];
      if (rnd() < 0.021) {
        const pid = this.pickPlayer(s, (pl, slot) => (slot === 'GK' ? 0.1 : group(slot) === 'D' ? 2 : group(slot) === 'M' ? 1.5 : 0.8));
        if (!pid) return;
        s.yellows[pid] = (s.yellows[pid] || 0) + 1;
        this.state.players[pid].st.yc++;
        this.bump(s, pid, -0.3);
        if (s.yellows[pid] >= 2) this.sendOff(i, pid);
        else this.log('yellow', i, { p: this.name(pid) }, { player: pid });
      } else if (rnd() < 0.0007) {
        const pid = this.pickPlayer(s, (pl, slot) => (slot === 'GK' ? 0.2 : 1));
        if (pid) this.sendOff(i, pid);
      } else if (rnd() < 0.0009) {
        const pid = this.pickPlayer(s, () => 1);
        if (!pid) return;
        const p = this.state.players[pid];
        p.inj = rint(1, 7);
        this.log('injury', i, { p: this.name(pid) }, { player: pid });
        if (!this.autoSub(i, pid)) {
          const wasGk = (s.onPitch.find((x) => x.id === pid) || {}).slot === 'GK';
          s.onPitch = s.onPitch.filter((x) => x.id !== pid);
          if (wasGk) this.replaceKeeper(i);
          this.recalc();
        }
      }
    }

    sendOff(i, pid) {
      const s = this.sides[i];
      const wasGk = (s.onPitch.find((x) => x.id === pid) || {}).slot === 'GK';
      s.onPitch = s.onPitch.filter((x) => x.id !== pid);
      if (wasGk) this.replaceKeeper(i);
      s.reds++;
      const p = this.state.players[pid];
      p.sus = rint(1, 3);
      p.st.rc++;
      this.bump(s, pid, -1.5);
      this.log('red', i, { p: this.name(pid) }, { player: pid });
      this.recalc();
    }

    // Keeper sent off or injured with no subs left: bring on the reserve keeper for an outfield
    // player if possible, otherwise an outfield player goes in goal.
    replaceKeeper(i) {
      const s = this.sides[i];
      if (!s.onPitch.length) return;
      const benchGk = s.bench.find((id) => this.state.players[id] && this.state.players[id].pos === 'GK');
      const victim = s.onPitch.slice().sort((a, b) => this.state.players[a.id].ovr - this.state.players[b.id].ovr)[0];
      if (benchGk && s.subsLeft > 0) {
        this.substitute(i, victim.id, benchGk);
        s.onPitch.find((x) => x.id === benchGk).slot = 'GK';
      } else {
        victim.slot = 'GK';
      }
    }

    substitute(i, outId, inId) {
      const s = this.sides[i];
      if (s.subsLeft <= 0) return false;
      const idx = s.onPitch.findIndex((x) => x.id === outId);
      if (idx < 0 || !s.bench.includes(inId)) return false;
      s.onPitch[idx] = { id: inId, slot: s.onPitch[idx].slot };
      s.bench = s.bench.filter((id) => id !== inId);
      s.used.add(inId);
      s.subsLeft--;
      this.log('sub', i, { in: this.name(inId), out: this.name(outId) }, { in: inId, out: outId });
      this.recalc();
      return true;
    }

    autoSub(i, outId) {
      const s = this.sides[i];
      const x = s.onPitch.find((y) => y.id === outId);
      if (!x || s.subsLeft <= 0) return false;
      const cands = s.bench.map((id) => this.state.players[id]).filter((p) => p && available(p) && p.id !== this.proId);
      const best = cands.sort((a, b) => effective(b, x.slot) - effective(a, x.slot))[0];
      if (!best) return false;
      return this.substitute(i, outId, best.id);
    }

    aiManage() {
      this.sides.forEach((s, i) => {
        if (this.userSide === i) return;
        const diff = s.goals - this.sides[1 - i].goals;
        if (this.minute === 65 || this.minute === 75) {
          s.mentality = diff < 0 ? 'attacking' : diff > 0 ? 'defensive' : s.club.mentality;
          this.recalc();
        }
        if ([60, 70, 80].includes(this.minute) && s.subsLeft > 2) {
          const tired = s.onPitch
            .filter((x) => x.slot !== 'GK' && x.id !== this.proId)
            .sort((a, b) => this.state.players[a.id].cond - this.state.players[b.id].cond)[0];
          if (tired && this.state.players[tired.id].cond < 75) this.autoSub(i, tired.id);
        }
      });
      // bench Be a Pro player comes on
      if (this.proId && this.proSubMinute === this.minute) {
        const i = this.proSide;
        const s = this.sides[i];
        const pro = this.state.players[this.proId];
        const score = (x) => (group(x.slot) === group(pro.pos) ? 0 : 1000) + this.state.players[x.id].cond;
        const out = s.onPitch.filter((x) => x.slot !== 'GK').sort((a, b) => score(a) - score(b))[0];
        if (out && s.subsLeft > 0 && s.bench.includes(this.proId)) this.substitute(i, out.id, this.proId);
      }
    }

    // ----- Be a Pro moments -----
    proMoment(atkIdx) {
      const i = this.proSide;
      const s = this.sides[i];
      const x = s.onPitch.find((y) => y.id === this.proId);
      if (!x) return false;
      const g = group(x.slot);
      const attacking = atkIdx === i;
      const chance = attacking ? { A: 0.06, M: 0.045, D: 0.018, G: 0 }[g] : { A: 0.003, M: 0.022, D: 0.045, G: 0.03 }[g];
      if (rnd() > chance) return false;
      const moment = buildMoment(this, x.slot, attacking);
      if (!moment) return false;
      this.pending = moment;
      return true;
    }

    resolve(optionIdx) {
      const m = this.pending;
      if (!m) return null;
      const opt = m.options[optionIdx];
      this.pending = null;
      const i = this.proSide;
      const s = this.sides[i];
      const success = rnd() < opt.p;
      const res = opt.resolve(this, success);
      this.bump(s, this.proId, success ? opt.good || 0.25 : opt.bad || -0.15);
      const text = (success ? opt.okText : opt.failText) || '';
      this.events.push({ min: this.minute, type: 'pro', side: i, text: `⭐ ${text}`, success, result: res });
      this.proLog.push({ min: this.minute, title: m.title, choice: opt.label, success, result: res });
      if (this.minute >= 90 + this.stoppage[1]) this.finish();
      return { success, result: res, text };
    }

    finish() {
      if (this.done) return;
      this.done = true;
      this.log('end', null, {});
    }

    runToEnd() {
      while (!this.done) {
        if (this.pending) this.resolve(autoChoice(this.pending));
        this.step();
      }
    }

    // Final ratings for everyone who played
    ratings() {
      const out = {};
      this.sides.forEach((s, i) => {
        const other = this.sides[1 - i];
        const res = s.goals > other.goals ? 0.35 : s.goals < other.goals ? -0.3 : 0;
        for (const pid of Object.keys(s.played)) {
          const p = this.state.players[pid];
          let r = 6.3 + res + (s.rating[pid] || 0) + gauss() * 0.25;
          if (other.goals === 0 && (p.pos === 'GK' || group(p.pos) === 'D') && s.played[pid] >= 60) r += 0.5;
          if (s.played[pid] < 20) r = 6 + (r - 6) * 0.5;
          out[pid] = Math.round(clamp(r, 3, 10) * 10) / 10;
        }
      });
      return out;
    }
  }

  function autoChoice(moment) {
    let best = 0;
    moment.options.forEach((o, i) => {
      if (o.p * (o.value || 1) > moment.options[best].p * (moment.options[best].value || 1)) best = i;
    });
    return best;
  }

  // ---------- Be a Pro moment catalogue ----------
  function buildMoment(sim, slot, attacking) {
    const st = sim.state;
    const i = sim.proSide;
    const me = st.players[sim.proId];
    const own = sim.sides[i];
    const opp = sim.sides[1 - i];
    const oppDef = opp.r.def;
    const oppAtt = opp.r.att;
    const g = group(slot);
    const conf = (me.morale - 50) / 500; // -0.1 .. +0.1
    const chanceP = (attr, base, spread) => clamp(base + (attr - oppDef) / (spread * 1.4) + conf, 0.05, 0.88);
    const mate = () => sim.pickPlayer(own, (pl, sl) => (group(sl) === 'A' ? 3 : group(sl) === 'M' ? 2 : 0.4), sim.proId);
    const shoot = (xg) => (s, ok) => {
      if (!ok) {
        own.shots++;
        own.xg += xg;
        return 'miss';
      }
      return s.maybeShot(i, { shooter: sim.proId, xg: Math.min(0.42, xg * 1.25), assist: null }) || 'miss';
    };
    const passTo = (xg) => (s, ok) => {
      if (!ok) return 'lost';
      const target = mate();
      if (!target) return 'lost';
      return s.maybeShot(i, { shooter: target, xg, assist: sim.proId }) || 'miss';
    };
    const defend = (bad) => (s, ok) => {
      if (ok) return 'won';
      const shooter = s.pickPlayer(opp, (pl, sl) => (group(sl) === 'A' ? 3 : 1));
      if (!shooter) return 'lost';
      return s.maybeShot(1 - i, { shooter, xg: bad, assist: null }) || 'miss';
    };

    const [pac, sho, pas, dri, def, phy] = me.at;
    if (g === 'G') {
      return {
        title: 'חלוץ יריב פורץ לבד מולך!',
        desc: `${opp.club.name} בהתקפה מתפרצת, החלוץ חמק מההגנה ורץ לעברך.`,
        options: [
          { label: 'לצאת מהשער ולסגור זווית', p: chanceP((me.at[0] + me.at[5]) / 2, 0.5, 60), resolve: defend(0.55), okText: 'יצאת בזמן ולקחת את הכדור מהרגליים שלו!', failText: 'יצאת מאוחר מדי...', good: 0.6 },
          { label: 'להישאר על הקו ולחכות לבעיטה', p: chanceP(me.at[3], 0.45, 60), resolve: defend(0.4), okText: 'הצלה רפלקסיבית מדהימה!', failText: 'הבעיטה הייתה חזקה מדי.', good: 0.7 },
        ],
      };
    }
    if (!attacking) {
      const moments = [
        {
          title: 'החלוץ היריב רץ לעברך עם הכדור',
          desc: `${opp.club.name} תוקפת, השחקן היריב מנסה לעבור אותך בדרך לרחבה.`,
          options: [
            { label: 'תיקול גלישה', p: clamp(0.35 + (def - oppAtt) / 45 + conf, 0.08, 0.9), resolve: defend(0.35), okText: 'תיקול מושלם! לקחת את הכדור נקי.', failText: 'פספסת את התיקול והוא עבר אותך!', good: 0.5, bad: -0.35 },
            { label: 'לעמוד מולו ולחסום', p: clamp(0.5 + (def - oppAtt) / 50 + conf, 0.1, 0.92), resolve: defend(0.18), okText: 'חסמת אותו והכרחת אותו לאחור.', failText: 'הוא מצא זווית לבעיטה.', good: 0.3 },
            { label: 'להוביל אותו לקו הצד', p: clamp(0.62 + (pac - oppAtt) / 55 + conf, 0.15, 0.95), resolve: defend(0.1), okText: 'דחקת אותו החוצה, הכדור יצא לחוץ.', failText: 'הוא הגביה לרחבה.', good: 0.2 },
          ],
        },
        {
          title: 'הגבהה לרחבה שלך',
          desc: 'כדור גבוה נשלח לרחבה, חלוץ יריב ממתין מאחוריך.',
          options: [
            { label: 'לקפוץ ולהרחיק בראש', p: clamp(0.5 + (phy - oppAtt) / 45 + conf, 0.1, 0.93), resolve: defend(0.3), okText: 'ניצחת בדו-קרב האווירי והרחקת!', failText: 'החלוץ היה גבוה יותר.', good: 0.35 },
            { label: 'לעצור בחזה ולצאת עם הכדור', p: clamp(0.35 + (dri - oppAtt) / 45 + conf, 0.08, 0.85), resolve: (s, ok) => (ok ? 'won' : defend(0.4)(s, false)), okText: 'איזו שליטה! יצאת מהלחץ בסטייל.', failText: 'איבדת את הכדור ברחבה!', good: 0.55, bad: -0.4 },
          ],
        },
      ];
      return pick(moments);
    }

    if (g === 'A' || (g === 'M' && rnd() < 0.5)) {
      const moments = [
        {
          title: 'אתה ברחבה עם הכדור!',
          desc: `קיבלת כדור בגובה 14 מטר, בלם של ${opp.club.name} מתקרב.`,
          options: [
            { label: 'בעיטה מיידית לפינה', p: chanceP(sho, 0.42, 45), resolve: shoot(0.16), value: 1.3, okText: 'בעיטה מדויקת למסגרת!', failText: 'הבעיטה עפה מעל.', good: 0.2, bad: -0.15 },
            { label: 'לקחת נגיעה ולסדר את הבעיטה', p: chanceP((sho + dri) / 2, 0.32, 45), resolve: shoot(0.24), value: 1.5, okText: 'סידרת את עצמך מצוין ובעטת!', failText: 'הבלם חסם את הבעיטה.', good: 0.25, bad: -0.2 },
            { label: 'מסירה לחבר פנוי', p: chanceP(pas, 0.6, 50), resolve: passTo(0.28), value: 0.9, okText: 'מסירה חכמה לחבר!', failText: 'המסירה נחתכה.', good: 0.2, bad: -0.15 },
          ],
        },
        {
          title: 'אחד על אחד עם השוער!',
          desc: 'פרצת לבד, רק השוער לפניך.',
          options: [
            { label: 'לבעוט חזק', p: chanceP(sho, 0.55, 45), resolve: shoot(0.3), value: 1.4, okText: 'בעיטה חזקה...', failText: 'השוער סגר את הזווית.', good: 0.3, bad: -0.3 },
            { label: 'לכדרר את השוער', p: chanceP(dri, 0.45, 45), resolve: (s, ok) => (ok ? shoot(0.32)(s, true) : 'lost'), value: 1.5, okText: 'עברת את השוער!', failText: 'השוער לקח לך את הכדור מהרגליים.', good: 0.4, bad: -0.35 },
            { label: 'צ\'יפ מעל השוער', p: chanceP((sho + dri) / 2, 0.38, 40), resolve: shoot(0.33), value: 1.6, okText: 'צ\'יפ עדין...', failText: 'הצ\'יפ היה חלש מדי.', good: 0.45, bad: -0.3 },
          ],
        },
        {
          title: 'מתפרצת! אתה רץ עם הכדור',
          desc: 'קיבלת כדור בחצי שלך ויש שטח פתוח לפניך.',
          options: [
            { label: 'לרוץ לבד לשער', p: chanceP((pac + dri) / 2, 0.4, 45), resolve: (s, ok) => (ok ? shoot(0.22)(s, true) : 'lost'), value: 1.3, okText: 'השארת את כולם מאחור!', failText: 'המגן השיג אותך.', good: 0.3, bad: -0.15 },
            { label: 'מסירת עומק לחלוץ', p: chanceP(pas, 0.5, 45), resolve: passTo(0.3), value: 1.1, okText: 'מסירת עומק מושלמת!', failText: 'המסירה הייתה ארוכה מדי.', good: 0.3, bad: -0.1 },
            { label: 'להאט ולחכות לחברים', p: 0.85, resolve: (s, ok) => (ok ? 'kept' : 'lost'), value: 0.2, okText: 'שמרת על הכדור.', failText: 'איבדת את הכדור.', good: 0.05 },
          ],
        },
      ];
      return pick(moments);
    }
    // midfield / defender in possession
    return pick([
      {
        title: 'יש לך את הכדור במרכז המגרש',
        desc: 'לחץ של קשר יריב, חלוץ שלך מסמן לעומק.',
        options: [
          { label: 'מסירת עומק מסוכנת', p: chanceP(pas, 0.38, 45), resolve: passTo(0.25), value: 1.2, okText: 'מסירה פותחת הגנה!', failText: 'המסירה נחתכה.', good: 0.3, bad: -0.2 },
          { label: 'בעיטה מרחוק', p: chanceP(sho, 0.35, 45), resolve: shoot(0.05), value: 0.8, okText: 'בעיטה חזקה מ-25 מטר!', failText: 'בעיטה חלשה לידי השוער.', good: 0.2, bad: -0.1 },
          { label: 'מסירה בטוחה הצידה', p: chanceP(pas, 0.8, 70), resolve: (s, ok) => (ok ? 'kept' : 'lost'), value: 0.3, okText: 'שמרת על החזקה.', failText: 'מסירה רעה, איבדת כדור.', good: 0.08, bad: -0.25 },
        ],
      },
      {
        title: 'כדור חופשי ב-30 מטר',
        desc: 'השופט שרק לעבירה ואתה לוקח את הבעיטה.',
        options: [
          { label: 'לבעוט ישר לשער', p: chanceP(sho, 0.3, 40), resolve: shoot(0.08), value: 1, okText: 'בעיטה מסובבת מעל החומה...', failText: 'הכדור פגע בחומה.', good: 0.25, bad: -0.05 },
          { label: 'להגביה לרחבה', p: chanceP(pas, 0.5, 45), resolve: passTo(0.14), value: 1, okText: 'הגבהה מדויקת לראש!', failText: 'השוער אסף את ההגבהה.', good: 0.2, bad: -0.05 },
        ],
      },
    ]);
  }

  // Applies a finished match to tables, player stats, morale and club form.
  function applyResult(state, league, fixture, sim) {
    const [H, A] = sim.sides;
    fixture.hg = H.goals;
    fixture.ag = A.goals;
    const ratings = sim.ratings();
    fixture.rep = {
      events: sim.events.filter((e) => e.type === 'goal' || e.type === 'red').map((e) => ({ min: e.min, type: e.type, side: e.side, p: e.scorer || e.player })),
    };
    const t = state.tables[league];
    const rec = (id, gf, ga) => {
      const r = t[id];
      r.p++;
      r.gf += gf;
      r.ga += ga;
      if (gf > ga) {
        r.w++;
        r.pts += 3;
      } else if (gf === ga) {
        r.d++;
        r.pts += 1;
      } else r.l++;
    };
    rec(H.clubId, H.goals, A.goals);
    rec(A.clubId, A.goals, H.goals);
    sim.sides.forEach((s, i) => {
      const other = sim.sides[1 - i];
      const res = s.goals > other.goals ? 'W' : s.goals < other.goals ? 'L' : 'D';
      s.club.form.push(res);
      if (s.club.form.length > 6) s.club.form.shift();
      for (const [pid, mins] of Object.entries(s.played)) {
        const p = state.players[pid];
        p.st.app++;
        p.st.min += mins;
        p.st.rt += ratings[pid];
        if (other.goals === 0 && (p.pos === 'GK' || group(p.pos) === 'D') && mins >= 60) p.st.cs++;
        p.morale = clamp(p.morale + (res === 'W' ? 3 : res === 'L' ? -3 : 0) + (ratings[pid] - 6.5) * 2, 10, 100);
      }
      // players who did not play lose a little morale and suspensions tick
      for (const p of squad(state, s.clubId)) {
        if (!s.played[p.id] && p.morale > 40) p.morale -= 0.5;
        if (p.sus > 0 && !s.played[p.id]) p.sus--;
      }
    });
    for (const e of sim.events) {
      if (e.type === 'goal') {
        state.players[e.scorer].st.gl++;
        if (e.assist) state.players[e.assist].st.as++;
      }
    }
    // five yellows = one-match ban
    for (const s of sim.sides) {
      for (const pid of Object.keys(s.yellows)) {
        const p = state.players[pid];
        if (p.st.yc > 0 && p.st.yc % 5 === 0 && s.yellows[pid] === 1) p.sus = Math.max(p.sus, 1);
      }
    }
    return ratings;
  }

  // ---------- weekly loop ----------
  // Plays every match of the current week except `skip` (the user's match, already simulated by the UI).
  function playWeek(state, userSim) {
    const week = state.week;
    const results = [];
    for (const { league, m } of fixturesOfWeek(state, week)) {
      if (m.hg !== null) continue;
      let sim;
      if (userSim && userSim.sides[0].clubId === m.h && userSim.sides[1].clubId === m.a) sim = userSim;
      else {
        sim = new MatchSim(state, m.h, m.a);
        sim.runToEnd();
      }
      const ratings = applyResult(state, league, m, sim);
      results.push({ league, m, sim, ratings });
    }
    return results;
  }

  function afterWeek(state) {
    // recovery, injuries, finances
    for (const p of Object.values(state.players)) {
      p.cond = Math.min(100, p.cond + 28);
      if (p.inj > 0) p.inj--;
    }
    for (const c of Object.values(state.clubs)) {
      const wages = squad(state, c.id).reduce((s, p) => s + p.w, 0);
      c.balance += c.income - wages;
      c.lastWages = wages;
    }
    if (windowOpen(state)) {
      aiTransfers(state);
      if (state.mode === 'manager') aiBidsForUser(state);
    }
    if (state.mode === 'pro') proWeekly(state);
    if (state.mode === 'manager') boardCheck(state);
    state.week++;
    if (state.week > SEASON_WEEKS) return endSeason(state);
    return null;
  }

  function message(state, title, body, extra = {}) {
    state.inbox.unshift({ id: Date.now() + Math.floor(rnd() * 1e6), week: state.week, season: state.seasonYear, title, body, read: false, ...extra });
    if (state.inbox.length > 120) state.inbox.length = 120;
  }

  // ---------- transfers ----------
  function askingPrice(state, p) {
    const sq = squad(state, p.c).sort((a, b) => b.ovr - a.ovr);
    const rank = sq.indexOf(p);
    let f = 1.15;
    if (rank < 3) f += 0.5;
    else if (rank < 8) f += 0.25;
    if (p.listed) f = 0.85;
    if (p.ctr <= state.seasonYear + 1) f *= 0.75;
    return Math.round((p.v * f) / 10000) * 10000;
  }

  function transfer(state, p, toClubId, fee) {
    const from = state.clubs[p.c];
    const to = state.clubs[toClubId];
    from.balance += fee;
    to.balance -= fee;
    const newWage = Math.max(Math.round(p.w * 1.15), Math.round(wageFor(p.ovr) * 0.8));
    state.transfersLog.unshift({ season: state.seasonYear, week: state.week, pid: p.id, name: p.n, from: from.id, to: to.id, fee });
    if (state.transfersLog.length > 300) state.transfersLog.length = 300;
    p.c = toClubId;
    p.w = newWage;
    p.ctr = state.seasonYear + rint(2, 5);
    p.listed = false;
    p.morale = 80;
    if (from.lineup) from.lineup = null;
    if (to.lineup) to.lineup = null;
    if (!state.user || from.id !== state.user.clubId) ensureSquadSize(state, from.id);
  }

  // User makes an offer for a player. Returns { status, ask?, reason? }.
  function makeOffer(state, pid, fee) {
    const p = state.players[pid];
    const buyer = state.clubs[state.user.clubId];
    if (!windowOpen(state)) return { status: 'closed', reason: 'חלון ההעברות סגור.' };
    if (p.c === buyer.id) return { status: 'invalid', reason: 'השחקן כבר בקבוצה שלך.' };
    if (fee > buyer.balance) return { status: 'invalid', reason: 'אין מספיק תקציב.' };
    const ask = askingPrice(state, p);
    if (fee < ask * 0.85) return { status: 'rejected', ask, reason: `${state.clubs[p.c].name} דחתה את ההצעה. הם מבקשים בערך ${money(ask)}.` };
    if (fee < ask) return { status: 'counter', ask, reason: `${state.clubs[p.c].name} מוכנה למכור ב-${money(ask)}.` };
    if (buyer.rep < p.ovr - 12 && p.ovr > 70) return { status: 'refused', reason: `${p.n} לא מעוניין לעבור לקבוצה ברמה שלכם.` };
    if (squad(state, buyer.id).length >= 34) return { status: 'invalid', reason: 'הסגל מלא (34 שחקנים).' };
    transfer(state, p, buyer.id, fee);
    return { status: 'done', reason: `${p.n} חתם בקבוצה! עמלת העברה: ${money(fee)}.` };
  }

  function acceptBid(state, msgId) {
    const msg = state.inbox.find((m) => m.id === msgId);
    if (!msg || !msg.bid || msg.done) return null;
    const p = state.players[msg.bid.pid];
    msg.done = 'accepted';
    if (!p || p.c !== state.user.clubId) return 'השחקן כבר לא בקבוצה.';
    transfer(state, p, msg.bid.club, msg.bid.fee);
    return `${p.n} נמכר ${pre('ל', state.clubs[msg.bid.club].name)} תמורת ${money(msg.bid.fee)}.`;
  }
  function rejectBid(state, msgId) {
    const msg = state.inbox.find((m) => m.id === msgId);
    if (msg) msg.done = 'rejected';
  }

  function releasePlayer(state, pid) {
    const p = state.players[pid];
    const club = state.clubs[p.c];
    const yearsLeft = Math.max(0, p.ctr - state.seasonYear);
    const cost = Math.round(p.w * 52 * yearsLeft * 0.5);
    if (club.balance < cost) return { ok: false, reason: `שחרור יעלה ${money(cost)} ואין מספיק תקציב.` };
    club.balance -= cost;
    delete state.players[pid];
    club.lineup = null;
    return { ok: true, reason: `${p.n} שוחרר. עלות הפיצוי: ${money(cost)}.` };
  }

  function aiTransfers(state) {
    const clubs = shuffle(Object.values(state.clubs).filter((c) => !state.user || c.id !== state.user.clubId)).slice(0, 12);
    for (const buyer of clubs) {
      if (rnd() < 0.4) continue;
      const sq = squad(state, buyer.id);
      if (sq.length >= 30) continue;
      // weakest group relative to squad average
      const byG = { G: [], D: [], M: [], A: [] };
      for (const p of sq) byG[group(p.pos)].push(p.ovr);
      const top = (arr, n) => arr.sort((a, b) => b - a).slice(0, n);
      const need = { G: 1, D: 4, M: 4, A: 2 };
      let weakest = 'M';
      let worst = 999;
      for (const g of Object.keys(need)) {
        const t = top(byG[g], need[g]);
        const avg = t.length < need[g] ? 0 : t.reduce((s, v) => s + v, 0) / t.length;
        if (avg < worst) {
          worst = avg;
          weakest = g;
        }
      }
      const target = Math.max(worst, buyer.rep - 2);
      const budget = buyer.balance * 0.6;
      const cands = [];
      for (const p of Object.values(state.players)) {
        if (p.c === buyer.id || group(p.pos) !== weakest || p.ovr < target || p.ovr > buyer.rep + 5) continue;
        if (state.pro && p.id === state.pro.pid) continue;
        if (state.user && p.c === state.user.clubId) continue;
        const seller = state.clubs[p.c];
        if (seller.rep > buyer.rep + 2) continue;
        if (p.v > budget || p.age > 31) continue;
        cands.push(p);
        if (cands.length > 60) break;
      }
      if (!cands.length) continue;
      const p = pick(cands);
      const fee = askingPrice(state, p);
      if (fee > budget) continue;
      const fromName = state.clubs[p.c].name;
      transfer(state, p, buyer.id, fee);
      if (fee >= 15000000 || (state.user && (buyer.league === state.clubs[state.user.clubId].league))) {
        state.news.unshift({ season: state.seasonYear, week: state.week, text: `${p.n} עובר ${pre('מ', fromName)} ${pre('ל', buyer.name)} תמורת ${money(fee)}` });
        if (state.news.length > 60) state.news.length = 60;
      }
    }
  }

  function aiBidsForUser(state) {
    const sq = squad(state, state.user.clubId);
    if (sq.length <= 18) return;
    const listed = sq.filter((p) => p.listed);
    const bidOnListed = listed.length && rnd() < 0.6;
    if (!bidOnListed && rnd() > 0.25) return;
    const p = bidOnListed ? pick(listed) : weighted(sq, (x) => x.v);
    const buyers = Object.values(state.clubs).filter((c) => c.id !== p.c && c.rep >= p.ovr - 6 && c.balance > p.v * 0.9);
    if (!buyers.length) return;
    const buyer = pick(buyers);
    const fee = Math.round((p.v * (p.listed ? 0.75 + rnd() * 0.3 : 0.9 + rnd() * 0.5)) / 10000) * 10000;
    message(state, `הצעה עבור ${p.n}`, `${buyer.name} מציעה ${money(fee)} עבור ${p.n} (שווי מוערך ${money(p.v)}).`, {
      bid: { pid: p.id, club: buyer.id, fee }, kind: 'bid',
    });
  }

  function ensureSquadSize(state, clubId) {
    const club = state.clubs[clubId];
    const lg = state.leagues.find((l) => l.id === club.league);
    const sq = squad(state, clubId);
    const need = { G: 3, D: 7, M: 7, A: 4 };
    const counts = { G: 0, D: 0, M: 0, A: 0 };
    for (const p of sq) counts[group(p.pos)]++;
    const posFor = { G: ['GK'], D: ['CB', 'CB', 'LB', 'RB'], M: ['CM', 'CDM', 'CAM', 'LM', 'RM'], A: ['ST', 'LW', 'RW'] };
    let total = sq.length;
    const add = (g) => {
      const age = rint(19, 30);
      const ovr = clamp(Math.round(club.rep - 5 + gauss() * 3), 45, 85);
      createPlayer(state, clubId, pick(posFor[g]), age, ovr, Math.max(ovr, ovr + rint(0, 6)), lg.country);
      counts[g]++;
      total++;
    };
    for (const g of Object.keys(need)) while (counts[g] < need[g]) add(g);
    while (total < 22) add(pick(['D', 'M', 'M', 'A']));
  }

  function createPlayer(state, clubId, pos, age, ovr, pot, country, name) {
    const nm = name ? { name, nat: 'Israel' } : randomName(state, country);
    const bias = {
      GK: null, CB: [-6, -25, -8, -12, 8, 6], LB: [4, -18, -3, -2, 2, 0], RB: [4, -18, -3, -2, 2, 0],
      CDM: [-6, -12, 0, -4, 4, 6], CM: [-3, -4, 4, 1, -6, 0], CAM: [0, 2, 5, 6, -25, -6],
      LM: [6, -2, 1, 4, -18, -4], RM: [6, -2, 1, 4, -18, -4], LW: [8, 0, 0, 6, -30, -6], RW: [8, 0, 0, 6, -30, -6],
      ST: [4, 6, -6, 1, -35, 4],
    }[pos];
    const at = bias ? bias.map((b) => clamp(ovr + b + rint(-4, 4), 20, 95)) : [0, 0, 0, 0, 0, 0].map((_, i) => clamp(i === 4 ? ovr - 25 : ovr + rint(-4, 4), 20, 95));
    const id = state.nextPlayerId++;
    const p = {
      id, n: nm.name, fn: nm.name, c: clubId, pos, alt: [], age, ovr, pot, at,
      v: valueFor(ovr, age, pot), w: wageFor(ovr), nat: nm.nat, ft: rnd() < 0.25 ? 'L' : 'R',
      no: rint(2, 45), ctr: state.seasonYear + rint(1, 4), cond: 100, morale: 70, inj: 0, sus: 0, listed: false,
      st: emptyStats(), gen: 1,
    };
    state.players[id] = p;
    return p;
  }

  // ---------- board ----------
  function expectedPosition(state, clubId) {
    const lg = state.clubs[clubId].league;
    const ranked = clubsIn(state, lg).sort((a, b) => b.rep - a.rep);
    return ranked.findIndex((c) => c.id === clubId) + 1;
  }
  function boardCheck(state) {
    const u = state.user;
    const lg = state.clubs[u.clubId].league;
    const table = sortedTable(state, lg);
    const pos = table.findIndex((r) => r.id === u.clubId) + 1;
    const exp = u.expected;
    const n = table.length;
    if (state.week === 23 || state.week === 35) {
      if (pos > exp + Math.max(4, n / 4)) {
        u.warnings = (u.warnings || 0) + 1;
        message(state, 'הנהלה: אנחנו מודאגים', `הקבוצה במקום ${pos}, והציפייה הייתה מקום ${exp} בערך. צריך שיפור מיידי.`, { kind: 'board' });
      } else if (pos <= exp) {
        message(state, 'הנהלה: עבודה טובה', `הקבוצה במקום ${pos} - מעל הציפיות (מקום ${exp}). המשך כך!`, { kind: 'board' });
      }
    }
  }

  // ---------- development ----------
  function developPlayer(p, minutesShare) {
    const oldOvr = p.ovr;
    let delta;
    if (p.age <= 21) delta = Math.round((p.pot - p.ovr) * (0.18 + 0.2 * minutesShare) + gauss() * 1.2);
    else if (p.age <= 24) delta = Math.round((p.pot - p.ovr) * (0.12 + 0.18 * minutesShare) + gauss());
    else if (p.age <= 28) delta = Math.round(gauss() * 1.1 + (p.pot > p.ovr ? 0.6 : 0));
    else if (p.age <= 30) delta = Math.round(-0.5 + gauss());
    else if (p.age <= 32) delta = Math.round(-1.8 + gauss());
    else delta = Math.round(-3 + gauss() * 1.2);
    p.ovr = clamp(p.ovr + delta, 35, 95);
    if (p.ovr > p.pot) p.pot = p.ovr;
    const d = p.ovr - oldOvr;
    if (d) p.at = p.at.map((v, i) => (p.pos === 'GK' && i === 4 ? v : clamp(v + d + rint(-1, 1), 15, 99)));
    p.age++;
    p.v = valueFor(p.ovr, p.age, p.pot);
    return d;
  }

  function endSeason(state) {
    const summary = { season: state.seasonYear, champions: {}, promoted: {}, relegated: {}, topScorers: {} };
    // final tables and promotion/relegation
    const moves = [];
    for (const country of state.countries) {
      const l1 = state.leagues.find((l) => l.country === country.id && l.tier === 1);
      const l2 = state.leagues.find((l) => l.country === country.id && l.tier === 2);
      const t1 = sortedTable(state, l1.id);
      const t2 = sortedTable(state, l2.id);
      summary.champions[l1.id] = t1[0].id;
      summary.champions[l2.id] = t2[0].id;
      const down = t1.slice(-l1.down).map((r) => r.id);
      const up = t2.slice(0, l2.up).map((r) => r.id);
      summary.relegated[l1.id] = down;
      summary.promoted[l2.id] = up;
      for (const id of down) moves.push([id, l2.id]);
      for (const id of up) moves.push([id, l1.id]);
      // prize money
      const pay = (table, lg) => table.forEach((r, i) => {
        state.clubs[r.id].balance += Math.round(((table.length - i) / table.length) * lg.rep * 250000);
      });
      pay(t1, l1);
      pay(t2, l2);
    }
    for (const lg of state.leagues) {
      const scorers = Object.values(state.players)
        .filter((p) => state.clubs[p.c] && state.clubs[p.c].league === lg.id && p.st.gl > 0)
        .sort((a, b) => b.st.gl - a.st.gl)[0];
      if (scorers) summary.topScorers[lg.id] = { pid: scorers.id, name: scorers.n, goals: scorers.st.gl };
    }

    // user outcome
    let fired = false;
    if (state.mode === 'manager') {
      const u = state.user;
      const lg = state.clubs[u.clubId].league;
      const table = sortedTable(state, lg);
      const pos = table.findIndex((r) => r.id === u.clubId) + 1;
      const league = state.leagues.find((l) => l.id === lg);
      const relegated = (summary.relegated[lg] || []).includes(u.clubId);
      const promoted = (summary.promoted[lg] || []).includes(u.clubId);
      summary.user = { club: u.clubId, league: lg, pos, expected: u.expected, relegated, promoted };
      u.career.push({ season: state.seasonYear, club: u.clubId, league: lg, pos });
      const badly = pos > u.expected + Math.max(5, table.length / 3.5) || (relegated && u.expected < table.length - league.down - 1);
      if (badly) {
        fired = true;
        summary.user.fired = true;
      }
    }
    if (state.mode === 'pro') proSeasonEnd(state, summary);

    for (const [id, lg] of moves) state.clubs[id].league = lg;

    // development, aging, retirement, youth
    const minutesByClub = {};
    for (const p of Object.values(state.players)) {
      const lgGames = (state.fixtures[state.clubs[p.c].league] || []).length || 34;
      minutesByClub[p.id] = clamp(p.st.min / (lgGames * 90), 0, 1);
    }
    const retired = [];
    for (const p of Object.values(state.players)) {
      if (state.pro && p.id === state.pro.pid) {
        p.age++;
        continue;
      }
      developPlayer(p, minutesByClub[p.id] || 0);
      const retireP = p.age >= 38 ? 1 : p.age >= 36 ? 0.55 : p.age >= 34 ? 0.25 : p.age >= 33 && p.ovr < 65 ? 0.15 : 0;
      if (rnd() < retireP) retired.push(p.id);
    }
    for (const id of retired) delete state.players[id];
    for (const c of Object.values(state.clubs)) {
      const lg = state.leagues.find((l) => l.id === c.league);
      const youth = rint(1, 3);
      for (let i = 0; i < youth; i++) {
        const pos = pick(['GK', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST', 'ST']);
        const ovr = clamp(Math.round(c.rep - 20 + gauss() * 4), 40, 70);
        const pot = clamp(Math.round(c.rep + gauss() * 6 + (rnd() < 0.05 ? 10 : 0)), ovr + 5, 94);
        createPlayer(state, c.id, pos, rint(16, 17), ovr, pot, lg.country);
      }
      ensureSquadSize(state, c.id);
      const top = squad(state, c.id).sort((a, b) => b.ovr - a.ovr).slice(0, 16);
      c.rep = Math.round(top.reduce((s, p) => s + p.ovr, 0) / Math.max(1, top.length));
      c.income = Math.round(squad(state, c.id).reduce((s, p) => s + p.w, 0) * 1.02 * (lg.tier === 1 ? 1 : 0.85));
      c.lineup = null;
      c.formation = bestFormation(state, c.id);
      c.mentality = c.mentality || 'balanced';
    }
    for (const p of Object.values(state.players)) {
      p.w = Math.max(p.w, Math.round(wageFor(p.ovr) * 0.6));
      p.cond = 100;
      p.inj = 0;
      p.sus = 0;
    }

    state.history.unshift(summary);
    state.seasonYear++;
    startSeason(state);
    if (state.mode === 'manager' && !fired) {
      const u = state.user;
      u.expected = expectedPosition(state, u.clubId);
      const lg = state.leagues.find((l) => l.id === state.clubs[u.clubId].league);
      message(state, `עונת ${seasonLabel(state.seasonYear)} מתחילה`, `ההנהלה מצפה לסיים בסביבות מקום ${u.expected} ${pre('ב', lg.name)}.`, { kind: 'board' });
    }
    return summary;
  }

  // Manager fired: offers from clubs of a similar or lower level.
  function jobOffers(state) {
    const cur = state.clubs[state.user.clubId];
    return shuffle(Object.values(state.clubs).filter((c) => c.id !== cur.id && c.rep <= cur.rep + 1 && c.rep >= cur.rep - 10)).slice(0, 4);
  }
  function takeJob(state, clubId) {
    state.user.clubId = clubId;
    state.user.expected = expectedPosition(state, clubId);
    state.user.warnings = 0;
    const c = state.clubs[clubId];
    message(state, `ברוך הבא ${pre('ל', c.name)}`, `ההנהלה מצפה לסיים בסביבות מקום ${state.user.expected}.`, { kind: 'board' });
  }

  function startManager(state, clubId, managerName) {
    state.user = { clubId, name: managerName || 'המנג\'ר', expected: expectedPosition(state, clubId), warnings: 0, career: [] };
    const c = state.clubs[clubId];
    const lg = state.leagues.find((l) => l.id === c.league);
    message(state, `ברוך הבא ${pre('ל', c.name)}!`, `ההנהלה מצפה ממך לסיים בסביבות מקום ${state.user.expected} ${pre('ב', lg.name)}. תקציב העברות: ${money(c.balance)}. חלון ההעברות פתוח עד תחילת ספטמבר.`, { kind: 'board' });
  }

  // ---------- Be a Pro ----------
  const PRO_WEIGHTS = {
    A: [0.2, 0.35, 0.1, 0.25, 0, 0.1],
    W: [0.3, 0.2, 0.15, 0.3, 0, 0.05],
    M: [0.05, 0.1, 0.35, 0.25, 0.15, 0.1],
    DM: [0.05, 0.05, 0.25, 0.1, 0.35, 0.2],
    D: [0.15, 0, 0.1, 0.05, 0.5, 0.2],
  };
  function proWeightKey(pos) {
    if (pos === 'ST' || pos === 'CF') return 'A';
    if (['LW', 'RW', 'LM', 'RM'].includes(pos)) return 'W';
    if (pos === 'CDM') return 'DM';
    if (group(pos) === 'D') return 'D';
    return 'M';
  }
  function proOvr(p) {
    const w = PRO_WEIGHTS[proWeightKey(p.pos)];
    const raw = p.at.reduce((s, v, i) => s + v * w[i], 0);
    return Math.round(raw);
  }

  function proStartOffers(state, country) {
    // the weaker half of the second divisions, so a 17-year-old gets minutes
    const tier2 = Object.values(state.clubs).filter((c) => {
      const lg = state.leagues.find((l) => l.id === c.league);
      return lg.tier === 2 && (!country || lg.country === country);
    }).sort((a, b) => a.rep - b.rep);
    tier2.length = Math.max(3, Math.ceil(tier2.length / 2));
    const tier1Low = Object.values(state.clubs).filter((c) => {
      const lg = state.leagues.find((l) => l.id === c.league);
      return lg.tier === 1 && (!country || lg.country === country) && c.rep <= 72;
    });
    const out = shuffle(tier2).slice(0, 2);
    const t1 = shuffle(tier1Low)[0];
    if (t1) out.push(t1);
    return out;
  }

  function createPro(state, opts) {
    const base = 58;
    const templ = {
      A: [62, 58, 48, 56, 28, 54], W: [66, 52, 52, 60, 30, 46], M: [54, 48, 60, 56, 46, 52],
      DM: [52, 40, 54, 48, 56, 58], D: [56, 32, 46, 42, 59, 58],
    }[proWeightKey(opts.pos)];
    const at = templ.map((v) => clamp(v + rint(-2, 2), 25, 90));
    const id = state.nextPlayerId++;
    const p = {
      id, n: opts.name, fn: opts.name, c: opts.clubId, pos: opts.pos, alt: [], age: 17, ovr: base, pot: rint(84, 94),
      at, v: 0, w: 900, nat: opts.nat || 'Israel', ft: opts.foot || 'R', no: rint(14, 40), ctr: state.seasonYear + 3,
      cond: 100, morale: 70, inj: 0, sus: 0, listed: false, st: emptyStats(), pro: 1,
    };
    p.ovr = proOvr(p);
    p.v = valueFor(p.ovr, p.age, p.pot);
    state.players[id] = p;
    state.pro = { pid: id, xp: {}, focus: 1, career: [], log: [], lastRatings: [], offers: [], fame: 0, caps: 0 };
    for (let i = 0; i < 6; i++) state.pro.xp[i] = 0;
    const club = state.clubs[opts.clubId];
    message(state, `חתמת ${pre('ב', club.name)}!`, `ברוך הבא לקריירה. בגיל 17 אתה מתחיל כשחקן צעיר. תופיע במשחקים לפי הרמה שלך מול המתחרים בעמדה. בחר מוקד אימון כל שבוע כדי להשתפר.`, { kind: 'pro' });
    return p;
  }

  // Status of the pro for the next match: 'start' | 'bench' | 'out'.
  // The coach compares the pro with the club level, with a bonus for recent form.
  function proSquadRole(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    if (!available(p)) return 'out';
    const recent = pro.lastRatings.slice(-4);
    const form = recent.length ? (recent.reduce((s, v) => s + v, 0) / recent.length - 6.6) * 4 : 0;
    const score = p.ovr + form;
    const rep = state.clubs[p.c].rep;
    const youth = p.age <= 19 ? 3 : 0; // coaches give teenagers a chance
    if (score + youth >= rep - 4) return 'start';
    if (score + youth >= rep - 15) return 'bench';
    return 'out';
  }

  function proMatchSim(state, fixture) {
    const p = state.players[state.pro.pid];
    const sim = new MatchSim(state, fixture.m.h, fixture.m.a, { detail: true, proId: p.id });
    sim.proSide = fixture.m.h === p.c ? 0 : 1;
    sim.proLog = [];
    const role = proSquadRole(state);
    sim.proRole = role;
    const side = sim.sides[sim.proSide];
    const onPitch = side.onPitch.some((x) => x.id === p.id);
    side.bench = side.bench.filter((id) => id !== p.id);
    if (role === 'start' && !onPitch) {
      // replace the weakest player in the slot that suits the pro best
      const slotScore = (x) => fit(p, x.slot) * 100 - state.players[x.id].ovr;
      const target = side.onPitch.filter((x) => x.slot !== 'GK' || p.pos === 'GK').sort((a, b) => slotScore(b) - slotScore(a))[0];
      if (target) {
        side.bench.unshift(target.id);
        target.id = p.id;
        side.used.add(p.id);
      }
    } else if (role !== 'start' && onPitch) {
      const x = side.onPitch.find((y) => y.id === p.id);
      const repl = side.bench.map((id) => state.players[id]).sort((a, b) => effective(b, x.slot) - effective(a, x.slot))[0];
      if (repl) {
        side.bench = side.bench.filter((id) => id !== repl.id);
        x.id = repl.id;
        side.used.add(repl.id);
      }
    }
    if (role === 'bench') {
      side.bench.unshift(p.id);
      if (rnd() < 0.65) sim.proSubMinute = rint(58, 78);
    }
    sim.recalc();
    return sim;
  }

  function trainingGain(state, idx, amount) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    const ageF = p.age <= 21 ? 1.3 : p.age <= 25 ? 1 : p.age <= 29 ? 0.7 : 0.4;
    pro.xp[idx] += amount * ageF;
    const gains = [];
    while (pro.xp[idx] >= 100) {
      pro.xp[idx] -= 100;
      const before = p.ovr;
      p.at[idx] = Math.min(99, p.at[idx] + 1);
      const after = proOvr(p);
      if (after > p.pot) {
        p.at[idx]--;
        pro.xp[idx] = 99;
        break;
      }
      p.ovr = after;
      gains.push({ idx, ovr: after, from: before });
    }
    return gains;
  }

  function proAfterMatch(state, sim, ratings) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    const side = sim.sides[sim.proSide];
    const mins = side.played[p.id] || 0;
    const rating = ratings[p.id];
    if (!mins) {
      p.morale = clamp(p.morale - 3, 10, 100);
      return { played: false };
    }
    pro.lastRatings.push(rating);
    if (pro.lastRatings.length > 8) pro.lastRatings.shift();
    const xp = Math.max(3, ((rating - 5.5) * 25 + mins / 6) * 0.45);
    // match XP is spread over the attributes used in the moments
    const used = new Set([pro.focus]);
    for (const l of sim.proLog) {
      if (/בעיט|צ'יפ/.test(l.choice)) used.add(1);
      if (/מסיר|הגבה/.test(l.choice)) used.add(2);
      if (/כדרר|לרוץ|נגיעה|לעצור/.test(l.choice)) used.add(3);
      if (/תיקול|לחסום|לקפוץ|להוביל/.test(l.choice)) used.add(4);
    }
    const gains = [];
    for (const idx of used) gains.push(...trainingGain(state, idx, xp / used.size));
    pro.fame += Math.max(0, rating - 6.5) * 2 + (side.club.rep - 60) * 0.02;
    p.v = valueFor(p.ovr, p.age, p.pot);
    return { played: true, mins, rating, xp: Math.round(xp), gains, goals: sim.events.filter((e) => e.type === 'goal' && e.scorer === p.id).length };
  }

  function proTrain(state) {
    const gains = trainingGain(state, state.pro.focus, 15);
    const p = state.players[state.pro.pid];
    p.v = valueFor(p.ovr, p.age, p.pot);
    return gains;
  }

  function proWeekly(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    for (const g of proTrain(state)) {
      message(state, 'השתפרת באימונים!', `${ATTR_HE[g.idx]} עלה. הדירוג הכללי שלך: ${g.ovr}.`, { kind: 'pro' });
    }
    // national team call-up
    if ((state.week === 10 || state.week === 30) && p.ovr >= 76) {
      pro.caps++;
      message(state, 'זימון לנבחרת!', `נבחרת ${p.nat} זימנה אותך לחלון הנבחרות. סך הופעות: ${pro.caps}.`, { kind: 'pro' });
    }
    if (!windowOpen(state) || pro.offers.length) return;
    const avg = pro.lastRatings.length ? pro.lastRatings.reduce((s, v) => s + v, 0) / pro.lastRatings.length : 0;
    const club = state.clubs[p.c];
    if (pro.lastRatings.length >= 4 && avg >= 6.9 && p.ovr >= club.rep - 3 && rnd() < 0.35) {
      const offers = Object.values(state.clubs).filter((c) => c.id !== club.id && c.rep > club.rep && c.rep <= p.ovr + 5);
      const o = shuffle(offers).slice(0, rint(1, 2));
      for (const c of o) {
        const fee = Math.round((p.v * (1 + rnd() * 0.4)) / 10000) * 10000;
        const wage = Math.round(Math.max(p.w * 1.5, wageFor(p.ovr)) / 100) * 100;
        pro.offers.push({ club: c.id, fee, wage });
        message(state, `${c.name} רוצה אותך!`, `${c.name} הגישה הצעה של ${money(fee)} לקבוצה שלך. שכר מוצע: ${money(wage)} לשבוע.`, { kind: 'proOffer', offer: { club: c.id, fee, wage } });
      }
    }
  }

  function proAcceptOffer(state, clubId) {
    const pro = state.pro;
    const offer = pro.offers.find((o) => o.club === clubId);
    if (!offer) return null;
    const p = state.players[pro.pid];
    const from = state.clubs[p.c];
    from.balance += offer.fee;
    state.clubs[clubId].balance -= offer.fee;
    pro.career.push({ season: state.seasonYear, club: p.c, st: { ...p.st }, partial: true });
    p.c = clubId;
    p.w = offer.wage;
    p.ctr = state.seasonYear + 4;
    p.morale = 85;
    pro.offers = [];
    for (const m of state.inbox) if (m.kind === 'proOffer') m.done = m.offer.club === clubId ? 'accepted' : 'rejected';
    from.lineup = null;
    return `עברת ${pre('ל', state.clubs[clubId].name)}!`;
  }
  function proDeclineOffers(state) {
    state.pro.offers = [];
    for (const m of state.inbox) if (m.kind === 'proOffer' && !m.done) m.done = 'rejected';
  }

  function proSeasonEnd(state, summary) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    pro.career.push({ season: state.seasonYear, club: p.c, st: { ...p.st } });
    summary.pro = { club: p.c, st: { ...p.st }, ovr: p.ovr };
    pro.offers = [];
  }

  // ---------- helpers ----------
  function money(v) {
    const a = Math.abs(v);
    const s = v < 0 ? '-' : '';
    if (a >= 1e6) return `${s}€${(a / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
    if (a >= 1e3) return `${s}€${Math.round(a / 1e3)}K`;
    return `${s}€${Math.round(a)}`;
  }
  // Hebrew prefix letters (מ, ל, ב) before a Latin name read better with a maqaf: "ל-Arsenal".
  function pre(prefix, name) {
    return /^[A-Za-z0-9\u00C0-\u024F]/.test(name) ? `${prefix}-${name}` : `${prefix}${name}`;
  }
  function seasonLabel(year) {
    return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
  }
  function avgRating(p) {
    return p.st.app ? Math.round((p.st.rt / p.st.app) * 100) / 100 : 0;
  }

  return {
    setSeed, rnd, FORMATIONS, MENTALITIES, POS_HE, ATTR_HE, GK_ATTR_HE, SEASON_WEEKS, group,
    newState, startManager, squad, clubsIn, leagueOf, lineupFor, autoLineup, bestFormation, effective, fit, available,
    sortedTable, weekDate, windowOpen, fixturesOfWeek, clubFixture, clubSchedule,
    MatchSim, applyResult, playWeek, afterWeek, endSeason, autoChoice,
    makeOffer, askingPrice, acceptBid, rejectBid, releasePlayer, transfer,
    expectedPosition, jobOffers, takeJob, valueFor, wageFor,
    proStartOffers, createPro, proSquadRole, proMatchSim, proAfterMatch, proAcceptOffer, proDeclineOffers, proOvr, proWeightKey,
    money, seasonLabel, avgRating, message, pre,
  };
});
