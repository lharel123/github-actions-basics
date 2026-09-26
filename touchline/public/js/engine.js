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
    initMonth(state);
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
        const focus = (s.club.training || {}).focus;
        const trA = focus === 'attack' ? 1.02 : 1;
        const trD = focus === 'defense' ? 1.02 : 1;
        const trC = focus === 'tactical' ? 1.02 : 1;
        s.r = {
          att: (0.6 * a + 0.3 * m + 0.1 * d) * men.att * numF * homeF * trA,
          def: (0.55 * d + 0.25 * m + 0.2 * g) * men.def * numF * homeF * trD,
          ctl: (0.7 * m + 0.15 * a + 0.15 * d) * numF * homeF * trC,
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
        const fitF = (s.club.training || {}).focus === 'fitness' ? 0.85 : 1;
        for (const x of s.onPitch) {
          const p = this.state.players[x.id];
          const phy = p.pos === 'GK' ? 70 : p.at[5] || 60;
          p.cond = Math.max(20, p.cond - (0.36 - (phy - 60) * 0.004) * fitF);
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
          if (pid) this.log('chance', atkIdx, { p: this.name(pid) }, { player: pid });
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
        this.log('save', atkIdx, { p: this.name(shooter), g: gkId ? this.name(gkId) : '' }, { player: shooter, keeper: gkId });
        return 'save';
      }
      if (rnd() < 0.06) this.log('post', atkIdx, { p: this.name(shooter) }, { player: shooter });
      else this.log('miss', atkIdx, { p: this.name(shooter) }, { player: shooter });
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
        if (pid === this.proId && this.detail && !this.pending) {
          this.pending = injuryMoment(this); // the pro decides whether to play on
          return;
        }
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
      const chance = attacking ? { A: 0.05, M: 0.042, D: 0.018, G: 0 }[g] : { A: 0.003, M: 0.024, D: 0.048, G: 0.03 }[g];
      if (rnd() > chance) return false;
      const moment = buildMoment(this, x.slot, attacking);
      if (!moment) return false;
      this.pending = finalizeMoment(this, moment);
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
      let res = opt.resolve(this, success);
      const delta = success ? (opt.good === undefined ? 0.25 : opt.good) : (opt.bad === undefined ? -0.15 : opt.bad);
      this.bump(s, this.proId, delta);
      const text = (success ? opt.okText : opt.failText) || '';
      let chained = false;
      if (success && opt.next) {
        const nm = opt.next(this);
        if (nm) {
          this.pending = finalizeMoment(this, nm);
          chained = true;
          res = 'chain';
        }
      }
      this.events.push({ min: this.minute, type: 'pro', side: i, text: `⭐ ${text}`, success, result: res, player: this.proId });
      this.proLog.push({ min: this.minute, title: m.title, choice: opt.label, tags: opt.tags || [], p: opt.p, success, result: res, delta, pressure: !!m.pressure });
      if (res === 'goal' && this.minute >= 80) this.lateGoal = (this.lateGoal || 0) + 1;
      if (!chained && this.minute >= 90 + this.stoppage[1]) this.finish();
      return { success, result: res, text, chained };
    }

    // A goal that is certain (penalty scored): same bookkeeping as a scored shot.
    forceGoal(i, scorer, assist) {
      const att = this.sides[i];
      const def = this.sides[1 - i];
      att.goals++;
      att.shots++;
      att.sot++;
      att.xg += 0.76;
      this.bump(att, scorer, 1.1);
      if (assist) this.bump(att, assist, 0.6);
      for (const x of def.onPitch) this.bump(def, x.id, group(x.slot) === 'D' || x.slot === 'GK' ? -0.25 : -0.08);
      this.log('goal', i, { p: this.name(scorer), a: assist ? this.name(assist) : '' }, { scorer, assist });
      return 'goal';
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
  // Every option carries tags (shot, pass, dribble, run, aerial, tackle, block, save, penalty)
  // so perks, pressure and chemistry can adjust it in finalizeMoment().
  function buildMoment(sim, slot, attacking) {
    const st = sim.state;
    const i = sim.proSide;
    const me = st.players[sim.proId];
    const own = sim.sides[i];
    const opp = sim.sides[1 - i];
    const oppDef = opp.r.def;
    const oppAtt = opp.r.att;
    const g = group(slot);
    const wide = ['LW', 'RW', 'LM', 'RM', 'LB', 'RB', 'LWB', 'RWB'].includes(slot);
    const conf = (me.morale - 50) / 500; // -0.1 .. +0.1
    const chanceP = (attr, base, spread) => clamp(base + (attr - oppDef) / (spread * 1.4) + conf, 0.05, 0.88);
    const defP = (attr, base, spread) => clamp(base + (attr - oppAtt) / spread + conf, 0.06, 0.92);
    const mate = () => sim.pickPlayer(own, (pl, sl) => (group(sl) === 'A' ? 3 : group(sl) === 'M' ? 2 : 0.4), sim.proId);
    const shoot = (xg) => (s, ok) => {
      if (!ok) {
        own.shots++;
        own.xg += xg;
        return 'miss';
      }
      return s.maybeShot(i, { shooter: sim.proId, xg: Math.min(0.38, xg * 1.1), assist: null }) || 'miss';
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
    const kept = (s, ok) => (ok ? 'kept' : 'lost');
    const [pac, sho, pas, dri, def, phy] = me.at;

    // reusable follow-up moments (two-stage plays)
    const oneOnOne = () => ({
      title: 'אחד על אחד עם השוער!', desc: 'השארת את ההגנה מאחור. רק השוער לפניך.',
      options: [
        { label: 'לבעוט חזק', tags: ['shot'], p: chanceP(sho, 0.55, 45), resolve: shoot(0.3), value: 1.4, okText: 'בעיטה חזקה...', failText: 'השוער סגר את הזווית.', good: 0.3, bad: -0.3 },
        { label: 'לכדרר את השוער', tags: ['dribble'], p: chanceP(dri, 0.45, 45), resolve: (s, ok) => (ok ? shoot(0.34)(s, true) : 'lost'), value: 1.5, okText: 'עברת את השוער!', failText: 'השוער לקח לך את הכדור מהרגליים.', good: 0.4, bad: -0.35 },
        { label: 'צ\'יפ מעל השוער', tags: ['shot'], p: chanceP((sho + dri) / 2, 0.38, 40), resolve: shoot(0.33), value: 1.6, okText: 'צ\'יפ עדין...', failText: 'הצ\'יפ היה חלש מדי.', good: 0.45, bad: -0.3 },
      ],
    });
    const cutInside = () => ({
      title: 'חתכת פנימה! מה עכשיו?', desc: 'עברת את המגן ואתה בקצה הרחבה עם הרגל החזקה.',
      options: [
        { label: 'בעיטה מסובבת לפינה הרחוקה', tags: ['shot'], p: chanceP(sho, 0.36, 42), resolve: shoot(0.2), value: 1.3, okText: 'בעיטה מסובבת...', failText: 'הבעיטה עברה ליד.', good: 0.3, bad: -0.1 },
        { label: 'מסירה לחלוץ ברחבה', tags: ['pass'], p: chanceP(pas, 0.52, 45), resolve: passTo(0.3), value: 1.1, okText: 'מסירה מדויקת!', failText: 'הבלם חתך.', good: 0.25, bad: -0.1 },
      ],
    });

    // ----- goalkeeper -----
    if (g === 'G') {
      const gkDef = (s, ok) => (ok ? 'won' : defend(0.45)(s, false));
      return pick([
        {
          title: 'חלוץ יריב פורץ לבד מולך!', desc: `${opp.club.name} בהתקפה מתפרצת, החלוץ חמק מההגנה ורץ לעברך.`,
          options: [
            { label: 'לצאת מהשער ולסגור זווית', tags: ['save'], p: defP((me.at[0] + me.at[5]) / 2, 0.5, 60), resolve: defend(0.55), okText: 'יצאת בזמן ולקחת את הכדור מהרגליים שלו!', failText: 'יצאת מאוחר מדי...', good: 0.6 },
            { label: 'להישאר על הקו ולחכות לבעיטה', tags: ['save'], p: defP(me.at[3], 0.45, 60), resolve: defend(0.4), okText: 'הצלה רפלקסיבית מדהימה!', failText: 'הבעיטה הייתה חזקה מדי.', good: 0.7 },
          ],
        },
        {
          title: 'הגבהה לתוך הרחבה שלך', desc: 'כדור גבוה נופל בין השוער לחלוצי היריבה.',
          options: [
            { label: 'לצאת ולתפוס', tags: ['save'], p: defP(me.at[1], 0.5, 55), resolve: gkDef, okText: 'תפיסה בטוחה באוויר!', failText: 'הכדור נשמט לך מהידיים!', good: 0.35, bad: -0.4 },
            { label: 'להרחיק באגרוף', tags: ['save'], p: defP((me.at[1] + me.at[0]) / 2, 0.65, 60), resolve: gkDef, okText: 'אגרוף חזק החוצה.', failText: 'האגרוף נפל לרגלי יריב.', good: 0.2, bad: -0.3 },
            { label: 'להישאר על הקו', tags: ['save'], p: defP(me.at[3], 0.4, 60), resolve: gkDef, okText: 'הנגיחה הגיעה אליך בדיוק.', failText: 'נגיחה מטווח קצר...', good: 0.3, bad: -0.2 },
          ],
        },
        {
          title: 'פנדל נגדך!', desc: 'השופט הצביע על הנקודה. החלוץ מסדר את הכדור.',
          penalty: true,
          options: [
            { label: 'לזנק שמאלה', tags: ['save', 'penalty'], p: clamp(0.25 + (me.at[0] - 70) / 150, 0.12, 0.45), resolve: (s, ok) => (ok ? 'saved' : penaltyAgainst(s)), value: 1, okText: 'עצרת את הפנדל!!!', failText: 'החלוץ בעט לצד השני.', good: 1.0, bad: -0.05 },
            { label: 'לזנק ימינה', tags: ['save', 'penalty'], p: clamp(0.25 + (me.at[0] - 70) / 150, 0.12, 0.45), resolve: (s, ok) => (ok ? 'saved' : penaltyAgainst(s)), value: 1, okText: 'עצרת את הפנדל!!!', failText: 'החלוץ בעט לצד השני.', good: 1.0, bad: -0.05 },
            { label: 'להישאר במרכז', tags: ['save', 'penalty'], p: clamp(0.14 + (me.at[3] - 70) / 200, 0.08, 0.3), resolve: (s, ok) => (ok ? 'saved' : penaltyAgainst(s)), value: 1, okText: 'הוא ניסה פננקה ותפסת!', failText: 'בעיטה לפינה.', good: 1.1, bad: -0.05 },
          ],
        },
      ]);
    }
    function penaltyAgainst(s) {
      const shooter = s.pickPlayer(opp, (pl, sl) => (group(sl) === 'A' ? 4 : 1) * (pl.at[1] || 50));
      if (rnd() < 0.08) return 'miss'; // it happens
      return shooter ? s.forceGoal(1 - i, shooter, null) : 'miss';
    }

    // ----- defending -----
    if (!attacking) {
      const list = [
        {
          title: 'החלוץ היריב רץ לעברך עם הכדור', desc: `${opp.club.name} תוקפת, השחקן היריב מנסה לעבור אותך בדרך לרחבה.`,
          options: [
            { label: 'תיקול גלישה', tags: ['tackle'], p: defP(def, 0.35, 45), resolve: defend(0.35), okText: 'תיקול מושלם! לקחת את הכדור נקי.', failText: 'פספסת את התיקול והוא עבר אותך!', good: 0.5, bad: -0.35 },
            { label: 'לעמוד מולו ולחסום', tags: ['block'], p: defP(def, 0.5, 50), resolve: defend(0.18), okText: 'חסמת אותו והכרחת אותו לאחור.', failText: 'הוא מצא זווית לבעיטה.', good: 0.3 },
            { label: 'להוביל אותו לקו הצד', tags: ['run'], p: defP(pac, 0.62, 55), resolve: defend(0.1), okText: 'דחקת אותו החוצה, הכדור יצא לחוץ.', failText: 'הוא הגביה לרחבה.', good: 0.2 },
          ],
        },
        {
          title: 'הגבהה לרחבה שלך', desc: 'כדור גבוה נשלח לרחבה, חלוץ יריב ממתין מאחוריך.',
          options: [
            { label: 'לקפוץ ולהרחיק בראש', tags: ['aerial'], p: defP(phy, 0.5, 45), resolve: defend(0.3), okText: 'ניצחת בדו-קרב האווירי והרחקת!', failText: 'החלוץ היה גבוה יותר.', good: 0.35 },
            { label: 'לעצור בחזה ולצאת עם הכדור', tags: ['dribble'], p: defP(dri, 0.35, 45), resolve: (s, ok) => (ok ? 'won' : defend(0.4)(s, false)), okText: 'איזו שליטה! יצאת מהלחץ בסטייל.', failText: 'איבדת את הכדור ברחבה!', good: 0.55, bad: -0.4 },
          ],
        },
        {
          title: 'מתפרצת 2 על 1 נגדכם!', desc: 'שני תוקפים רצים לעבר השער ורק אתה ביניהם לבין השוער.',
          options: [
            { label: 'לסגור את המוביל', tags: ['tackle'], p: defP((def + pac) / 2, 0.42, 45), resolve: defend(0.32), okText: 'לחצת עליו והוא איבד את הכדור!', failText: 'הוא מסר לחבר הפנוי...', good: 0.45, bad: -0.3 },
            { label: 'לסגור את קו המסירה', tags: ['block'], p: defP(def, 0.48, 50), resolve: defend(0.22), okText: 'חתכת את המסירה!', failText: 'המוביל בעט בעצמו.', good: 0.4, bad: -0.2 },
            { label: 'לסגת ולהשהות', tags: ['run'], p: defP(pac, 0.58, 55), resolve: defend(0.15), okText: 'השהית עד שהחברים חזרו.', failText: 'הם מצאו פתרון.', good: 0.25, bad: -0.15 },
          ],
        },
      ];
      if (g === 'M') {
        list.push({
          title: 'לחץ על הקשר היריב', desc: 'הקשר של היריבה קיבל כדור עם הגב לשער.',
          options: [
            { label: 'לחץ אגרסיבי מאחור', tags: ['tackle'], p: defP((def + phy) / 2, 0.45, 45), resolve: (s, ok) => (ok ? 'won' : 'lost'), okText: 'חטפת את הכדור ויצאת להתקפה!', failText: 'עבירה מיותרת.', good: 0.35, bad: -0.15 },
            { label: 'לסגור שטח ולחכות', tags: ['block'], p: defP(def, 0.6, 55), resolve: kept, okText: 'אילצת אותו למסור אחורה.', failText: 'הוא הסתובב ופתח משחק.', good: 0.15, bad: -0.1 },
          ],
        });
      }
      return pick(list);
    }

    // ----- attacking -----
    // penalty for the team's shooters
    if ((g === 'A' || sho >= 72) && rnd() < 0.07) {
      const pen = (quality) => (s, ok) => (ok ? s.forceGoal(i, sim.proId, null) : (own.shots++, own.xg += 0.76, rnd() < 0.5 ? 'saved' : 'miss'));
      return {
        title: 'פנדל!', desc: 'הכשילו אותך ברחבה והשופט שרק. אתה לוקח את הבעיטה.', penalty: true,
        options: [
          { label: 'לפינה התחתונה', tags: ['penalty'], p: clamp(0.66 + (sho - 70) / 110 + conf, 0.45, 0.92), resolve: pen(1), value: 1.2, okText: 'גוול מהנקודה!', failText: 'השוער ניחש נכון.', good: 0.25, bad: -0.4 },
          { label: 'לחיבורים בכוח', tags: ['penalty'], p: clamp(0.56 + (sho - 70) / 90 + conf, 0.35, 0.9), resolve: pen(1), value: 1.3, okText: 'טיל לחיבורים!', failText: 'עף מעל המשקוף...', good: 0.35, bad: -0.45 },
          { label: 'פננקה', tags: ['penalty'], p: clamp(0.44 + (sho + dri - 140) / 120 + conf, 0.2, 0.8), resolve: pen(1), value: 1.6, okText: 'פננקה בקור רוח מטורף!', failText: 'השוער נשאר באמצע ותפס...', good: 0.6, bad: -0.8 },
        ],
      };
    }
    const attackList = [];
    if (g === 'A' || (g === 'M' && slot === 'CAM')) {
      attackList.push({
        title: 'אתה ברחבה עם הכדור!', desc: `קיבלת כדור בגובה 14 מטר, בלם של ${opp.club.name} מתקרב.`,
        options: [
          { label: 'בעיטה מיידית לפינה', tags: ['shot'], p: chanceP(sho, 0.42, 45), resolve: shoot(0.16), value: 1.3, okText: 'בעיטה מדויקת למסגרת!', failText: 'הבעיטה עפה מעל.', good: 0.2, bad: -0.15 },
          { label: 'לקחת נגיעה ולסדר את הבעיטה', tags: ['dribble', 'shot'], p: chanceP((sho + dri) / 2, 0.32, 45), resolve: shoot(0.24), value: 1.5, okText: 'סידרת את עצמך מצוין ובעטת!', failText: 'הבלם חסם את הבעיטה.', good: 0.25, bad: -0.2 },
          { label: 'בעיטה מסובבת לחיבורים', tags: ['shot'], perk: 'finesse', p: chanceP(sho, 0.38, 40), resolve: shoot(0.32), value: 1.6, okText: 'בעיטה מסובבת מושלמת...', failText: 'סיבוב אחד יותר מדי.', good: 0.4, bad: -0.1 },
          { label: 'מסירה לחבר פנוי', tags: ['pass'], p: chanceP(pas, 0.6, 50), resolve: passTo(0.28), value: 0.9, okText: 'מסירה חכמה לחבר!', failText: 'המסירה נחתכה.', good: 0.2, bad: -0.15 },
        ],
      });
      attackList.push({
        title: 'הגבהה לרחבה!', desc: 'הכנף שלך מגביה, אתה מתרומם בין שני בלמים.',
        options: [
          { label: 'נגיחה לפינה', tags: ['aerial', 'shot'], p: chanceP((phy + sho) / 2, 0.36, 45), resolve: shoot(0.2), value: 1.3, okText: 'נגיחה חזקה...', failText: 'הנגיחה עברה מעל.', good: 0.3, bad: -0.1 },
          { label: 'להוריד בראש לחבר', tags: ['aerial', 'pass'], p: chanceP((phy + pas) / 2, 0.5, 45), resolve: passTo(0.24), value: 1, okText: 'הורדה מדויקת!', failText: 'ההורדה נפלה לבלם.', good: 0.25, bad: -0.1 },
          { label: 'לעצור בחזה ולבעוט', tags: ['dribble', 'shot'], p: chanceP((dri + sho) / 2, 0.3, 42), resolve: shoot(0.26), value: 1.4, okText: 'עצירה ובעיטה באוויר!', failText: 'הבלם הגיע קודם.', good: 0.4, bad: -0.15 },
        ],
      });
      attackList.push({
        title: 'מתפרצת! אתה רץ עם הכדור', desc: 'קיבלת כדור בחצי שלך ויש שטח פתוח לפניך.',
        options: [
          { label: 'לרוץ לבד לשער', tags: ['run'], p: chanceP((pac + dri) / 2, 0.42, 45), resolve: kept, next: oneOnOne, value: 1.3, okText: 'השארת את כולם מאחור!', failText: 'המגן השיג אותך.', good: 0.2, bad: -0.15 },
          { label: 'טריק רולטה על המגן', tags: ['dribble'], perk: 'dribbler', p: chanceP(dri, 0.5, 42), resolve: kept, next: oneOnOne, value: 1.5, okText: 'רולטה! המגן על הדשא.', failText: 'הטריק לא יצא.', good: 0.35, bad: -0.2 },
          { label: 'מסירת עומק לחלוץ', tags: ['pass'], p: chanceP(pas, 0.5, 45), resolve: passTo(0.3), value: 1.1, okText: 'מסירת עומק מושלמת!', failText: 'המסירה הייתה ארוכה מדי.', good: 0.3, bad: -0.1 },
          { label: 'להאט ולחכות לחברים', tags: ['pass'], p: 0.85, resolve: kept, value: 0.2, okText: 'שמרת על הכדור.', failText: 'איבדת את הכדור.', good: 0.05 },
        ],
      });
    }
    if (wide) {
      attackList.push({
        title: 'אתה בקו הצד מול המגן', desc: 'יש לך כדור בשליש האחרון, המגן היריב מולך.',
        options: [
          { label: 'הגבהה לנקודה הרחוקה', tags: ['pass'], p: chanceP(pas, 0.48, 45), resolve: passTo(0.2), value: 1, okText: 'הגבהה מושלמת!', failText: 'ההגבהה נחסמה.', good: 0.25, bad: -0.1 },
          { label: 'כדור רוחב לאחור', tags: ['pass'], p: chanceP((pas + dri) / 2, 0.4, 45), resolve: passTo(0.28), value: 1.1, okText: 'כדור רוחב חכם!', failText: 'המגן חתך.', good: 0.3, bad: -0.1 },
          { label: 'לחתוך פנימה', tags: ['dribble'], p: chanceP((dri + pac) / 2, 0.45, 45), resolve: kept, next: cutInside, value: 1.3, okText: 'חתכת פנימה!', failText: 'המגן לא נפל לזה.', good: 0.2, bad: -0.15 },
          { label: 'לעבור בספרינט על הקו', tags: ['run'], perk: 'speedster', p: chanceP(pac, 0.55, 40), resolve: passTo(0.3), value: 1.3, okText: 'עפת על הקו והגבהת!', failText: 'המגן החזיק מעמד.', good: 0.35, bad: -0.1 },
        ],
      });
    }
    if (g === 'M' || g === 'D' || attackList.length === 0) {
      attackList.push({
        title: 'יש לך את הכדור במרכז המגרש', desc: 'לחץ של קשר יריב, חלוץ שלך מסמן לעומק.',
        options: [
          { label: 'מסירת עומק מסוכנת', tags: ['pass'], p: chanceP(pas, 0.38, 45), resolve: passTo(0.25), value: 1.2, okText: 'מסירה פותחת הגנה!', failText: 'המסירה נחתכה.', good: 0.3, bad: -0.2 },
          { label: 'מסירת קסם בין הבלמים', tags: ['pass'], perk: 'playmaker', p: chanceP(pas, 0.4, 40), resolve: passTo(0.38), value: 1.5, okText: 'מסירת קסם! החלוץ לבד.', failText: 'רק סנטימטר אחד...', good: 0.45, bad: -0.1 },
          { label: 'בעיטה מרחוק', tags: ['shot'], p: chanceP(sho, 0.35, 45), resolve: shoot(0.05), value: 0.8, okText: 'בעיטה חזקה מ-25 מטר!', failText: 'בעיטה חלשה לידי השוער.', good: 0.2, bad: -0.1 },
          { label: 'מסירה בטוחה הצידה', tags: ['pass'], p: chanceP(pas, 0.8, 70), resolve: kept, value: 0.3, okText: 'שמרת על החזקה.', failText: 'מסירה רעה, איבדת כדור.', good: 0.08, bad: -0.25 },
        ],
      });
      attackList.push({
        title: 'כדור חופשי ב-28 מטר', desc: 'השופט שרק לעבירה ואתה לוקח את הבעיטה.',
        options: [
          { label: 'לבעוט ישר לשער', tags: ['shot'], p: chanceP(sho, 0.3, 40), resolve: shoot(0.08), value: 1, okText: 'בעיטה מסובבת מעל החומה...', failText: 'הכדור פגע בחומה.', good: 0.25, bad: -0.05 },
          { label: 'להגביה לרחבה', tags: ['pass'], p: chanceP(pas, 0.5, 45), resolve: passTo(0.14), value: 1, okText: 'הגבהה מדויקת לראש!', failText: 'השוער אסף את ההגבהה.', good: 0.2, bad: -0.05 },
        ],
      });
    }
    if (g === 'D' && (slot === 'CB' || phy >= 70)) {
      attackList.push({
        title: 'קרן! עלית לרחבה', desc: 'הקשר שלך עומד לבעוט קרן, אתה בנקודת הפנדל.',
        options: [
          { label: 'נגיחה לשער', tags: ['aerial', 'shot'], p: chanceP((phy + sho) / 2, 0.3, 45), resolve: shoot(0.22), value: 1.3, okText: 'ניצחת בגובה ונגחת!', failText: 'הבלם היריב הרחיק.', good: 0.35, bad: -0.05 },
          { label: 'לחסום את השוער לחבר', tags: ['aerial', 'pass'], p: chanceP(phy, 0.55, 50), resolve: passTo(0.18), value: 1, okText: 'פתחת שטח לחבר!', failText: 'השוער תפס.', good: 0.2, bad: -0.05 },
        ],
      });
    }
    return pick(attackList);
  }

  // ----- perks: unlocked abilities that improve (or add) options -----
  const PERKS = {
    finesse: { name: 'בעיטה מסובבת', desc: '+6% לבעיטות, ופותח "בעיטה מסובבת לחיבורים" ברחבה.', req: 'בעיטה 78', tags: ['shot'], bonus: 0.06, test: (p) => p.pos !== 'GK' && p.at[1] >= 78 },
    speedster: { name: 'שד מהירות', desc: '+7% לריצות, ופותח ספרינט על הקו.', req: 'מהירות 82', tags: ['run'], bonus: 0.07, test: (p) => p.pos !== 'GK' && p.at[0] >= 82 },
    playmaker: { name: 'מוח המשחק', desc: '+7% למסירות, ופותח "מסירת קסם".', req: 'מסירה 80', tags: ['pass'], bonus: 0.07, test: (p) => p.pos !== 'GK' && p.at[2] >= 80 },
    dribbler: { name: 'קוסם', desc: '+7% לכדרורים, ופותח טריק רולטה.', req: 'כדרור 80', tags: ['dribble'], bonus: 0.07, test: (p) => p.pos !== 'GK' && p.at[3] >= 80 },
    wall: { name: 'חומה', desc: '+7% לתיקולים וחסימות.', req: 'הגנה 78', tags: ['tackle', 'block'], bonus: 0.07, test: (p) => p.pos !== 'GK' && p.at[4] >= 78 },
    aerial: { name: 'מלך האוויר', desc: '+8% לכדורי ראש.', req: 'פיזיות 78', tags: ['aerial'], bonus: 0.08, test: (p) => p.pos !== 'GK' && p.at[5] >= 78 },
    penalty: { name: 'מומחה פנדלים', desc: '+10% בפנדלים.', req: 'בעיטה 74', tags: ['penalty'], bonus: 0.1, test: (p) => p.pos !== 'GK' && p.at[1] >= 74 },
    reflexes: { name: 'רפלקסים', desc: '+7% להצלות.', req: 'רפלקסים 78 (שוער)', tags: ['save'], bonus: 0.07, test: (p) => p.pos === 'GK' && p.at[3] >= 78 },
    clutch: { name: 'איש הרגעים הגדולים', desc: 'לחץ של סוף משחק לא משפיע עליך.', req: '3 שערים אחרי דקה 80, או דירוג 82', tags: [], bonus: 0, test: (p, pro) => (pro.lateGoals || 0) >= 3 || p.ovr >= 82 },
    leader: { name: 'מנהיג', desc: 'אמון המאמן והמורל של הקבוצה עולים כל חודש.', req: 'קפטן הקבוצה', tags: [], bonus: 0, test: (p, pro) => !!pro.captain && pro.captain === p.c },
  };

  function finalizeMoment(sim, m) {
    const st = sim.state;
    const pro = st.pro;
    if (!pro || m.injury) return m;
    const me = st.players[sim.proId];
    const perks = new Set(pro.perks || []);
    const own = sim.sides[sim.proSide];
    const opp = sim.sides[1 - sim.proSide];
    const pressure = sim.minute >= 80 && Math.abs(own.goals - opp.goals) <= 1;
    let pen = pressure ? 0.07 : 0;
    if (perks.has('clutch')) pen = 0;
    else if (pro.services && pro.services.psych) pen /= 2;
    const chem = ((pro.chem || {})[me.c] || 0) / 100;
    m.options = m.options.filter((o) => !o.perk || perks.has(o.perk));
    for (const o of m.options) {
      let bonus = 0;
      for (const id of perks) {
        const pk = PERKS[id];
        if (pk && pk.bonus && (o.tags || []).some((t) => pk.tags.includes(t))) bonus += pk.bonus;
      }
      bonus = Math.min(0.1, bonus); // perks do not stack beyond +10%
      if ((o.tags || []).includes('pass')) bonus += chem * 0.06;
      o.base = o.p;
      o.p = clamp(o.p + bonus - pen, 0.04, 0.95);
      o.boost = Math.round(bonus * 100);
    }
    m.pressure = pressure && pen > 0;
    m.minute = sim.minute;
    return m;
  }

  function injuryMoment(sim) {
    const i = sim.proSide;
    const p = sim.state.players[sim.proId];
    return {
      injury: true, title: 'נפגעת!', desc: 'קיבלת מכה חזקה בברך. הצוות הרפואי רץ אליך.',
      options: [
        { label: 'להמשיך לשחק דרך הכאב', tags: [], p: 0.65, resolve: (s, ok) => {
          if (ok) return 'kept';
          p.inj = rint(3, 6);
          s.autoSub(i, sim.proId);
          return 'injured';
        }, okText: 'שיניים חזקות, אתה ממשיך!', failText: 'הכאב החמיר ונאלצת לצאת. פציעה ארוכה יותר.', good: 0.1, bad: -0.2 },
        { label: 'לבקש חילוף', tags: [], p: 1, resolve: (s) => {
          p.inj = rint(1, 2);
          s.autoSub(i, sim.proId);
          return 'subbed';
        }, okText: 'יצאת בזמן. פציעה קלה.', failText: '', good: 0, bad: 0 },
      ],
    };
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
    for (const p of Object.values(state.players)) if (p.inj > 0) p.inj--;
    weeklyTraining(state);
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
    if (state.pro) state.pro.money = (state.pro.money || 0) + state.players[state.pro.pid].w;
    state.week++;
    if (state.week > SEASON_WEEKS) return endSeason(state);
    if (monthKeyOf(state, state.week) !== state.monthKey) monthTurn(state);
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
    // part of the yearly growth now happens month by month in monthlyDevelopment()
    if (p.age <= 21) delta = Math.round((p.pot - p.ovr) * (0.1 + 0.14 * minutesShare) + gauss() * 1.1);
    else if (p.age <= 24) delta = Math.round((p.pot - p.ovr) * (0.06 + 0.1 * minutesShare) + gauss());
    else if (p.age <= 28) delta = Math.round(gauss() * 1.1 + (p.pot > p.ovr ? 0.3 : 0));
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

    summary.awards = seasonAwards(state, summary.champions);

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
    if (state.pro) setObjectives(state);
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
    state.user.confidence = 60;
    initMonth(state);
    const c = state.clubs[clubId];
    message(state, `ברוך הבא ${pre('ל', c.name)}`, `ההנהלה מצפה לסיים בסביבות מקום ${state.user.expected}.`, { kind: 'board' });
  }

  function startManager(state, clubId, managerName) {
    state.user = { clubId, name: managerName || 'המנג\'ר', expected: expectedPosition(state, clubId), warnings: 0, career: [], confidence: 60 };
    initMonth(state);
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
    const w = PRO_WEIGHTS[proWeightKey(p.pos)];
    const bestFocus = p.pos === 'GK' ? 3 : w.indexOf(Math.max(...w));
    state.pro = { pid: id, xp: {}, focus: bestFocus, intensity: 'normal', trust: 50, money: 0, career: [], log: [], lastRatings: [], offers: [], fame: 0, caps: 0 };
    for (let i = 0; i < 6; i++) state.pro.xp[i] = 0;
    Object.assign(state.pro, { perks: [], ach: {}, services: {}, bought: {}, chem: {}, fans: 50, lateGoals: 0, intlGoals: 0, contractRole: 'prospect' });
    initMonth(state);
    setObjectives(state);
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
    const trust = ((pro.trust === undefined ? 50 : pro.trust) - 50) / 8;
    const score = p.ovr + form + trust;
    const rep = state.clubs[p.c].rep;
    const youth = p.age <= 19 ? 3 : 0; // coaches give teenagers a chance
    if (score + youth >= rep - 4) return 'start';
    if (score + youth >= rep - 15) return 'bench';
    return 'out';
  }

  function proMatchSim(state, fixture) {
    const p = state.players[state.pro.pid];
    if (state.pro.painRisk) {
      const risk = state.pro.painRisk;
      state.pro.painRisk = 0;
      if (rnd() < risk) {
        p.inj = rint(3, 6);
        message(state, 'הפציעה החמירה', `שיחקת דרך הכאב והפציעה החמירה. תיעדר ${p.inj} שבועות.`, { kind: 'pro' });
      }
    }
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

  // ---------- Be a Pro: career systems ----------
  const ACHIEVEMENTS = {
    debut: { name: 'הופעת בכורה', ico: '👕' },
    first_goal: { name: 'שער ראשון', ico: '⚽' },
    brace: { name: 'צמד', ico: '✌️' },
    hat_trick: { name: 'שלושער', ico: '🎩' },
    late_winner: { name: 'שער ניצחון בדקות הסיום', ico: '⏱️' },
    goals_10: { name: '10 שערים בקריירה', ico: '🔟' },
    goals_50: { name: '50 שערים בקריירה', ico: '🥈' },
    goals_100: { name: '100 שערים בקריירה', ico: '💯' },
    goals_200: { name: '200 שערים בקריירה', ico: '👑' },
    apps_50: { name: '50 הופעות', ico: '🎖️' },
    apps_100: { name: '100 הופעות', ico: '🏅' },
    apps_250: { name: '250 הופעות', ico: '🏆' },
    potm: { name: 'שחקן החודש', ico: '📅' },
    first_cap: { name: 'הופעה ראשונה בנבחרת', ico: '🎌' },
    intl_goal: { name: 'שער ראשון בנבחרת', ico: '🌍' },
    captain: { name: 'קפטן', ico: '©️' },
    champion: { name: 'אליפות', ico: '🏆' },
    promoted: { name: 'עלייה ליגה', ico: '⬆️' },
    golden_boot: { name: 'מלך השערים', ico: '👟' },
    player_season: { name: 'שחקן העונה', ico: '⭐' },
    young_player: { name: 'השחקן הצעיר של העונה', ico: '🌱' },
    ballon_podium: { name: 'פודיום כדור הזהב', ico: '🥉' },
    ballon_dor: { name: 'כדור הזהב', ico: '🥇' },
    tournament_win: { name: 'זכייה בטורניר נבחרות', ico: '🌟' },
    objectives: { name: 'עמדת בכל יעדי העונה', ico: '🎯' },
  };
  const SERVICES = {
    trainer: { name: 'מאמן אישי', desc: '+25% נקודות ניסיון מאימונים ומשחקים.', weekly: 0.12 },
    nutrition: { name: 'תזונאי', desc: 'חצי סיכון לפציעות באימונים ובמשחקים.', weekly: 0.08 },
    physio: { name: 'פיזיותרפיסט פרטי', desc: 'חוזר מפציעות מהר פי 2.', weekly: 0.08 },
    psych: { name: 'פסיכולוג ספורט', desc: 'חצי מהלחץ בדקות הסיום, ומורל עולה כל שבוע.', weekly: 0.06 },
  };
  const PURCHASES = {
    car: { name: 'מכונית ספורט', desc: 'מוניטין +3, מורל +10.', cost: 90000, fame: 3, morale: 10 },
    house: { name: 'בית עם בריכה', desc: 'מוניטין +6, מורל +20.', cost: 600000, fame: 6, morale: 20 },
    academy: { name: 'אקדמיה לילדים בעיר הולדתך', desc: 'מוניטין +15, אוהדים +10.', cost: 2000000, fame: 15, fans: 10 },
  };
  const NATION_STRENGTH = {
    Spain: 86, France: 86, Argentina: 86, England: 85, Brazil: 85, Portugal: 84, Germany: 84, Netherlands: 83, Italy: 82,
    Belgium: 81, Croatia: 80, Uruguay: 79, Colombia: 78, Morocco: 78, 'United States': 76, Japan: 76, Denmark: 77, Switzerland: 77,
    Senegal: 77, Mexico: 76, Norway: 76, Austria: 76, Turkey: 76, Serbia: 75, Ukraine: 75, Poland: 75, Nigeria: 74, Israel: 70,
  };
  const INTL_OPPONENTS = ['ספרד', 'צרפת', 'ארגנטינה', 'אנגליה', 'ברזיל', 'פורטוגל', 'גרמניה', 'הולנד', 'איטליה', 'בלגיה', 'קרואטיה', 'אורוגוואי', 'קולומביה', 'מרוקו', 'יפן', 'דנמרק', 'שווייץ', 'מקסיקו', 'נורבגיה', 'אוסטריה', 'טורקיה', 'סרביה', 'פולין', 'ויילס', 'סקוטלנד', 'יוון', 'צ\'כיה', 'אוקראינה', 'רומניה', 'אלבניה'];
  function nationStrength(nat) {
    return NATION_STRENGTH[nat] || 72;
  }
  function careerTotals(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    const t = { app: p.st.app, gl: p.st.gl, as: p.st.as };
    for (const c of pro.career) {
      t.app += c.st.app;
      t.gl += c.st.gl;
      t.as += c.st.as;
    }
    return t;
  }
  function unlock(state, id) {
    const pro = state.pro;
    pro.ach = pro.ach || {};
    if (pro.ach[id]) return false;
    pro.ach[id] = { season: state.seasonYear, week: state.week };
    const a = ACHIEVEMENTS[id];
    message(state, `הישג חדש: ${a.ico} ${a.name}`, 'נוסף לאוסף ההישגים שלך.', { kind: 'pro' });
    pro.fame += 2;
    return true;
  }
  function checkPerks(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    pro.perks = pro.perks || [];
    const fresh = [];
    for (const [id, pk] of Object.entries(PERKS)) {
      if (!pro.perks.includes(id) && pk.test(p, pro)) {
        pro.perks.push(id);
        fresh.push(id);
        message(state, `יכולת חדשה: ${pk.name}!`, pk.desc, { kind: 'pro' });
      }
    }
    return fresh;
  }
  function checkMilestones(state) {
    const pro = state.pro;
    const t = careerTotals(state);
    if (t.app >= 1) unlock(state, 'debut');
    if (t.gl >= 1) unlock(state, 'first_goal');
    for (const n of [10, 50, 100, 200]) if (t.gl >= n) unlock(state, `goals_${n}`);
    for (const n of [50, 100, 250]) if (t.app >= n) unlock(state, `apps_${n}`);
    if (pro.caps >= 1) unlock(state, 'first_cap');
    if ((pro.intlGoals || 0) >= 1) unlock(state, 'intl_goal');
  }

  // Season objectives set by the club: goals/assists/apps/clean sheets and an average rating.
  function setObjectives(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    const club = state.clubs[p.c];
    const games = (state.fixtures[club.league] || []).length || 34;
    const diff = p.ovr - club.rep;
    const role = pro.contractRole || 'rotation';
    const roleF = role === 'star' ? 1.25 : role === 'prospect' ? 0.7 : 1;
    const key = proWeightKey(p.pos);
    const obj = [];
    const appT = Math.round(clamp(games * (0.45 + diff * 0.03) * roleF, 5, games * 0.85));
    obj.push({ type: 'app', label: 'הופעות', target: appT });
    if (key === 'A') obj.push({ type: 'gl', label: 'שערים', target: Math.round(clamp((games / 38) * (9 + diff * 0.9) * roleF, 2, 35)) });
    else if (key === 'W') { obj.push({ type: 'gl', label: 'שערים', target: Math.round(clamp((games / 38) * (5 + diff * 0.5) * roleF, 1, 25)) }); obj.push({ type: 'as', label: 'בישולים', target: Math.round(clamp((games / 38) * (5 + diff * 0.4) * roleF, 1, 20)) }); }
    else if (key === 'M') obj.push({ type: 'as', label: 'בישולים', target: Math.round(clamp((games / 38) * (4 + diff * 0.4) * roleF, 1, 18)) });
    else obj.push({ type: 'cs', label: 'שערים נקיים', target: Math.round(clamp(appT * 0.3, 2, 20)) });
    obj.push({ type: 'rt', label: 'ציון ממוצע', target: (role === 'star' ? 7.0 : 6.7) - (key === 'A' || key === 'W' ? 0 : 0.3) });
    pro.objectives = { season: state.seasonYear, club: p.c, list: obj };
  }
  function objectiveProgress(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    if (!pro.objectives) return [];
    return pro.objectives.list.map((o) => {
      const cur = o.type === 'rt' ? (p.st.app ? p.st.rt / p.st.app : 0) : p.st[o.type] || 0;
      return { ...o, current: o.type === 'rt' ? Math.round(cur * 100) / 100 : cur, done: cur >= o.target };
    });
  }

  function proAfterMatch(state, sim, ratings) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    const side = sim.sides[sim.proSide];
    const other = sim.sides[1 - sim.proSide];
    const mins = side.played[p.id] || 0;
    const rating = ratings[p.id];
    if (!mins) {
      p.morale = clamp(p.morale - 3, 10, 100);
      return { played: false };
    }
    pro.lastRatings.push(rating);
    if (pro.lastRatings.length > 8) pro.lastRatings.shift();
    const trainerF = pro.services && pro.services.trainer ? 1.25 : 1;
    const xp = Math.max(3, ((rating - 5.5) * 25 + mins / 6) * 0.45) * trainerF;
    // match XP is spread over the attributes used in the moments
    const used = new Set([pro.focus]);
    const tagAttr = { shot: 1, penalty: 1, pass: 2, dribble: 3, run: 0, tackle: 4, block: 4, aerial: 5, save: 3 };
    for (const l of sim.proLog) for (const t of l.tags || []) if (tagAttr[t] !== undefined) used.add(tagAttr[t]);
    const gains = [];
    for (const idx of used) gains.push(...trainingGain(state, idx, xp / used.size));
    pro.fame += Math.max(0, rating - 6.5) * 2 + (side.club.rep - 60) * 0.02;
    pro.fans = clamp((pro.fans === undefined ? 50 : pro.fans) + (rating - 6.6) * 3, 0, 100);
    pro.chem = pro.chem || {};
    pro.chem[p.c] = Math.min(100, (pro.chem[p.c] || 0) + 2);
    p.v = valueFor(p.ovr, p.age, p.pot);
    const goals = sim.events.filter((e) => e.type === 'goal' && e.scorer === p.id);
    if (goals.length >= 2) unlock(state, 'brace');
    if (goals.length >= 3) unlock(state, 'hat_trick');
    const late = goals.filter((e) => e.min >= 80).length;
    pro.lateGoals = (pro.lateGoals || 0) + late;
    if (late && side.goals === other.goals + 1 && goals.some((e) => e.min >= 85)) unlock(state, 'late_winner');
    checkMilestones(state);
    const newPerks = checkPerks(state);
    return {
      played: true, mins, rating, xp: Math.round(xp), gains, goals: goals.length,
      assists: sim.events.filter((e) => e.type === 'goal' && e.assist === p.id).length,
      decisions: sim.proLog.slice(), newPerks, score: [side.goals, other.goals], opp: other.club.name,
    };
  }

  function proTrain(state) {
    const it = TRAINING_INTENSITY[state.pro.intensity] || TRAINING_INTENSITY.normal;
    const club = state.clubs[state.players[state.pro.pid].c];
    const trainerF = state.pro.services && state.pro.services.trainer ? 1.25 : 1;
    const gains = trainingGain(state, state.pro.focus, 15 * it.dev * FACILITY_DEV[facilitiesOf(club)] * trainerF);
    const p = state.players[state.pro.pid];
    p.v = valueFor(p.ovr, p.age, p.pot);
    return gains;
  }

  function serviceCost(state, id) {
    const p = state.players[state.pro.pid];
    return Math.max(300, Math.round((p.w * SERVICES[id].weekly) / 100) * 100);
  }
  function toggleService(state, id) {
    const pro = state.pro;
    pro.services = pro.services || {};
    pro.services[id] = !pro.services[id];
    return pro.services[id];
  }
  function buy(state, id) {
    const pro = state.pro;
    const it = PURCHASES[id];
    pro.bought = pro.bought || {};
    if (!it || pro.bought[id]) return { ok: false, reason: 'כבר קנית.' };
    if ((pro.money || 0) < it.cost) return { ok: false, reason: `חסר לך ${money(it.cost - (pro.money || 0))}.` };
    pro.money -= it.cost;
    pro.bought[id] = state.seasonYear;
    pro.fame += it.fame || 0;
    if (it.fans) pro.fans = clamp((pro.fans || 50) + it.fans, 0, 100);
    const p = state.players[pro.pid];
    p.morale = clamp(p.morale + (it.morale || 0), 0, 100);
    return { ok: true, reason: `קנית ${it.name}!` };
  }

  function proWeekly(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    for (const g of proTrain(state)) {
      message(state, 'השתפרת באימונים!', `${(p.pos === 'GK' ? GK_ATTR_HE : ATTR_HE)[g.idx]} עלה. הדירוג הכללי שלך: ${g.ovr}.`, { kind: 'pro' });
    }
    checkPerks(state);
    // services cost money every week
    for (const id of Object.keys(pro.services || {})) {
      if (!pro.services[id]) continue;
      const c = serviceCost(state, id);
      if ((pro.money || 0) < c) {
        pro.services[id] = false;
        message(state, `${SERVICES[id].name} הפסיק לעבוד איתך`, 'לא היה מספיק כסף בחשבון.', { kind: 'pro' });
      } else pro.money -= c;
    }
    if (pro.services && pro.services.psych) p.morale = clamp(p.morale + 1, 0, 100);
    if (pro.services && pro.services.physio && p.inj > 0) p.inj--;
    pro.chem = pro.chem || {};
    pro.chem[p.c] = Math.min(100, (pro.chem[p.c] || 0) + 0.5);
    if (pro.perks && pro.perks.includes('leader')) squad(state, p.c).forEach((x) => { x.morale = clamp(x.morale + 0.3, 0, 100); });
    // national team windows
    if ([10, 18, 30].includes(state.week) && !pro.loanActive) maybeCallUp(state);
    // transfer offers
    if (!windowOpen(state) || pro.offers.length) return;
    const avg = pro.lastRatings.length ? pro.lastRatings.reduce((s, v) => s + v, 0) / pro.lastRatings.length : 0;
    const club = state.clubs[p.c];
    const wants = pro.transferRequest;
    const eligible = pro.lastRatings.length >= 4 && (avg >= 6.9 || (wants && avg >= 6.5)) && p.ovr >= club.rep - (wants ? 6 : 3);
    if (eligible && rnd() < (wants ? 0.6 : 0.35)) {
      const offers = Object.values(state.clubs).filter((c) => c.id !== club.id && (c.rep > club.rep || wants) && c.rep <= p.ovr + (wants ? 3 : 5) && c.rep >= p.ovr - 12);
      const o = shuffle(offers).slice(0, rint(1, 2));
      for (const c of o) {
        const fee = Math.round((p.v * (1 + rnd() * 0.4)) / 10000) * 10000;
        const wage = Math.round(Math.max(p.w * 1.3, wageFor(p.ovr)) / 100) * 100;
        pro.offers.push({ club: c.id, fee, wage });
        message(state, `${c.name} רוצה אותך!`, `${c.name} הגישה הצעה של ${money(fee)} לקבוצה שלך. שכר פתיחה: ${money(wage)} לשבוע. אפשר לנהל משא ומתן.`, { kind: 'proOffer', offer: { club: c.id, fee, wage } });
      }
    }
  }

  // Contract negotiation on a transfer offer. wage: 'low' | 'fair' | 'high'; role: 'star' | 'rotation' | 'prospect'
  function proNegotiate(state, clubId, terms) {
    const pro = state.pro;
    const offer = pro.offers.find((o) => o.club === clubId);
    if (!offer) return { ok: false, text: 'ההצעה כבר לא בתוקף.' };
    const p = state.players[pro.pid];
    const club = state.clubs[clubId];
    const wageF = { low: 0.9, fair: 1, high: 1.35 }[terms.wage] || 1;
    let prob = { low: 0.97, fair: 0.85, high: 0.5 }[terms.wage] || 0.85;
    if (terms.role === 'star') prob -= p.ovr >= club.rep + 2 ? 0.05 : 0.45;
    if (terms.role === 'prospect' && p.age > 22) prob -= 0.3;
    if (terms.clause) prob -= 0.12;
    prob += Math.min(0.1, (pro.fame || 0) / 400);
    if (rnd() > clamp(prob, 0.05, 0.99)) {
      pro.offers = pro.offers.filter((o) => o.club !== clubId);
      for (const m of state.inbox) if (m.kind === 'proOffer' && m.offer.club === clubId) m.done = 'rejected';
      return { ok: false, text: `${club.name} לא הסכימה לתנאים וסגרה את המשא ומתן.` };
    }
    offer.wage = Math.round((offer.wage * wageF) / 100) * 100;
    const text = proAcceptOffer(state, clubId);
    pro.contractRole = terms.role || 'rotation';
    pro.releaseClause = terms.clause ? Math.round((p.v * 2) / 100000) * 100000 : null;
    pro.trust = terms.role === 'star' ? 70 : terms.role === 'prospect' ? 55 : 50;
    pro.transferRequest = false;
    setObjectives(state);
    return { ok: true, text: `${text} שכר: ${money(p.w)} לשבוע, מעמד: ${{ star: 'כוכב', rotation: 'רוטציה', prospect: 'צעיר מבטיח' }[pro.contractRole]}.` };
  }

  function requestTransfer(state) {
    const pro = state.pro;
    pro.transferRequest = true;
    pro.trust = clamp((pro.trust || 50) - 10, 0, 100);
    return 'ביקשת העברה. המאמן לא מרוצה (אמון -10), אבל בחלון ההעברות יגיעו יותר הצעות.';
  }
  function requestLoan(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    if (pro.loanActive) return { ok: false, text: 'אתה כבר בהשאלה.' };
    if (!windowOpen(state)) return { ok: false, text: 'אפשר לצאת להשאלה רק כשחלון ההעברות פתוח.' };
    if (p.age > 23) return { ok: false, text: 'השאלות מיועדות לשחקנים עד גיל 23.' };
    const parent = state.clubs[p.c];
    const cands = Object.values(state.clubs).filter((c) => c.id !== parent.id && c.rep <= p.ovr + 2 && c.rep >= p.ovr - 7);
    if (!cands.length) return { ok: false, text: 'לא נמצאה קבוצה מתאימה.' };
    const club = pick(cands);
    pro.career.push({ season: state.seasonYear, club: p.c, st: { ...p.st }, partial: true });
    p.st = emptyStats();
    pro.loanActive = { parent: parent.id, season: state.seasonYear };
    p.c = club.id;
    pro.trust = 60;
    parent.lineup = null;
    return { ok: true, text: `יצאת להשאלה ${pre('ל', club.name)} עד סוף העונה. שם תקבל דקות משחק.` };
  }

  function proAcceptOffer(state, clubId) {
    const pro = state.pro;
    const offer = pro.offers.find((o) => o.club === clubId);
    if (!offer) return null;
    const p = state.players[pro.pid];
    const from = state.clubs[pro.loanActive ? pro.loanActive.parent : p.c];
    from.balance += offer.fee;
    state.clubs[clubId].balance -= offer.fee;
    pro.career.push({ season: state.seasonYear, club: p.c, st: { ...p.st }, partial: true });
    p.st = emptyStats();
    p.c = clubId;
    p.w = offer.wage;
    p.ctr = state.seasonYear + 4;
    p.morale = 85;
    pro.offers = [];
    pro.loanActive = null;
    pro.captain = null;
    if (pro.perks) pro.perks = pro.perks.filter((x) => x !== 'leader');
    for (const m of state.inbox) if (m.kind === 'proOffer') m.done = m.offer.club === clubId ? 'accepted' : 'rejected';
    from.lineup = null;
    initMonth(state);
    return `עברת ${pre('ל', state.clubs[clubId].name)}!`;
  }
  function proDeclineOffers(state) {
    state.pro.offers = [];
    for (const m of state.inbox) if (m.kind === 'proOffer' && !m.done) m.done = 'rejected';
  }

  // ----- national team -----
  function callUpThreshold(nat) {
    return nationStrength(nat) - 8;
  }
  function maybeCallUp(state) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    if (p.inj > 0 || p.ovr < callUpThreshold(p.nat)) return;
    const kind = state.week === 18 ? 'qualifier' : rnd() < 0.5 ? 'friendly' : 'qualifier';
    state.pendingIntl = newIntlMatch(state, { kind, label: kind === 'friendly' ? 'משחק ידידות' : 'משחק מוקדמות' });
    message(state, 'זימון לנבחרת!', `נבחרת ${p.nat} זימנה אותך ל${state.pendingIntl.label} מול ${state.pendingIntl.opp.name}.`, { kind: 'pro' });
  }
  function newIntlMatch(state, o) {
    const p = state.players[state.pro.pid];
    const us = nationStrength(p.nat);
    const oppStrength = clamp(Math.round(us + gauss() * 5 + (o.stageBoost || 0)), 62, 88);
    return {
      kind: o.kind, label: o.label, tournament: o.tournament || null, stage: o.stage || 0, group: o.group || null,
      opp: { name: pick(INTL_OPPONENTS), strength: oppStrength }, us, idx: 0, gf: 0, ga: 0, log: [], moments: 3,
      current: null, done: false,
    };
  }
  function intlMoment(state) {
    const im = state.pendingIntl;
    const p = state.players[state.pro.pid];
    const [pac, sho, pas, dri, def, phy] = p.at;
    const edge = (im.us - im.opp.strength) / 60;
    const P = (attr, base) => clamp(base + (attr - im.opp.strength) / 70 + edge, 0.08, 0.9);
    if (p.pos === 'GK') {
      return { title: 'החלוץ היריב בועט!', desc: `${im.opp.name} מאיימת על השער שלך.`, options: [
        { label: 'זינוק לפינה', effect: 'save', p: P(p.at[0], 0.5) },
        { label: 'לצאת ולסגור זווית', effect: 'save', p: P(p.at[5], 0.48) },
      ] };
    }
    const group = proWeightKey(p.pos);
    if (group === 'D' || (group === 'DM' && rnd() < 0.6) || rnd() < 0.2) {
      return { title: 'התקפה של היריבה', desc: `קשר של ${im.opp.name} מוביל לעבר הרחבה שלכם.`, options: [
        { label: 'תיקול', effect: 'defend', p: P(def, 0.45) },
        { label: 'לחסום את הבעיטה', effect: 'defend', p: P((def + phy) / 2, 0.52) },
      ] };
    }
    return { title: 'יש לך הזדמנות!', desc: `הכדור אצלך מול ההגנה של ${im.opp.name}.`, options: [
      { label: 'לבעוט', effect: 'goal', p: P(sho, 0.3) },
      { label: 'לכדרר ולבעוט', effect: 'goal', p: P((dri + sho) / 2, 0.26) },
      { label: 'מסירה לחלוץ', effect: 'assist', p: P(pas, 0.42) },
    ] };
  }
  function intlNext(state) {
    const im = state.pendingIntl;
    if (!im || im.done) return null;
    if (im.idx >= im.moments) return finishIntl(state);
    im.current = intlMoment(state);
    return im.current;
  }
  function answerIntl(state, optIdx) {
    const im = state.pendingIntl;
    if (!im || !im.current) return null;
    const opt = im.current.options[optIdx];
    const ok = rnd() < opt.p;
    let text;
    if (opt.effect === 'goal') {
      if (ok) { im.gf++; state.pro.intlGoals = (state.pro.intlGoals || 0) + 1; text = 'גוול! כבשת לנבחרת!'; } else text = 'ההזדמנות לא נוצלה.';
    } else if (opt.effect === 'assist') {
      if (ok && rnd() < 0.6) { im.gf++; text = 'בישלת שער לנבחרת!'; } else text = ok ? 'מסירה טובה, אבל החלוץ החמיץ.' : 'המסירה נחתכה.';
    } else if (ok) text = opt.effect === 'save' ? 'הצלה גדולה!' : 'עצרת את ההתקפה!';
    else if (rnd() < 0.45) { im.ga++; text = 'היריבה כבשה...'; } else text = 'היריבה החמיצה, מזל.';
    im.log.push({ q: im.current.title, a: opt.label, ok, text });
    im.idx++;
    im.current = null;
    return { ok, text };
  }
  function poissonish(lambda) {
    let k = 0;
    let p = Math.exp(-lambda);
    let s = p;
    const u = rnd();
    while (u > s && k < 8) { k++; p *= lambda / k; s += p; }
    return k;
  }
  function finishIntl(state) {
    const im = state.pendingIntl;
    const ratio = im.us / im.opp.strength;
    im.gf += poissonish(1.05 * Math.pow(ratio, 3));
    im.ga += poissonish(1.0 / Math.pow(ratio, 3));
    const knockout = im.tournament && im.stage >= 3;
    if (knockout && im.gf === im.ga) {
      im.pens = rnd() < 0.5 + (im.us - im.opp.strength) / 60;
    }
    const won = im.gf > im.ga || im.pens === true;
    const pro = state.pro;
    pro.caps = (pro.caps || 0) + 1;
    pro.fame += won ? 2 : 0.5;
    im.done = true;
    im.result = won ? 'W' : im.gf === im.ga && !knockout ? 'D' : 'L';
    checkMilestones(state);
    return null;
  }
  // After a finished intl match: continue a tournament or clear it.
  function closeIntl(state) {
    const im = state.pendingIntl;
    if (!im || !im.done) return null;
    if (!im.tournament) {
      state.pendingIntl = null;
      return { over: true };
    }
    const t = im.tournament;
    t.results.push({ stage: im.stage, opp: im.opp.name, gf: im.gf, ga: im.ga, pens: im.pens, result: im.result });
    const stages = ['שלב הבתים 1', 'שלב הבתים 2', 'שלב הבתים 3', 'שמינית הגמר', 'רבע הגמר', 'חצי הגמר', 'הגמר'];
    let next = im.stage + 1;
    if (im.stage === 2) {
      const pts = t.results.reduce((s, r) => s + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);
      if (pts < 4 && !(pts === 3 && rnd() < 0.5)) {
        state.pendingIntl = null;
        return { over: true, text: `הנבחרת הודחה בשלב הבתים של ${t.name} (${pts} נקודות).` };
      }
    } else if (im.stage >= 3 && im.result !== 'W') {
      state.pendingIntl = null;
      return { over: true, text: `הנבחרת הודחה ב${stages[im.stage]} של ${t.name}.` };
    }
    if (next >= stages.length) {
      state.pendingIntl = null;
      unlock(state, 'tournament_win');
      state.pro.fame += 40;
      return { over: true, won: true, text: `זכיתם ב${t.name}!!! 🏆` };
    }
    state.pendingIntl = newIntlMatch(state, { kind: 'tournament', label: `${t.name} - ${stages[next]}`, tournament: t, stage: next, stageBoost: next >= 3 ? next : 0 });
    return { over: false };
  }
  function maybeTournament(state) {
    const pro = state.pro;
    if (!pro) return;
    const p = state.players[pro.pid];
    const year = state.seasonYear + 1; // summer after the season
    const name = year % 4 === 2 ? `מונדיאל ${year}` : year % 4 === 0 ? `יורו ${year}` : null;
    if (!name || p.ovr < callUpThreshold(p.nat) || p.inj > 0) return;
    const qualified = nationStrength(p.nat) >= 76 || rnd() < 0.35;
    if (!qualified) {
      message(state, `הנבחרת לא העפילה ל${name}`, 'בפעם הבאה...', { kind: 'pro' });
      return;
    }
    const t = { name, results: [] };
    state.pendingIntl = newIntlMatch(state, { kind: 'tournament', label: `${name} - שלב הבתים 1`, tournament: t, stage: 0 });
    message(state, `נבחרת ${p.nat} ב${name}!`, 'נבחרת לסגל לטורניר.', { kind: 'pro' });
  }

  // ----- injuries outside matches -----
  function answerInjury(state, playThrough) {
    const inj = state.pendingInjury;
    if (!inj) return null;
    const p = state.players[state.pro.pid];
    state.pendingInjury = null;
    if (playThrough) {
      p.inj = 0;
      state.pro.painRisk = 0.35;
      return 'תשחק דרך הכאב. יש סיכון שהפציעה תחמיר.';
    }
    p.inj = inj.weeks;
    return `תנוח ${inj.weeks} שבועות.`;
  }

  function proSeasonEnd(state, summary) {
    const pro = state.pro;
    const p = state.players[pro.pid];
    // objectives
    const prog = objectiveProgress(state);
    if (prog.length) {
      const met = prog.filter((o) => o.done).length;
      const bonus = met * Math.round(p.w * 6);
      pro.money = (pro.money || 0) + bonus;
      pro.trust = clamp((pro.trust || 50) + (met - (prog.length - met)) * 4, 0, 100);
      summary.proObjectives = { list: prog, met, bonus };
      if (met === prog.length) unlock(state, 'objectives');
    }
    pro.career.push({ season: state.seasonYear, club: p.c, st: { ...p.st }, loan: !!pro.loanActive });
    summary.pro = { club: p.c, st: { ...p.st }, ovr: p.ovr };
    pro.offers = [];
    // club honours
    const lg = state.clubs[p.c].league;
    if (summary.champions[lg] === p.c) unlock(state, 'champion');
    if ((summary.promoted[lg] || []).includes(p.c)) unlock(state, 'promoted');
    if (summary.topScorers[lg] && summary.topScorers[lg].pid === p.id) unlock(state, 'golden_boot');
    const aw = summary.awards || {};
    if (aw.season && aw.season[lg] && aw.season[lg].pid === p.id) unlock(state, 'player_season');
    if (aw.young && aw.young[lg] && aw.young[lg].pid === p.id) unlock(state, 'young_player');
    if (aw.ballon) {
      const idx = aw.ballon.findIndex((b) => b.pid === p.id);
      if (idx === 0) { unlock(state, 'ballon_dor'); pro.fame += 50; }
      if (idx >= 0 && idx <= 2) unlock(state, 'ballon_podium');
    }
    // loan ends
    if (pro.loanActive) {
      p.c = pro.loanActive.parent;
      pro.loanActive = null;
      pro.trust = 55;
      message(state, 'חזרת מההשאלה', `חזרת ${pre('ל', state.clubs[p.c].name)}.`, { kind: 'pro' });
    }
    pro.transferRequest = false;
    maybeTournament(state);
  }

  // Season awards for every league plus a Ballon d'Or across all six countries.
  function seasonAwards(state, champions) {
    const season = {};
    const young = {};
    const ballon = [];
    for (const lg of state.leagues) {
      const games = (state.fixtures[lg.id] || []).length || 34;
      let best = null;
      let bestY = null;
      for (const p of Object.values(state.players)) {
        const c = state.clubs[p.c];
        if (!c || c.league !== lg.id || p.st.app < games * 0.5) continue;
        const score = p.st.rt / p.st.app + p.st.gl * 0.02 + p.st.as * 0.015;
        const entry = { pid: p.id, name: p.n, club: p.c, rating: Math.round((p.st.rt / p.st.app) * 100) / 100, gl: p.st.gl, as: p.st.as, score };
        if (!best || score > best.score) best = entry;
        if (p.age <= 21 && (!bestY || score > bestY.score)) bestY = entry;
        if (lg.tier === 1) {
          const b = entry.rating * 10 + p.st.gl * 0.6 + p.st.as * 0.35 + (champions[lg.id] === p.c ? 8 : 0) + p.ovr * 0.25 + (lg.rep / 100) * 8;
          ballon.push({ ...entry, score: b });
        }
      }
      if (best) season[lg.id] = best;
      if (bestY) young[lg.id] = bestY;
    }
    ballon.sort((a, b) => b.score - a.score);
    return { season, young, ballon: ballon.slice(0, 5) };
  }

  // ---------- monthly cycle: review, awards, board confidence, decisions, training ----------
  const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const TRAINING_FOCUS = {
    balanced: { label: 'מאוזן', desc: 'התפתחות כללית בלי דגש מיוחד.' },
    attack: { label: 'התקפה', desc: '+2% לכוח ההתקפי במשחקים. משפר בעיטה וכדרור.' },
    defense: { label: 'הגנה', desc: '+2% להגנה במשחקים. משפר הגנה ופיזיות.' },
    tactical: { label: 'טקטיקה', desc: '+2% לשליטה במשחק. משפר מסירה.' },
    fitness: { label: 'כושר', desc: 'עייפות נמוכה יותר במשחקים, התאוששות מהירה ופחות פציעות.' },
    youth: { label: 'פיתוח צעירים', desc: 'שחקנים עד גיל 23 מתפתחים מהר יותר, הוותיקים פחות.' },
    rest: { label: 'מנוחה', desc: 'מורל והתאוששות גבוהים. כמעט בלי התפתחות.' },
  };
  const TRAINING_INTENSITY = {
    light: { label: 'קל', dev: 0.7, recovery: 34, injury: 0.0008 },
    normal: { label: 'רגיל', dev: 1, recovery: 28, injury: 0.0018 },
    intense: { label: 'אינטנסיבי', dev: 1.35, recovery: 22, injury: 0.0045 },
  };
  const FOCUS_ATTRS = { attack: [1, 3], defense: [4, 5], tactical: [2], fitness: [0, 5] };

  function monthKeyOf(state, week) {
    const d = weekDate(state, week);
    return d.getUTCFullYear() * 12 + d.getUTCMonth();
  }
  function monthLabel(key) {
    return `${MONTHS_HE[key % 12]} ${Math.floor(key / 12)}`;
  }
  // Training facilities: level 1-5, multiplies monthly development of the whole squad.
  const FACILITY_DEV = [0, 0.85, 1, 1.12, 1.24, 1.36];
  function facilitiesOf(club) {
    if (!club.facilities) club.facilities = club.rep >= 80 ? 4 : club.rep >= 72 ? 3 : club.rep >= 62 ? 2 : 1;
    return club.facilities;
  }
  function facilityUpgradeCost(club) {
    const lvl = facilitiesOf(club);
    if (lvl >= 5) return null;
    return Math.round((club.income * 2.2 * Math.pow(lvl, 1.2)) / 10000) * 10000;
  }
  function upgradeFacilities(state, clubId) {
    const club = state.clubs[clubId];
    const cost = facilityUpgradeCost(club);
    if (cost === null) return { ok: false, reason: 'המתקנים כבר ברמה המקסימלית.' };
    if (club.balance < cost) return { ok: false, reason: `השדרוג עולה ${money(cost)} ואין מספיק כסף.` };
    club.balance -= cost;
    club.facilities++;
    return { ok: true, reason: `מתקני האימון שודרגו לרמה ${club.facilities}.` };
  }
  // Individual plan: { type: 'attr', idx } or { type: 'pos', pos, progress }
  function setPlayerPlan(state, pid, plan) {
    const p = state.players[pid];
    if (!p) return;
    if (!plan) delete p.plan;
    else if (plan.type === 'attr' && plan.idx >= 0 && plan.idx <= 5) p.plan = { type: 'attr', idx: plan.idx };
    else if (plan.type === 'pos' && GROUP[plan.pos] && plan.pos !== p.pos && !(p.alt || []).includes(plan.pos)) p.plan = { type: 'pos', pos: plan.pos, progress: 0 };
  }

  function trainingOf(club) {
    return club.training || { focus: 'balanced', intensity: 'normal' };
  }
  function focusClubId(state) {
    if (state.mode === 'manager' && state.user) return state.user.clubId;
    if (state.pro) return state.players[state.pro.pid].c;
    return null;
  }

  // Snapshot of the league table, the club's balance and player stats, diffed at month end.
  function initMonth(state) {
    state.monthKey = monthKeyOf(state, state.week);
    const clubId = focusClubId(state);
    if (!clubId) return;
    const lg = state.clubs[clubId].league;
    const table = {};
    for (const [id, r] of Object.entries(state.tables[lg])) table[id] = { ...r };
    const players = {};
    for (const p of Object.values(state.players)) {
      if (state.clubs[p.c] && state.clubs[p.c].league === lg) players[p.id] = [p.st.app, p.st.rt, p.st.gl, p.st.as];
    }
    const pos = sortedTable(state, lg).findIndex((r) => r.id === clubId) + 1;
    state.monthSnap = { clubId, league: lg, table, players, balance: state.clubs[clubId].balance, pos, ovr: state.pro ? state.players[state.pro.pid].ovr : null, fame: state.pro ? state.pro.fame : 0 };
  }

  function weeklyTraining(state) {
    for (const c of Object.values(state.clubs)) {
      const tr = trainingOf(c);
      const it = TRAINING_INTENSITY[tr.intensity] || TRAINING_INTENSITY.normal;
      const rec = it.recovery + (tr.focus === 'fitness' ? 4 : 0) + (tr.focus === 'rest' ? 8 : 0);
      const injP = it.injury * (tr.focus === 'fitness' ? 0.6 : 1) * (tr.focus === 'rest' ? 0.4 : 1);
      for (const p of squad(state, c.id)) {
        if (state.pro && p.id === state.pro.pid) continue;
        p.cond = Math.min(100, p.cond + rec);
        if (tr.focus === 'rest') p.morale = Math.min(100, p.morale + 1);
        if (p.inj <= 0 && rnd() < injP) {
          p.inj = rint(1, 4);
          if (state.mode === 'manager' && state.user && c.id === state.user.clubId) {
            message(state, `${p.n} נפצע באימון`, `${p.n} ייעדר כ-${p.inj} שבועות.`, { kind: 'injury' });
          }
        }
      }
    }
    if (state.pro) {
      const p = state.players[state.pro.pid];
      const it = TRAINING_INTENSITY[state.pro.intensity] || TRAINING_INTENSITY.normal;
      p.cond = Math.min(100, p.cond + it.recovery);
      const nut = state.pro.services && state.pro.services.nutrition ? 0.5 : 1;
      if (p.inj <= 0 && !state.pendingInjury && rnd() < it.injury * 1.5 * nut) {
        state.pendingInjury = { weeks: rint(1, 3) };
      }
    }
  }

  // Returns a report for `reportClub`: who improved, declined and learned a position.
  function monthlyDevelopment(state, reportClub) {
    const report = { up: [], down: [], learned: [], progress: [] };
    for (const p of Object.values(state.players)) {
      if (state.pro && p.id === state.pro.pid) continue;
      const club = state.clubs[p.c];
      if (!club) continue;
      const mine = p.c === reportClub;
      const tr = trainingOf(club);
      const it = TRAINING_INTENSITY[tr.intensity] || TRAINING_INTENSITY.normal;
      let chance = p.age <= 21 ? 0.3 : p.age <= 24 ? 0.18 : p.age <= 28 ? 0.05 : 0;
      if (tr.focus === 'youth') chance *= p.age <= 23 ? 1.45 : 0.6;
      if (tr.focus === 'rest') chance *= 0.3;
      chance *= it.dev * FACILITY_DEV[facilitiesOf(club)];
      const plan = p.plan;
      if (plan && plan.type === 'attr') chance *= 1.5;
      if (plan && plan.type === 'pos') {
        const gain = Math.round(28 * it.dev * FACILITY_DEV[facilitiesOf(club)] * (p.age <= 24 ? 1.25 : p.age >= 30 ? 0.75 : 1) * (tr.focus === 'tactical' ? 1.2 : 1));
        plan.progress = Math.min(100, plan.progress + gain);
        if (plan.progress >= 100) {
          p.alt = (p.alt || []).concat(plan.pos);
          if (mine) report.learned.push({ pid: p.id, name: p.n, pos: plan.pos });
          delete p.plan;
        } else if (mine) report.progress.push({ pid: p.id, name: p.n, pos: plan.pos, progress: plan.progress });
        chance *= 0.7; // time spent learning a position is not spent improving
      }
      if (p.ovr < p.pot && rnd() < chance) {
        const from = p.ovr;
        p.ovr++;
        const idxs = plan && plan.type === 'attr' ? [plan.idx, plan.idx] : FOCUS_ATTRS[tr.focus] || [rint(0, 5)];
        for (const i of idxs) if (!(p.pos === 'GK' && i === 4 && !(plan && plan.type === 'attr'))) p.at[i] = Math.min(99, p.at[i] + 1);
        p.v = valueFor(p.ovr, p.age, p.pot);
        if (mine) report.up.push({ pid: p.id, name: p.n, from, to: p.ovr, attr: plan && plan.type === 'attr' ? plan.idx : null });
      } else if (p.age >= 31 && rnd() < 0.06 * (tr.intensity === 'intense' ? 1.3 : 1) / Math.max(0.8, FACILITY_DEV[facilitiesOf(club)])) {
        const from = p.ovr;
        p.ovr = Math.max(40, p.ovr - 1);
        p.v = valueFor(p.ovr, p.age, p.pot);
        if (mine) report.down.push({ pid: p.id, name: p.n, from, to: p.ovr });
      }
    }
    return report;
  }

  function expectedPpg(state, clubId, expected) {
    const n = clubsIn(state, state.clubs[clubId].league).length;
    return 2.2 - ((expected - 1) / Math.max(1, n - 1)) * 1.45;
  }

  function monthTurn(state) {
    const snap = state.monthSnap;
    const label = monthLabel(state.monthKey);
    const devClub = state.mode === 'manager' && state.user ? state.user.clubId : null;
    const trainingReport = monthlyDevelopment(state, devClub);
    const review = { key: state.monthKey, label, mode: state.mode, decisions: [], news: [], trainingReport: devClub ? trainingReport : null };
    if (snap && state.clubs[snap.clubId]) {
      const clubId = snap.clubId;
      const lg = snap.league;
      const table = state.tables[lg];
      const diff = (id) => {
        const a = table[id];
        const b = snap.table[id] || { p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0 };
        return { p: a.p - b.p, w: a.w - b.w, d: a.d - b.d, l: a.l - b.l, gf: a.gf - b.gf, ga: a.ga - b.ga, pts: a.pts - b.pts };
      };
      const cur = state.players[state.pro ? state.pro.pid : 0];
      const clubNow = state.pro ? cur.c : clubId;
      if (table[clubNow]) {
        const me = diff(clubNow);
        review.club = { id: clubNow, ...me, posFrom: snap.pos, posTo: sortedTable(state, lg).findIndex((r) => r.id === clubNow) + 1, balanceDelta: state.clubs[clubNow].balance - snap.balance };
      }
      // player of the month (the user's club and the whole league)
      const month = [];
      for (const p of Object.values(state.players)) {
        const s0 = snap.players[p.id];
        if (!s0 || !state.clubs[p.c] || state.clubs[p.c].league !== lg) continue;
        const app = p.st.app - s0[0];
        if (app < 2) continue;
        month.push({ pid: p.id, name: p.n, club: p.c, app, rating: Math.round(((p.st.rt - s0[1]) / app) * 100) / 100, gl: p.st.gl - s0[2], as: p.st.as - s0[3] });
      }
      month.sort((a, b) => b.rating - a.rating || b.gl - a.gl);
      review.leaguePotm = month[0] || null;
      review.clubPotm = month.find((m) => m.club === clubNow) || null;
      // manager of the month: most points in the league this month
      const byPts = Object.keys(table).map((id) => ({ id, ...diff(id) })).filter((r) => r.p > 0)
        .sort((a, b) => b.pts / b.p - a.pts / a.p || (b.gf - b.ga) - (a.gf - a.ga));
      if (byPts.length) review.motm = { clubId: byPts[0].id, pts: byPts[0].pts, p: byPts[0].p };

      if (state.mode === 'manager' && state.user) {
        const u = state.user;
        if (u.confidence === undefined) u.confidence = 60;
        const from = u.confidence;
        const reasons = [];
        let delta = 0;
        if (review.club && review.club.p > 0) {
          const ppg = review.club.pts / review.club.p;
          const exp = expectedPpg(state, clubId, u.expected);
          const d = clamp(Math.round((ppg - exp) * 14), -14, 12);
          delta += d;
          reasons.push(`${review.club.pts} נקודות מ-${review.club.p} משחקים (${d >= 0 ? '+' : ''}${d})`);
        }
        const bal = state.clubs[clubId].balance;
        if (bal < 0) {
          delta -= 5;
          reasons.push('יתרה שלילית (-5)');
        }
        if (review.motm && review.motm.clubId === clubId) {
          delta += 5;
          reasons.push('מאמן החודש (+5)');
          review.userMotm = true;
          message(state, 'מאמן החודש!', `זכית בפרס מאמן החודש של ${label}.`, { kind: 'board' });
        }
        u.confidence = clamp(from + delta + (u.confidenceBonus || 0), 0, 100);
        if (u.confidenceBonus) reasons.push(`החלטות החודש (${u.confidenceBonus > 0 ? '+' : ''}${u.confidenceBonus})`);
        u.confidenceBonus = 0;
        review.confidence = { from, to: u.confidence, reasons };
        if (u.confidence < 12) review.fired = true;
        // promises made last month
        for (const p of squad(state, clubId)) {
          if (!p.promise) continue;
          const s0 = snap.players[p.id];
          const apps = s0 ? p.st.app - s0[0] : p.st.app;
          if (apps < 2) {
            p.morale = clamp(p.morale - 30, 5, 100);
            review.news.push(`${p.n} כועס: הבטחת לו דקות משחק ולא עמדת בזה.`);
          }
          p.promise = 0;
        }
      }
      if (state.pro) {
        const pro = state.pro;
        const s0 = snap.players[cur.id] || [0, 0, 0, 0];
        const app = cur.st.app - s0[0];
        review.pro = {
          app, gl: cur.st.gl - s0[2], as: cur.st.as - s0[3], rating: app ? Math.round(((cur.st.rt - s0[1]) / app) * 100) / 100 : 0,
          ovrFrom: snap.ovr, ovrTo: cur.ovr, fame: Math.round(pro.fame - snap.fame),
        };
        if (review.leaguePotm && review.leaguePotm.pid === cur.id) {
          review.pro.award = true;
          pro.fame += 10;
          pro.awards = (pro.awards || 0) + 1;
          message(state, 'שחקן החודש!', `נבחרת לשחקן החודש של ${label} בליגה.`, { kind: 'pro' });
        }
      }
    }
    review.decisions = pickDecisions(state);
    review.training = state.mode === 'manager' && state.user ? { ...trainingOf(state.clubs[state.user.clubId]) } : state.pro ? { focus: state.pro.focus, intensity: state.pro.intensity || 'normal' } : null;
    state.pendingMonth = review;
    initMonth(state);
    return review;
  }

  function closeMonth(state) {
    const r = state.pendingMonth;
    if (!r) return true;
    if (r.decisions.some((d) => d.answer === null)) return false;
    state.monthHistory = state.monthHistory || [];
    state.monthHistory.unshift({ key: r.key, label: r.label, club: r.club, confidence: r.confidence, pro: r.pro, decisions: r.decisions.map((d) => ({ title: d.title, choice: d.options[d.answer].label, result: d.result })) });
    if (state.monthHistory.length > 40) state.monthHistory.length = 40;
    state.pendingMonth = null;
    return true;
  }

  function setTraining(state, focus, intensity) {
    if (state.mode === 'manager') {
      const c = state.clubs[state.user.clubId];
      c.training = { focus: TRAINING_FOCUS[focus] ? focus : 'balanced', intensity: TRAINING_INTENSITY[intensity] ? intensity : 'normal' };
    } else if (state.pro) {
      if (typeof focus === 'number') state.pro.focus = focus;
      if (TRAINING_INTENSITY[intensity]) state.pro.intensity = intensity;
    }
  }

  // ----- decisions -----
  const pickP = (state, pid) => state.players[pid];
  const DECISIONS = {
    unhappy: {
      mode: 'manager', weight: 3,
      find(state, club) {
        const snap = state.monthSnap;
        const sq = squad(state, club.id).sort((a, b) => b.ovr - a.ovr).slice(0, 16);
        const c = sq.filter((p) => !p.promise && p.inj <= 0 && p.morale < 70 && (!snap.players[p.id] || p.st.app - snap.players[p.id][0] <= 1));
        const p = c.length ? pick(c) : null;
        return p ? { pid: p.id } : null;
      },
      build: (state, { pid }) => ({
        title: `${pickP(state, pid).n} לא מרוצה`, body: `${pickP(state, pid).n} דופק על הדלת: הוא כמעט לא משחק ורוצה לדעת מה העתיד שלו.`,
        options: [
          { label: 'להבטיח לו דקות', hint: 'מורל +25. אם לא ישחק לפחות 2 משחקים בחודש הבא, המורל יקרוס.' },
          { label: 'להכניס לרשימת העברות', hint: 'יגיעו הצעות. מורל -5.' },
          { label: 'להגיד לו להילחם על מקומו', hint: 'מורל -12.' },
        ],
      }),
      apply(state, { pid }, o) {
        const p = pickP(state, pid);
        if (!p) return 'השחקן כבר לא במועדון.';
        if (o === 0) { p.morale = clamp(p.morale + 25, 0, 100); p.promise = 1; return `${p.n} מרוצה. עכשיו צריך לעמוד בהבטחה.`; }
        if (o === 1) { p.listed = true; p.morale = clamp(p.morale - 5, 0, 100); return `${p.n} ברשימת ההעברות.`; }
        p.morale = clamp(p.morale - 12, 0, 100);
        return `${p.n} יצא מהחדר מאוכזב.`;
      },
    },
    contract: {
      mode: 'manager', weight: 3,
      find(state, club) {
        const sq = squad(state, club.id).sort((a, b) => b.ovr - a.ovr).slice(0, 6).filter((p) => p.ctr <= state.seasonYear + 1 && !p.renewAsked);
        return sq.length ? { pid: sq[0].id } : null;
      },
      build: (state, { pid }) => {
        const p = pickP(state, pid);
        return {
          title: `${p.n} רוצה חוזה חדש`, body: `החוזה של ${p.n} מסתיים ב-${p.ctr}. הסוכן שלו דורש העלאה של 30% בשכר (${money(Math.round(p.w * 1.3))} לשבוע).`,
          options: [
            { label: 'לחתום בתנאים שלו', hint: 'חוזה ל-3 שנים נוספות, מורל +10.' },
            { label: 'להציע 15%', hint: 'סיכוי של כ-50% שיסכים.' },
            { label: 'לסרב', hint: 'מורל -25, השחקן יבקש לעזוב.' },
          ],
        };
      },
      apply(state, { pid }, o) {
        const p = pickP(state, pid);
        if (!p) return 'השחקן כבר לא במועדון.';
        p.renewAsked = 1;
        if (o === 0 || (o === 1 && rnd() < 0.5)) {
          p.w = Math.round(p.w * (o === 0 ? 1.3 : 1.15));
          p.ctr = state.seasonYear + 3;
          p.morale = clamp(p.morale + 10, 0, 100);
          return `${p.n} חתם על חוזה עד ${p.ctr}.`;
        }
        p.morale = clamp(p.morale - 25, 0, 100);
        p.listed = true;
        return `${p.n} סירב והכניס את עצמו לרשימת ההעברות.`;
      },
    },
    sponsor: {
      mode: 'manager', weight: 2,
      find: (state, club) => ({ amount: Math.round((club.income * (3 + rnd() * 3)) / 10000) * 10000 }),
      build: (state, { amount }) => ({
        title: 'הצעת חסות', body: `חברה מקומית מציעה ${money(amount)} תמורת אירוע קידום מכירות עם השחקנים באמצע השבוע.`,
        options: [{ label: 'לקבל', hint: `+${money(amount)}, כושר השחקנים -10 בשבוע הקרוב.` }, { label: 'לסרב', hint: 'השחקנים ינוחו.' }],
      }),
      apply(state, { amount }, o) {
        const club = state.clubs[state.user.clubId];
        if (o !== 0) return 'ההצעה נדחתה.';
        club.balance += amount;
        for (const p of squad(state, club.id)) p.cond = Math.max(40, p.cond - 10);
        return `${money(amount)} נכנסו לקופה.`;
      },
    },
    media: {
      mode: 'manager', weight: 2,
      find(state, club) {
        const snap = state.monthSnap;
        const t = state.tables[club.league][club.id];
        const b = snap.table[club.id];
        return b && t.l - b.l >= 2 ? {} : null;
      },
      build: () => ({
        title: 'מסיבת עיתונאים סוערת', body: 'אחרי חודש עם הפסדים, העיתונאים שואלים אם השחקנים עדיין מאמינים בך.',
        options: [
          { label: 'לגבות את השחקנים', hint: 'מורל +4 לכל הסגל.' },
          { label: 'לבקר אותם בפומבי', hint: 'מורל -6, אבל ההנהלה אוהבת נוקשות (+4 אמון).' },
          { label: 'אין תגובה', hint: 'בלי השפעה.' },
        ],
      }),
      apply(state, p, o) {
        const sq = squad(state, state.user.clubId);
        if (o === 0) { sq.forEach((x) => { x.morale = clamp(x.morale + 4, 0, 100); }); return 'השחקנים מעריכים את הגיבוי.'; }
        if (o === 1) { sq.forEach((x) => { x.morale = clamp(x.morale - 6, 0, 100); }); state.user.confidenceBonus = (state.user.confidenceBonus || 0) + 4; return 'ההנהלה מרוצה, בחדר ההלבשה פחות.'; }
        return 'העיתונאים יצאו בידיים ריקות.';
      },
    },
    youth: {
      mode: 'manager', weight: 2,
      find(state, club) {
        const lg = state.leagues.find((l) => l.id === club.league);
        const pos = pick(['ST', 'CAM', 'CB', 'LW', 'RW', 'CM', 'GK', 'RB', 'LB']);
        const nm = randomName(state, lg.country);
        return { pos, name: nm.name, nat: nm.nat, ovr: clamp(Math.round(club.rep - 18 + gauss() * 3), 42, 68), pot: clamp(Math.round(club.rep + 6 + gauss() * 4), 70, 93) };
      },
      build: (state, y) => ({
        title: 'כישרון במחלקת הנוער', body: `מאמן הנוער ממליץ על ${y.name} (${POS_HE[y.pos]}, בן 16). יכולת נוכחית ${y.ovr}, והוא חושב שיש בו פוטנציאל גבוה מאוד.`,
        options: [{ label: 'להחתים חוזה מקצועני', hint: `שכר ${money(wageFor(y.ovr))} לשבוע.` }, { label: 'לוותר', hint: 'קבוצה אחרת כנראה תחתים אותו.' }],
      }),
      apply(state, y, o) {
        if (o !== 0) return `${y.name} חתם בקבוצה יריבה.`;
        const club = state.clubs[state.user.clubId];
        const lg = state.leagues.find((l) => l.id === club.league);
        const p = createPlayer(state, club.id, y.pos, 16, y.ovr, y.pot, lg.country);
        p.n = y.name;
        p.fn = y.name;
        p.nat = y.nat;
        return `${y.name} הצטרף לסגל.`;
      },
    },
    physio: {
      mode: 'manager', weight: 3,
      find(state, club) {
        const inj = squad(state, club.id).filter((p) => p.inj >= 2);
        return inj.length >= 3 ? { n: inj.length, cost: Math.round((club.income * 0.8) / 10000) * 10000 } : null;
      },
      build: (state, { n, cost }) => ({
        title: 'משבר פציעות', body: `${n} שחקנים פצועים. הצוות הרפואי מציע להביא פיזיותרפיסט מומחה.`,
        options: [{ label: 'להביא מומחה', hint: `עלות ${money(cost)}. זמן ההחלמה יורד בשבועיים.` }, { label: 'לא עכשיו', hint: '' }],
      }),
      apply(state, { cost }, o) {
        if (o !== 0) return 'הצוות ימשיך לבד.';
        const club = state.clubs[state.user.clubId];
        club.balance -= cost;
        for (const p of squad(state, club.id)) if (p.inj > 0) p.inj = Math.max(0, p.inj - 2);
        return 'המומחה הגיע וההחלמה מתקצרת.';
      },
    },
    bonding: {
      mode: 'manager', weight: 1,
      find: (state, club) => ({ cost: Math.round((club.income * 0.5) / 10000) * 10000 }),
      build: (state, { cost }) => ({
        title: 'גיבוש קבוצתי', body: 'הקפטן מציע לצאת לסוף שבוע של גיבוש.',
        options: [{ label: 'לצאת לגיבוש', hint: `עלות ${money(cost)}, מורל +8 לכולם.` }, { label: 'לא הפעם', hint: '' }],
      }),
      apply(state, { cost }, o) {
        if (o !== 0) return 'הקבוצה נשארת בשגרה.';
        state.clubs[state.user.clubId].balance -= cost;
        squad(state, state.user.clubId).forEach((x) => { x.morale = clamp(x.morale + 8, 0, 100); });
        return 'אווירה מצוינת בחדר ההלבשה.';
      },
    },
    tickets: {
      mode: 'manager', weight: 1,
      find: () => ({}),
      build: () => ({
        title: 'מחירי הכרטיסים', body: 'ארגוני האוהדים מתלוננים על מחירי הכרטיסים. מנהל הכספים רוצה דווקא להעלות אותם.',
        options: [
          { label: 'להוריד מחירים', hint: 'הכנסה -3%, אמון ההנהלה +3, מורל +2.' },
          { label: 'להעלות מחירים', hint: 'הכנסה +4%, אמון ההנהלה -3.' },
          { label: 'להשאיר', hint: '' },
        ],
      }),
      apply(state, p, o) {
        const club = state.clubs[state.user.clubId];
        if (o === 0) { club.income = Math.round(club.income * 0.97); state.user.confidenceBonus = (state.user.confidenceBonus || 0) + 3; squad(state, club.id).forEach((x) => { x.morale = clamp(x.morale + 2, 0, 100); }); return 'האוהדים מריעים לך.'; }
        if (o === 1) { club.income = Math.round(club.income * 1.04); state.user.confidenceBonus = (state.user.confidenceBonus || 0) - 3; return 'הקופה מרוצה, היציע פחות.'; }
        return 'המחירים נשארים.';
      },
    },
    boardSell: {
      mode: 'manager', weight: 5,
      find(state, club) {
        if (club.balance >= 0) return null;
        const p = squad(state, club.id).sort((a, b) => b.w - a.w)[0];
        return p ? { pid: p.id } : null;
      },
      build: (state, { pid }) => ({
        title: 'ההנהלה דורשת לקצץ', body: `הקופה במינוס. ההנהלה רוצה למכור את ${pickP(state, pid).n}, בעל השכר הגבוה בסגל.`,
        options: [{ label: 'למכור (80% מהשווי)', hint: 'הקופה מתאזנת.' }, { label: 'לסרב', hint: 'אמון ההנהלה -12.' }],
      }),
      apply(state, { pid }, o) {
        const p = pickP(state, pid);
        if (o !== 0 || !p) { state.user.confidenceBonus = (state.user.confidenceBonus || 0) - 12; return 'ההנהלה לא מרוצה מהסירוב.'; }
        const buyers = Object.values(state.clubs).filter((c) => c.id !== p.c && c.rep >= p.ovr - 6);
        const buyer = buyers.length ? pick(buyers) : pick(Object.values(state.clubs).filter((c) => c.id !== p.c));
        transfer(state, p, buyer.id, Math.round((p.v * 0.8) / 10000) * 10000);
        return `${p.n} נמכר ${pre('ל', buyer.name)}.`;
      },
    },
    // ----- Be a Pro -----
    agent: {
      mode: 'pro', weight: 2,
      find: (state) => (state.pro.lastRatings.length >= 3 ? {} : null),
      build: (state) => ({
        title: 'הסוכן שלך מתקשר', body: `לדעת הסוכן אתה שווה יותר מ-${money(state.players[state.pro.pid].w)} לשבוע. הוא רוצה לדרוש העלאה.`,
        options: [{ label: 'לדרוש העלאה', hint: 'מצליח אם שיחקת טוב לאחרונה. כישלון יפגע במאמן.' }, { label: 'להישאר נאמן', hint: 'אמון המאמן +4.' }],
      }),
      apply(state, p, o) {
        const pro = state.pro;
        const pl = state.players[pro.pid];
        if (o === 1) { pro.trust = clamp((pro.trust || 50) + 4, 0, 100); return 'המאמן מעריך את הנאמנות.'; }
        const avg = pro.lastRatings.reduce((s, v) => s + v, 0) / pro.lastRatings.length;
        if (avg >= 6.9 && rnd() < 0.75) { pl.w = Math.round(pl.w * 1.4); return `קיבלת העלאה! השכר החדש: ${money(pl.w)} לשבוע.`; }
        pro.trust = clamp((pro.trust || 50) - 6, 0, 100);
        pl.morale = clamp(pl.morale - 8, 0, 100);
        return 'המועדון סירב, והמאמן לא אהב את הדרישה.';
      },
    },
    interview: {
      mode: 'pro', weight: 2,
      find: () => ({}),
      build: () => ({
        title: 'ראיון בטלוויזיה', body: 'עיתונאי שואל איפה אתה רואה את עצמך בעוד שלוש שנים.',
        options: [{ label: '"מתמקד בקבוצה שלי"', hint: 'אמון המאמן +3.' }, { label: '"בקבוצה הכי גדולה באירופה"', hint: 'מוניטין +6, המאמן פחות אוהב (-3).' }],
      }),
      apply(state, p, o) {
        const pro = state.pro;
        if (o === 0) { pro.trust = clamp((pro.trust || 50) + 3, 0, 100); return 'תשובה צנועה ובוגרת.'; }
        pro.fame += 6;
        pro.trust = clamp((pro.trust || 50) - 3, 0, 100);
        return 'הכותרות אוהבות אותך, חדר ההלבשה פחות.';
      },
    },
    extra: {
      mode: 'pro', weight: 3,
      find: () => ({}),
      build: (state) => ({
        title: 'אימון נוסף?', body: `המאמן מציע אימונים אישיים נוספים ב${(state.players[state.pro.pid].pos === 'GK' ? GK_ATTR_HE : ATTR_HE)[state.pro.focus]}.`,
        options: [{ label: 'להתאמן עוד', hint: '+45 נקודות ניסיון, כושר -15 בשבוע הקרוב.' }, { label: 'לנוח', hint: 'כושר ומורל עולים.' }],
      }),
      apply(state, p, o) {
        const pl = state.players[state.pro.pid];
        if (o === 0) { const g = trainingGain(state, state.pro.focus, 45); pl.cond = Math.max(40, pl.cond - 15); return g.length ? `עבודה קשה משתלמת: הדירוג עלה ל-${pl.ovr}.` : 'עוד צעד קדימה באימונים.'; }
        pl.cond = 100;
        pl.morale = clamp(pl.morale + 3, 0, 100);
        return 'נחת וטעינת מצברים.';
      },
    },
    party: {
      mode: 'pro', weight: 1,
      find: () => ({}),
      build: () => ({
        title: 'הזמנה למסיבה', body: 'כמה שחקנים מהקבוצה יוצאים למסיבה יומיים לפני משחק.',
        options: [{ label: 'להצטרף', hint: 'מורל +8, אבל יש סיכון שהמאמן יגלה.' }, { label: 'להישאר בבית', hint: '+10 נקודות ניסיון.' }],
      }),
      apply(state, p, o) {
        const pro = state.pro;
        const pl = state.players[pro.pid];
        if (o === 1) { trainingGain(state, pro.focus, 10); return 'לילה שקט ושינה טובה.'; }
        pl.morale = clamp(pl.morale + 8, 0, 100);
        if (rnd() < 0.35) { pro.trust = clamp((pro.trust || 50) - 8, 0, 100); return 'המאמן גילה. אמון המאמן ירד.'; }
        return 'היה כיף, ואף אחד לא גילה.';
      },
    },
    coachTalk: {
      mode: 'pro', weight: 4,
      find: (state) => (proSquadRole(state) !== 'start' ? {} : null),
      build: () => ({
        title: 'שיחה עם המאמן', body: 'אתה לא פותח בהרכב. איך לגשת לזה?',
        options: [{ label: 'לדרוש יותר דקות', hint: 'סיכוי של 50% לאמון +8. אחרת -5.' }, { label: 'לעבוד קשה יותר', hint: '+30 נקודות ניסיון, אמון +3.' }],
      }),
      apply(state, p, o) {
        const pro = state.pro;
        if (o === 1) { trainingGain(state, pro.focus, 30); pro.trust = clamp((pro.trust || 50) + 3, 0, 100); return 'המאמן שם לב למאמץ.'; }
        if (rnd() < 0.5) { pro.trust = clamp((pro.trust || 50) + 8, 0, 100); return 'המאמן הבטיח לתת לך הזדמנות.'; }
        pro.trust = clamp((pro.trust || 50) - 5, 0, 100);
        return 'המאמן לא אהב את הטון.';
      },
    },
    boots: {
      mode: 'pro', weight: 2,
      find: (state) => (state.pro.fame >= 12 && !state.pro.bootsDeal ? { amount: Math.round((20000 + state.pro.fame * 4000) / 1000) * 1000 } : null),
      build: (state, { amount }) => ({
        title: 'חוזה נעליים', body: `חברת ציוד ספורט מציעה לך ${money(amount)} לעונה.`,
        options: [{ label: 'לחתום', hint: 'כסף ומוניטין +3.' }, { label: 'לחכות להצעה גדולה יותר', hint: '' }],
      }),
      apply(state, { amount }, o) {
        if (o !== 0) return 'אולי בפעם הבאה.';
        state.pro.bootsDeal = 1;
        state.pro.money = (state.pro.money || 0) + amount;
        state.pro.fame += 3;
        return `חתמת! ${money(amount)} נכנסו לחשבון.`;
      },
    },
    captaincy: {
      mode: 'pro', weight: 6,
      find(state) {
        const pro = state.pro;
        const p = state.players[pro.pid];
        const atClub = pro.career.filter((c) => c.club === p.c).reduce((s, c) => s + c.st.app, 0) + p.st.app;
        return !pro.captain && p.age >= 23 && (pro.trust || 50) >= 72 && (pro.fans || 50) >= 62 && atClub >= 25 ? {} : null;
      },
      build: () => ({
        title: 'המאמן רוצה שתהיה הקפטן', body: 'הקפטן הנוכחי עוזב, והמאמן רוצה לתת לך את סרט הקפטן.',
        options: [{ label: 'לקבל את הסרט', hint: 'יכולת "מנהיג", לחץ תקשורתי גדול יותר.' }, { label: 'לסרב בנימוס', hint: 'להתרכז במשחק שלך.' }],
      }),
      apply(state, p, o) {
        const pro = state.pro;
        if (o !== 0) return 'המאמן מבין.';
        pro.captain = state.players[pro.pid].c;
        pro.trust = clamp((pro.trust || 50) + 10, 0, 100);
        unlock(state, 'captain');
        checkPerks(state);
        return 'אתה הקפטן החדש!';
      },
    },
    mentor: {
      mode: 'pro', weight: 2,
      find: (state) => (state.players[state.pro.pid].age <= 21 ? {} : null),
      build: () => ({
        title: 'שחקן ותיק מציע עזרה', body: 'הקפטן מציע להישאר אחרי האימונים ולעבוד איתך.',
        options: [{ label: 'בשמחה', hint: '+25 נקודות ניסיון בתכונה אקראית.' }, { label: 'אני מסתדר לבד', hint: '' }],
      }),
      apply(state, p, o) {
        if (o !== 0) return 'בסדר, אתה סומך על עצמך.';
        trainingGain(state, rint(0, 5), 25);
        state.pro.trust = clamp((state.pro.trust || 50) + 2, 0, 100);
        return 'למדת כמה טריקים מהוותיק.';
      },
    },
  };

  function pickDecisions(state) {
    const clubId = focusClubId(state);
    if (!clubId) return [];
    const club = state.clubs[clubId];
    const recent = state.recentDecisions || [];
    const cands = [];
    for (const [type, d] of Object.entries(DECISIONS)) {
      if (d.mode !== state.mode || recent.includes(type)) continue;
      const params = d.find(state, club);
      if (params) cands.push({ type, params, weight: d.weight });
    }
    const out = [];
    const n = rnd() < 0.5 ? 1 : 2;
    while (out.length < n && cands.length) {
      const c = weighted(cands, (x) => x.weight);
      cands.splice(cands.indexOf(c), 1);
      const b = DECISIONS[c.type].build(state, c.params);
      out.push({ type: c.type, params: c.params, title: b.title, body: b.body, options: b.options, answer: null, result: null });
    }
    state.recentDecisions = recent.concat(out.map((d) => d.type)).slice(-4);
    return out;
  }

  function answerDecision(state, idx, option) {
    const r = state.pendingMonth;
    if (!r || !r.decisions[idx] || r.decisions[idx].answer !== null) return null;
    const d = r.decisions[idx];
    d.answer = option;
    d.result = DECISIONS[d.type].apply(state, d.params, option);
    return d.result;
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
    PERKS, ACHIEVEMENTS, SERVICES, PURCHASES, objectiveProgress, setObjectives, careerTotals, serviceCost, toggleService, buy,
    proNegotiate, requestTransfer, requestLoan, intlNext, answerIntl, closeIntl, answerInjury, nationStrength, callUpThreshold, checkPerks, seasonAwards,
    money, seasonLabel, avgRating, message, pre,
    TRAINING_FOCUS, TRAINING_INTENSITY, facilitiesOf, facilityUpgradeCost, upgradeFacilities, setPlayerPlan, FACILITY_DEV, monthLabel, monthKeyOf, closeMonth, answerDecision, setTraining, trainingOf, initMonth,
  };
});
