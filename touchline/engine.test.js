const E = require('./public/js/engine');
const world = require('./public/data/world.json');

function freshManager(clubId = 'maccabi-haifa') {
  const s = E.newState(world, { mode: 'manager' });
  E.startManager(s, clubId, 'Tester');
  return s;
}

describe('world data', () => {
  test('has the 12 leagues with complete squads', () => {
    expect(world.leagues).toHaveLength(12);
    for (const lg of world.leagues) {
      const clubs = world.clubs.filter((c) => c.league === lg.id);
      expect(clubs.length).toBeGreaterThanOrEqual(14);
      for (const c of clubs) {
        const squad = world.players.filter((p) => p.c === c.id);
        expect(squad.length).toBeGreaterThanOrEqual(18);
        expect(squad.some((p) => p.pos === 'GK')).toBe(true);
      }
    }
  });

  test('promotion and relegation counts match inside each country', () => {
    for (const c of world.countries) {
      const l1 = world.leagues.find((l) => l.country === c.id && l.tier === 1);
      const l2 = world.leagues.find((l) => l.country === c.id && l.tier === 2);
      expect(l1.down).toBe(l2.up);
    }
  });
});

describe('fixtures', () => {
  test('every club meets every other club home and away', () => {
    E.setSeed(1);
    const s = freshManager();
    for (const lg of s.leagues) {
      const ids = E.clubsIn(s, lg.id).map((c) => c.id);
      const rounds = s.fixtures[lg.id];
      expect(rounds).toHaveLength(2 * (ids.length - 1));
      expect(rounds[0].week).toBe(1);
      expect(rounds[rounds.length - 1].week).toBe(E.SEASON_WEEKS);
      const pairs = new Set();
      for (const r of rounds) for (const m of r.matches) pairs.add(`${m.h}>${m.a}`);
      expect(pairs.size).toBe(ids.length * (ids.length - 1));
    }
  });
});

describe('match simulation', () => {
  test('score equals goal events and ratings are in range', () => {
    E.setSeed(7);
    const s = freshManager();
    for (let i = 0; i < 20; i++) {
      const sim = new E.MatchSim(s, 'maccabi-haifa', 'maccabi-tel-aviv');
      sim.runToEnd();
      const goals = sim.events.filter((e) => e.type === 'goal');
      expect(goals.filter((e) => e.side === 0)).toHaveLength(sim.sides[0].goals);
      expect(goals.filter((e) => e.side === 1)).toHaveLength(sim.sides[1].goals);
      for (const r of Object.values(sim.ratings())) {
        expect(r).toBeGreaterThanOrEqual(3);
        expect(r).toBeLessThanOrEqual(10);
      }
    }
  });

  test('the user can change mentality and substitute during a match', () => {
    E.setSeed(3);
    const s = freshManager();
    const sim = new E.MatchSim(s, 'maccabi-haifa', 'maccabi-tel-aviv', { detail: true, userSide: 0 });
    for (let i = 0; i < 50; i++) sim.step();
    const side = sim.sides[0];
    side.mentality = 'attacking';
    sim.recalc();
    const out = side.onPitch.find((x) => x.slot !== 'GK').id;
    const inn = side.bench.find((id) => s.players[id].pos !== 'GK');
    expect(sim.substitute(0, out, inn)).toBe(true);
    expect(side.onPitch.some((x) => x.id === inn)).toBe(true);
    expect(side.subsLeft).toBe(4);
    sim.runToEnd();
    expect(sim.done).toBe(true);
  });
});

describe('a full season', () => {
  test('plays every match, then promotes, relegates and rolls over', () => {
    E.setSeed(11);
    const s = freshManager();
    const sizes = Object.fromEntries(s.leagues.map((l) => [l.id, E.clubsIn(s, l.id).length]));
    let goals = 0;
    let games = 0;
    let summary = null;
    for (let w = 0; w <= E.SEASON_WEEKS; w++) {
      for (const r of E.playWeek(s)) {
        goals += r.m.hg + r.m.ag;
        games++;
      }
      summary = E.afterWeek(s) || summary;
    }
    expect(summary).not.toBeNull();
    expect(goals / games).toBeGreaterThan(2);
    expect(goals / games).toBeLessThan(3.3);
    const eng1Down = summary.relegated.eng1;
    const eng2Up = summary.promoted.eng2;
    expect(eng1Down).toHaveLength(3);
    for (const id of eng1Down) expect(s.clubs[id].league).toBe('eng2');
    for (const id of eng2Up) expect(s.clubs[id].league).toBe('eng1');
    for (const lg of s.leagues) expect(E.clubsIn(s, lg.id)).toHaveLength(sizes[lg.id]);
    expect(s.seasonYear).toBe(world.season + 1);
    expect(s.week).toBe(0);
    expect(Object.values(s.tables.eng1).every((r) => r.p === 0)).toBe(true);
  }, 120000);
});

describe('transfers', () => {
  test('offers are judged against the asking price and budget', () => {
    E.setSeed(5);
    const s = freshManager('manchester-city');
    const target = Object.values(s.players).find((p) => p.c === 'fc-barcelona' && p.ovr < 78 && p.ovr > 70);
    const ask = E.askingPrice(s, target);
    expect(E.makeOffer(s, target.id, Math.round(ask * 0.5)).status).toBe('rejected');
    expect(E.makeOffer(s, target.id, Math.round(ask * 0.9)).status).toBe('counter');
    const before = s.clubs['manchester-city'].balance;
    expect(E.makeOffer(s, target.id, ask).status).toBe('done');
    expect(target.c).toBe('manchester-city');
    expect(s.clubs['manchester-city'].balance).toBe(before - ask);
  });

  test('no deals while the window is closed', () => {
    const s = freshManager('manchester-city');
    s.week = 10;
    const target = Object.values(s.players).find((p) => p.c === 'arsenal');
    expect(E.makeOffer(s, target.id, 1e9).status).toBe('closed');
  });
});

describe('Be a Pro', () => {
  test('a created pro gets moments, decisions resolve and he gains experience', () => {
    E.setSeed(9);
    const s = E.newState(world, { mode: 'pro' });
    const club = E.proStartOffers(s, 'isr')[0];
    const p = E.createPro(s, { name: 'Test Pro', nat: 'Israel', pos: 'ST', clubId: club.id });
    expect(p.age).toBe(17);
    let moments = 0;
    let played = 0;
    for (let w = 0; w < 12; w++) {
      const fx = E.clubFixture(s, p.c, s.week);
      let sim = null;
      if (fx && fx.m.hg === null) {
        sim = E.proMatchSim(s, fx);
        while (!sim.done) {
          sim.step();
          if (sim.pending) {
            moments++;
            const m = sim.pending;
            expect(m.options.length).toBeGreaterThanOrEqual(2);
            for (const o of m.options) expect(o.p).toBeGreaterThan(0);
            sim.resolve(0);
          }
        }
      }
      const res = E.playWeek(s, sim);
      if (sim) {
        const r = res.find((x) => x.sim === sim);
        if (E.proAfterMatch(s, sim, r.ratings).played) played++;
      }
      E.afterWeek(s);
    }
    expect(played).toBeGreaterThan(0);
    expect(moments).toBeGreaterThan(0);
    expect(Object.values(s.pro.xp).some((v) => v > 0)).toBe(true);
  });
});

describe('valuation', () => {
  test('value grows with ability and falls with age', () => {
    expect(E.valueFor(80, 25, 82)).toBeGreaterThan(E.valueFor(70, 25, 72));
    expect(E.valueFor(80, 25, 80)).toBeGreaterThan(E.valueFor(80, 33, 80));
    expect(E.money(1500000)).toBe('€1.5M');
    expect(E.pre('ל', 'Arsenal')).toBe('ל-Arsenal');
    expect(E.pre('ל', 'מכבי חיפה')).toBe('למכבי חיפה');
  });
});
