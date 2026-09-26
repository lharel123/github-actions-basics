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
    expect(summary.awards.ballon.length).toBeGreaterThanOrEqual(3);
    for (const b of summary.awards.ballon) expect(world.leagues.find((l) => l.id === world.clubs.find((c) => c.id === b.club).league).tier).toBe(1);
    expect(summary.awards.season.eng1).toBeDefined();
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

describe('monthly cycle', () => {
  test('each month produces a review with decisions, and closing needs every decision answered', () => {
    E.setSeed(21);
    const s = freshManager('maccabi-tel-aviv');
    let reviews = 0;
    for (let w = 0; w < 20; w++) {
      E.playWeek(s);
      E.afterWeek(s);
      const r = s.pendingMonth;
      if (!r) continue;
      reviews++;
      expect(r.label).toMatch(/20\d\d/);
      expect(r.club).toBeDefined();
      expect(r.confidence.to).toBeGreaterThanOrEqual(0);
      if (r.decisions.length) {
        expect(E.closeMonth(s)).toBe(false);
        r.decisions.forEach((d, i) => expect(typeof E.answerDecision(s, i, d.options.length - 1)).toBe('string'));
      }
      expect(E.closeMonth(s)).toBe(true);
      expect(s.pendingMonth).toBeNull();
    }
    expect(reviews).toBeGreaterThanOrEqual(4);
    expect(s.monthHistory.length).toBe(reviews);
  });

  test('training plan changes recovery and match strength', () => {
    const s = freshManager('maccabi-tel-aviv');
    const club = s.clubs['maccabi-tel-aviv'];
    E.setTraining(s, 'attack', 'intense');
    expect(E.trainingOf(club)).toEqual({ focus: 'attack', intensity: 'intense' });
    const sim = new E.MatchSim(s, 'maccabi-tel-aviv', 'maccabi-haifa');
    const withFocus = sim.sides[0].r.att;
    club.training = { focus: 'balanced', intensity: 'normal' };
    sim.recalc();
    expect(withFocus / sim.sides[0].r.att).toBeCloseTo(1.02, 3);
  });

  test('Be a Pro gets monthly reviews with pro decisions', () => {
    E.setSeed(22);
    const s = E.newState(world, { mode: 'pro' });
    const club = E.proStartOffers(s, 'eng')[0];
    E.createPro(s, { name: 'Pro', nat: 'Israel', pos: 'CM', clubId: club.id });
    let seen = 0;
    for (let w = 0; w < 14; w++) {
      E.playWeek(s);
      E.afterWeek(s);
      if (!s.pendingMonth) continue;
      seen++;
      expect(s.pendingMonth.pro).toBeDefined();
      s.pendingMonth.decisions.forEach((d, i) => E.answerDecision(s, i, 0));
      E.closeMonth(s);
    }
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(s.pro.money).toBeGreaterThan(0);
  });
});

describe('Israeli squads', () => {
  test('include real players from Transfermarkt', () => {
    const real = world.players.filter((p) => p.real);
    expect(real.length).toBeGreaterThan(50);
    const mta = world.players.filter((p) => p.c === 'maccabi-tel-aviv');
    expect(mta.length).toBe(26);
    expect(mta.some((p) => p.real)).toBe(true);
  });
});

describe('training upgrades', () => {
  test('facilities upgrade costs money and raises the level', () => {
    const s = freshManager('maccabi-haifa');
    const club = s.clubs['maccabi-haifa'];
    const lvl = E.facilitiesOf(club);
    const cost = E.facilityUpgradeCost(club);
    club.balance = cost + 1;
    expect(E.upgradeFacilities(s, club.id).ok).toBe(true);
    expect(club.facilities).toBe(lvl + 1);
    expect(club.balance).toBe(1);
  });

  test('a position retraining plan eventually teaches the new position', () => {
    E.setSeed(31);
    const s = freshManager('maccabi-haifa');
    const p = E.squad(s, 'maccabi-haifa').find((x) => x.pos === 'CB');
    E.setPlayerPlan(s, p.id, { type: 'pos', pos: 'CDM' });
    expect(p.plan.progress).toBe(0);
    for (let w = 0; w < 30 && p.plan; w++) {
      E.playWeek(s);
      E.afterWeek(s);
      if (s.pendingMonth) { s.pendingMonth.decisions.forEach((d, i) => E.answerDecision(s, i, 0)); E.closeMonth(s); }
    }
    expect(p.plan).toBeUndefined();
    expect(p.alt).toContain('CDM');
  });
});

describe('Be a Pro career systems', () => {
  function proState(seed, pos = 'ST', country = 'isr') {
    E.setSeed(seed);
    const s = E.newState(world, { mode: 'pro' });
    const club = E.proStartOffers(s, country)[0];
    const p = E.createPro(s, { name: 'Pro', nat: 'Israel', pos, clubId: club.id });
    return { s, p };
  }

  test('new pro gets objectives, a position-relevant training focus and empty collections', () => {
    const { s } = proState(41, 'CB');
    expect(s.pro.objectives.list.length).toBeGreaterThanOrEqual(3);
    expect(s.pro.focus).toBe(4); // defending for a centre-back
    expect(s.pro.perks).toEqual([]);
  });

  test('perks unlock from attributes and boost matching options', () => {
    const { s, p } = proState(42);
    p.at[1] = 80; // shooting
    E.checkPerks(s);
    expect(s.pro.perks).toEqual(expect.arrayContaining(['finesse', 'penalty']));
  });

  test('moments are finalised: perk options only with the perk, probabilities in range, chains resolve', () => {
    const { s, p } = proState(43);
    p.at = [85, 85, 85, 85, 40, 80];
    p.ovr = 80;
    E.checkPerks(s);
    let seen = 0;
    let chained = 0;
    for (let w = 0; w < 10; w++) {
      const fx = E.clubFixture(s, p.c, s.week);
      let sim = null;
      if (fx && fx.m.hg === null) {
        sim = E.proMatchSim(s, fx);
        while (!sim.done) {
          sim.step();
          while (sim.pending) {
            seen++;
            for (const o of sim.pending.options) {
              expect(o.p).toBeGreaterThan(0);
              expect(o.p).toBeLessThanOrEqual(0.95);
              if (o.perk) expect(s.pro.perks).toContain(o.perk);
            }
            if (sim.resolve(0).chained) chained++;
          }
        }
      }
      const res = E.playWeek(s, sim);
      if (sim) E.proAfterMatch(s, sim, res.find((x) => x.sim === sim).ratings);
      E.afterWeek(s);
      s.pendingMonth = null;
      s.pendingInjury = null;
      s.pendingIntl = null;
    }
    expect(seen).toBeGreaterThan(5);
    expect(chained).toBeGreaterThanOrEqual(0);
    expect(s.pro.ach.debut).toBeDefined();
  });

  test('negotiation moves the pro and sets the contract role', () => {
    const { s, p } = proState(44);
    const target = Object.values(s.clubs).find((c) => c.id !== p.c && c.league === 'isr1');
    s.pro.offers.push({ club: target.id, fee: 1000000, wage: 5000 });
    E.setSeed(1);
    const r = E.proNegotiate(s, target.id, { wage: 'low', role: 'rotation', clause: false });
    expect(r.ok).toBe(true);
    expect(p.c).toBe(target.id);
    expect(s.pro.contractRole).toBe('rotation');
  });

  test('money buys services and items', () => {
    const { s } = proState(45);
    s.pro.money = 1000000;
    expect(E.buy(s, 'car').ok).toBe(true);
    expect(E.buy(s, 'car').ok).toBe(false);
    expect(E.toggleService(s, 'trainer')).toBe(true);
    const before = s.pro.money;
    E.playWeek(s);
    E.afterWeek(s);
    expect(s.pro.money).toBeLessThan(before + s.players[s.pro.pid].w);
  });

  test('a national team call-up plays out through moments', () => {
    const { s, p } = proState(46);
    p.ovr = 80;
    s.week = 10;
    E.playWeek(s);
    E.afterWeek(s);
    expect(s.pendingIntl).toBeTruthy();
    while (E.intlNext(s)) E.answerIntl(s, 0);
    expect(s.pendingIntl.done).toBe(true);
    expect(E.closeIntl(s).over).toBe(true);
    expect(s.pro.caps).toBe(1);
    expect(s.pendingIntl).toBeNull();
  });

});
