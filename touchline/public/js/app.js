'use strict';

/* Touchline UI. Renders every screen with plain DOM (no innerHTML with data) on top of window.Engine. */
(() => {
  const E = window.Engine;
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');

  let world = null;
  let crests = {};
  let S = null; // game state
  let slot = null; // save slot id
  let tab = 'home';
  let busy = false;

  // ---------- DOM helpers ----------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'style') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
        else el.setAttribute(k, v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const money = (v) => E.money(v);
  const pre = (p, n) => E.pre(p, n);
  const dateFmt = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const shortDate = new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', timeZone: 'UTC' });

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function openModal(build, opts = {}) {
    const close = () => {
      overlay.remove();
      if (opts.onClose) opts.onClose();
    };
    const box = h('div', { class: 'modal' + (opts.wide ? ' wide' : '') });
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay && !opts.locked) close(); } }, box);
    box.append(...[].concat(build(close)).filter((x) => x !== null && x !== undefined && x !== false));
    modalRoot.appendChild(overlay);
    return close;
  }
  function modalHead(title, close) {
    return h('div', { class: 'modal-head' }, h('h2', { text: title }), close ? h('button', { class: 'ghost', text: '✕', onclick: close }) : null);
  }
  function confirmBox(text, onYes) {
    openModal((close) => [
      h('p', { text }),
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: 'כן', onclick: () => { close(); onYes(); } }),
        h('button', { text: 'ביטול', onclick: close })),
    ]);
  }

  function ovrColor(v) {
    return v >= 82 ? '#3ddc84' : v >= 74 ? '#a3e635' : v >= 66 ? '#facc15' : v >= 58 ? '#fb923c' : '#f87171';
  }
  function ovrBadge(v, big) {
    return h('span', { class: 'ovr' + (big ? ' big' : ''), style: { background: ovrColor(v) }, text: String(v) });
  }
  function crest(club, big) {
    const fallback = () => {
      const b = h('span', { class: 'badge' + (big ? ' big' : ''), title: club.name });
      b.style.background = `linear-gradient(135deg, ${club.colors[0]} 50%, ${club.colors[1]} 50%)`;
      return b;
    };
    if (!crests[club.id]) return fallback();
    const img = h('img', { class: 'badge' + (big ? ' big' : ''), src: `crests/${club.id}.png`, alt: '', title: club.name });
    img.style.objectFit = 'contain';
    img.style.border = '0';
    img.style.borderRadius = '0';
    img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
    return img;
  }
  function clubLabel(club, opts = {}) {
    return h('span', { class: 'row', style: { gap: '6px', display: 'inline-flex', flexWrap: 'nowrap' } }, crest(club), h('span', { text: club.name, class: opts.bold ? 'good' : '' }));
  }
  function posPill(pos) {
    return h('span', { class: `pill pos-${E.group(pos)}`, title: E.POS_HE[pos] || pos, text: pos });
  }
  function formDots(form) {
    return h('span', { class: 'form-dots' }, form.map((r) => h('i', { class: r, text: r === 'W' ? 'נ' : r === 'D' ? 'ת' : 'ה' })));
  }
  function leagueName(id) {
    const lg = S.leagues.find((l) => l.id === id);
    const c = S.countries.find((x) => x.id === lg.country);
    return `${c.flag} ${lg.name}`;
  }
  function userClubId() {
    return S.mode === 'manager' ? S.user.clubId : S.players[S.pro.pid].c;
  }

  // ---------- saves ----------
  async function gzip(str) {
    if (!window.CompressionStream) return new TextEncoder().encode(str);
    const cs = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(cs).arrayBuffer());
  }
  async function gunzip(bytes) {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(ds).text();
    }
    return new TextDecoder().decode(bytes);
  }
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function saveMeta() {
    const club = S.clubs[userClubId()];
    if (S.mode === 'manager') {
      return { mode: 'manager', title: `${S.user.name} · ${club.name}`, subtitle: `עונת ${E.seasonLabel(S.seasonYear)} · שבוע ${S.week}` };
    }
    const p = S.players[S.pro.pid];
    return { mode: 'pro', title: `${p.n} (${p.ovr}) · ${club.name}`, subtitle: `עונת ${E.seasonLabel(S.seasonYear)} · גיל ${p.age}` };
  }
  let saving = null;
  async function saveGame(quiet) {
    if (!S || !slot) return;
    if (saving) await saving;
    saving = (async () => {
      const bytes = await gzip(JSON.stringify(S));
      const meta = saveMeta();
      let serverOk = false;
      try {
        const res = await fetch(`api/saves/${slot}`, {
          method: 'PUT', body: bytes,
          headers: { 'Content-Type': 'application/octet-stream', 'X-Save-Meta': encodeURIComponent(JSON.stringify(meta)) },
        });
        serverOk = res.ok;
      } catch (e) { serverOk = false; }
      try {
        localStorage.setItem(`touchline.save.${slot}`, b64(bytes));
        localStorage.setItem(`touchline.meta.${slot}`, JSON.stringify({ ...meta, savedAt: new Date().toISOString() }));
      } catch (e) { /* quota - server copy is the main one */ }
      if (!quiet) toast(serverOk ? 'המשחק נשמר בשרת' : 'נשמר בדפדפן בלבד (השרת לא זמין)');
    })();
    await saving;
    saving = null;
  }
  async function listSaves() {
    const out = new Map();
    try {
      const res = await fetch('api/saves', { cache: 'no-store' });
      if (res.ok) for (const s of (await res.json()).saves) out.set(s.slot, { ...s, where: 'server' });
    } catch (e) { /* offline */ }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('touchline.meta.')) continue;
        const s = k.slice('touchline.meta.'.length);
        const meta = JSON.parse(localStorage.getItem(k));
        const cur = out.get(s);
        if (!cur || (meta.savedAt || '') > (cur.savedAt || '')) out.set(s, { slot: s, ...meta, where: cur ? 'server' : 'local' });
      }
    } catch (e) { /* ignore */ }
    return [...out.values()].sort((a, b) => ((a.savedAt || '') < (b.savedAt || '') ? 1 : -1));
  }
  async function loadSave(s) {
    let bytes = null;
    try {
      const local = localStorage.getItem(`touchline.save.${s.slot}`);
      const meta = JSON.parse(localStorage.getItem(`touchline.meta.${s.slot}`) || 'null');
      if (local && meta && (!s.savedAt || meta.savedAt >= s.savedAt)) bytes = unb64(local);
    } catch (e) { bytes = null; }
    if (!bytes) {
      const res = await fetch(`api/saves/${s.slot}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('load failed');
      bytes = new Uint8Array(await res.arrayBuffer());
    }
    S = JSON.parse(await gunzip(bytes));
    slot = s.slot;
    await loadCrests();
    tab = 'home';
    gameScreen();
  }
  async function deleteSave(s) {
    try { await fetch(`api/saves/${s.slot}`, { method: 'DELETE' }); } catch (e) { /* ignore */ }
    try {
      localStorage.removeItem(`touchline.save.${s.slot}`);
      localStorage.removeItem(`touchline.meta.${s.slot}`);
    } catch (e) { /* ignore */ }
  }
  async function exportSave() {
    const bytes = await gzip(JSON.stringify(S));
    const a = h('a', { href: URL.createObjectURL(new Blob([bytes])), download: `touchline-${slot}.save` });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- data ----------
  async function loadWorld() {
    if (world) return world;
    const res = await fetch('data/world.json');
    world = await res.json();
    await loadCrests();
    return world;
  }
  async function loadCrests() {
    if (Object.keys(crests).length) return;
    try { crests = await (await fetch('data/crests.json')).json(); } catch (e) { crests = {}; }
  }

  // ---------- start screen ----------
  async function startScreen() {
    S = null;
    slot = null;
    const savesBox = h('div', { class: 'card saves' }, h('h3', { text: 'משחקים שמורים' }), h('p', { class: 'muted', text: 'טוען...' }));
    const importInput = h('input', { type: 'file', accept: '.save', class: 'hidden', onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        S = JSON.parse(await gunzip(new Uint8Array(await f.arrayBuffer())));
        slot = `${S.mode === 'pro' ? 'pro' : 'mgr'}-${Date.now().toString(36)}`;
        await loadCrests();
        await saveGame(true);
        tab = 'home';
        gameScreen();
      } catch (err) { toast('קובץ שמירה לא תקין'); }
    } });
    app.replaceChildren(h('div', { class: 'hero' },
      h('h1', { class: 'logo' }, 'TOUCH', h('span', { text: 'LINE' })),
      h('p', { class: 'tagline', text: 'מנג\'ר כדורגל קליל עם קבוצות ושחקנים אמיתיים, 6 מדינות ו-12 ליגות' }),
      h('div', { class: 'modes' },
        h('div', { class: 'card mode', onclick: () => newManagerScreen() },
          h('div', { class: 'ico', text: '📋' }), h('h2', { text: 'קריירת מנג\'ר' }),
          h('p', { class: 'muted', text: 'בחר קבוצה, בנה סגל, קבע טקטיקה, קנה ומכור שחקנים, ונסה לעמוד בציפיות ההנהלה.' })),
        h('div', { class: 'card mode', onclick: () => newProScreen() },
          h('div', { class: 'ico', text: '⭐' }), h('h2', { text: 'Be a Pro' }),
          h('p', { class: 'muted', text: 'צור שחקן בן 17, קבל החלטות ברגעי המפתח של כל משחק, השתפר ועבור לקבוצות גדולות.' }))),
      savesBox,
      h('p', { class: 'muted' }, h('button', { class: 'small ghost', text: '📂 ייבוא קובץ שמירה', onclick: () => importInput.click() }), importInput)));
    const saves = await listSaves();
    savesBox.replaceChildren(h('h3', { text: 'משחקים שמורים' }));
    if (!saves.length) savesBox.appendChild(h('p', { class: 'muted', text: 'אין עדיין משחקים שמורים.' }));
    for (const s of saves) {
      savesBox.appendChild(h('div', { class: 'save-row' },
        h('span', { text: s.mode === 'pro' ? '⭐' : '📋' }),
        h('div', { class: 'grow' }, h('div', { text: s.title || s.slot }), h('div', { class: 'muted', text: `${s.subtitle || ''} · ${s.savedAt ? new Date(s.savedAt).toLocaleString('he-IL') : ''}${s.where === 'local' ? ' · בדפדפן בלבד' : ''}` })),
        h('button', { class: 'primary small', text: 'טען', onclick: async () => {
          try { await loadSave(s); } catch (e) { toast('הטעינה נכשלה'); }
        } }),
        h('button', { class: 'small danger', text: 'מחק', onclick: () => confirmBox(`למחוק את "${s.title}"?`, async () => { await deleteSave(s); startScreen(); }) })));
    }
  }

  function loading(text) {
    app.replaceChildren(h('div', { class: 'hero' }, h('p', { class: 'muted', text })));
  }

  // ---------- new manager ----------
  async function newManagerScreen() {
    loading('טוען את מסד הנתונים...');
    await loadWorld();
    const st = { country: 'isr', tier: 1, club: null, name: '' };
    const wrap = h('div', { class: 'wizard' });
    app.replaceChildren(wrap);
    const render = () => {
      const lg = world.leagues.find((l) => l.country === st.country && l.tier === st.tier);
      const clubs = world.clubs.filter((c) => c.league === lg.id).sort((a, b) => b.rep - a.rep);
      wrap.replaceChildren(
        h('div', { class: 'row spread' }, h('h2', { text: 'קריירת מנג\'ר - בחר קבוצה' }), h('button', { class: 'ghost', text: '→ חזרה', onclick: startScreen })),
        h('div', { class: 'tabs' }, world.countries.map((c) => h('button', { class: st.country === c.id ? 'active' : '', text: `${c.flag} ${c.name}`, onclick: () => { st.country = c.id; st.club = null; render(); } }))),
        h('div', { class: 'tabs' }, [1, 2].map((t) => {
          const l = world.leagues.find((x) => x.country === st.country && x.tier === t);
          return h('button', { class: st.tier === t ? 'active' : '', text: l.name, onclick: () => { st.tier = t; st.club = null; render(); } });
        })),
        h('div', { class: 'club-grid' }, clubs.map((c, i) => h('div', {
          class: 'card tight club-card' + (st.club === c.id ? ' sel' : ''), onclick: () => { st.club = c.id; render(); },
        }, crest(c, true), h('div', { class: 'info' },
          h('div', { class: 'name', text: c.name }),
          h('div', { class: 'muted', text: `תקציב ${money(c.budget)} · דירוג ${i + 1}` })), ovrBadge(c.rep)))),
        h('div', { class: 'card', style: { marginTop: '16px', position: 'sticky', bottom: '10px' } },
          h('div', { class: 'row' },
            h('input', { placeholder: 'השם שלך', value: st.name, maxlength: '30', oninput: (e) => { st.name = e.target.value; } }),
            h('div', { class: 'grow muted', text: st.club ? `נבחרה: ${world.clubs.find((c) => c.id === st.club).name}` : 'בחר קבוצה מהרשימה' }),
            h('button', { class: 'primary', disabled: !st.club, text: 'התחל קריירה', onclick: () => {
              loading('בונה את העולם...');
              setTimeout(async () => {
                S = E.newState(world, { mode: 'manager' });
                E.startManager(S, st.club, st.name.trim() || 'המנג\'ר');
                slot = `mgr-${Date.now().toString(36)}`;
                tab = 'home';
                await saveGame(true);
                gameScreen();
              }, 30);
            } }))));
    };
    render();
  }

  // ---------- new pro ----------
  const NATS = [
    ['Israel', 'ישראל'], ['England', 'אנגליה'], ['Spain', 'ספרד'], ['Germany', 'גרמניה'], ['Italy', 'איטליה'], ['France', 'צרפת'],
    ['Portugal', 'פורטוגל'], ['Netherlands', 'הולנד'], ['Belgium', 'בלגיה'], ['Brazil', 'ברזיל'], ['Argentina', 'ארגנטינה'],
    ['United States', 'ארה"ב'], ['Morocco', 'מרוקו'], ['Nigeria', 'ניגריה'], ['Ukraine', 'אוקראינה'],
  ];
  const NAT_HE = Object.fromEntries(NATS);
  const natName = (n) => NAT_HE[n] || n;
  const PRO_POS = ['ST', 'LW', 'RW', 'CAM', 'CM', 'CDM', 'LB', 'RB', 'CB', 'GK'];
  async function newProScreen() {
    loading('טוען את מסד הנתונים...');
    await loadWorld();
    const st = { name: '', nat: 'Israel', pos: 'ST', foot: 'R', country: 'isr', offers: null };
    const wrap = h('div', { class: 'wizard' });
    app.replaceChildren(wrap);
    let tmpState = null;
    const render = () => {
      const form = h('div', { class: 'card' },
        h('div', { class: 'form-grid' },
          h('label', null, 'שם השחקן', h('input', { value: st.name, maxlength: '26', placeholder: 'למשל: ליאור הראל', oninput: (e) => { st.name = e.target.value; } })),
          h('label', null, 'לאום', h('select', { onchange: (e) => { st.nat = e.target.value; } }, NATS.map(([v, l]) => h('option', { value: v, selected: v === st.nat, text: l })))),
          h('label', null, 'עמדה', h('select', { onchange: (e) => { st.pos = e.target.value; } }, PRO_POS.map((p) => h('option', { value: p, selected: p === st.pos, text: `${E.POS_HE[p]} (${p})` })))),
          h('label', null, 'רגל חזקה', h('select', { onchange: (e) => { st.foot = e.target.value; } }, h('option', { value: 'R', selected: st.foot === 'R', text: 'ימין' }), h('option', { value: 'L', selected: st.foot === 'L', text: 'שמאל' }))),
          h('label', null, 'איפה להתחיל', h('select', { onchange: (e) => { st.country = e.target.value; } },
            h('option', { value: '', text: 'כל מדינה' }), world.countries.map((c) => h('option', { value: c.id, selected: c.id === st.country, text: `${c.flag} ${c.name}` }))))),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { class: 'primary', text: 'קבל הצעות מקבוצות', onclick: () => {
            if (!st.name.trim()) return toast('תן שם לשחקן');
            loading('סוכנים מחפשים לך קבוצה...');
            setTimeout(() => {
              tmpState = E.newState(world, { mode: 'pro' });
              st.offers = E.proStartOffers(tmpState, st.country || null);
              render();
            }, 30);
          } })));
      const offers = st.offers && h('div', { class: 'card', style: { marginTop: '14px' } },
        h('h3', { text: 'הצעות חוזה' }),
        h('div', { class: 'club-grid' }, st.offers.map((c) => h('div', { class: 'card tight club-card', onclick: async () => {
          S = tmpState;
          E.createPro(S, { name: st.name.trim(), nat: st.nat, pos: st.pos, foot: st.foot, clubId: c.id });
          slot = `pro-${Date.now().toString(36)}`;
          tab = 'home';
          await saveGame(true);
          gameScreen();
        } }, crest(c, true), h('div', { class: 'info' }, h('div', { class: 'name', text: c.name }), h('div', { class: 'muted', text: leagueNameFrom(tmpState, c.league) })), ovrBadge(c.rep)))));
      app.replaceChildren(wrap);
      wrap.replaceChildren(
        h('div', { class: 'row spread' }, h('h2', { text: 'Be a Pro - צור את השחקן שלך' }), h('button', { class: 'ghost', text: '→ חזרה', onclick: startScreen })),
        form, offers);
    };
    render();
  }
  function leagueNameFrom(state, id) {
    const lg = state.leagues.find((l) => l.id === id);
    const c = state.countries.find((x) => x.id === lg.country);
    return `${c.flag} ${lg.name}`;
  }

  // ---------- game shell ----------
  const MANAGER_TABS = [['home', 'בית'], ['squad', 'סגל'], ['tactics', 'טקטיקה'], ['training', 'אימונים'], ['league', 'ליגות'], ['transfers', 'העברות'], ['inbox', 'דואר'], ['club', 'מועדון'], ['menu', 'תפריט']];
  const PRO_TABS = [['home', 'הקריירה שלי'], ['progress', 'יעדים והישגים'], ['training', 'אימון'], ['life', 'כסף וחוזה'], ['team', 'הקבוצה'], ['league', 'ליגות'], ['inbox', 'דואר'], ['history', 'היסטוריה'], ['menu', 'תפריט']];

  function lightness(hex) {
    const n = parseInt(String(hex).slice(1, 7), 16);
    return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  }
  // The club's most usable colour on a dark background (white kits fall back to the secondary colour).
  function clubColor(club) {
    const [a, b] = club.colors;
    if (lightness(a) > 225 && b && lightness(b) < 225) return b;
    return a;
  }
  function applyClubTheme(club) {
    const root = document.documentElement.style;
    root.setProperty('--c1', clubColor(club));
    root.setProperty('--c2', club.colors[1] && club.colors[1] !== clubColor(club) ? club.colors[1] : '#0b5d34');
  }
  function alpha(hex, a) {
    return `${String(hex).slice(0, 7)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
  }

  function gameScreen() {
    const club = S.clubs[userClubId()];
    applyClubTheme(club);
    const date = E.weekDate(S, S.week);
    const unread = S.inbox.filter((m) => !m.read).length;
    const fx = E.clubFixture(S, club.id, S.week);
    const contLabel = S.pendingInjury ? '🩹 פציעה' : S.pendingIntl ? '🎌 נבחרת' : S.pendingMonth ? '📅 סיכום חודשי' : fx && fx.m.hg === null ? '⚽ למשחק' : 'המשך ▸';
    const info = S.mode === 'manager'
      ? h('div', { class: 'row', style: { gap: '6px' } },
        h('span', { class: 'chip', text: `📅 ${dateFmt.format(date)}` }),
        h('span', { class: 'chip' }, '💰 ', h('span', { class: 'num ' + (club.balance < 0 ? 'bad' : ''), text: money(club.balance) })),
        h('span', { class: 'chip', text: E.windowOpen(S) ? '🟢 חלון העברות' : '🔴 חלון סגור' }))
      : h('div', { class: 'row', style: { gap: '6px' } },
        h('span', { class: 'chip', text: `📅 ${dateFmt.format(date)}` }),
        h('span', { class: 'chip' }, `${S.players[S.pro.pid].n} `, ovrBadge(S.players[S.pro.pid].ovr)));
    const tabs = S.mode === 'manager' ? MANAGER_TABS : PRO_TABS;
    const main = h('main');
    app.replaceChildren(
      h('div', { class: 'topbar' },
        h('div', { class: 'topbar-inner' },
          h('div', { class: 'club' }, crest(club, true), h('div', null, h('div', { text: club.name }), h('div', { class: 'meta', text: leagueName(club.league) }))),
          info,
          h('div', { class: 'continue-wrap' },
            h('button', { class: 'small', title: 'מדלג על כל המשחקים עד תחילת החודש הבא', text: '⏩ לחודש הבא', disabled: busy || !!S.pendingMonth || !!S.pendingIntl || !!S.pendingInjury, onclick: simToNextMonth }),
            h('button', { class: 'primary continue', text: contLabel, disabled: busy, onclick: onContinue }))),
        h('div', { class: 'nav' }, tabs.map(([id, label]) => h('button', { class: tab === id ? 'active' : '', onclick: () => { tab = id; gameScreen(); } },
          label, id === 'inbox' && unread ? h('span', { class: 'count', text: String(unread) }) : null)))),
      main);
    const views = {
      home: S.mode === 'manager' ? homeManager : homePro, squad: (m) => squadView(userClubId(), true, m), tactics: tacticsView,
      league: leagueView, transfers: transfersView, inbox: inboxView, club: clubView, menu: menuView,
      training: trainingView, team: (m) => squadView(userClubId(), false, m), history: historyView, progress: progressView, life: lifeView,
    };
    (views[tab] || views.home)(main);
    window.scrollTo(0, 0);
    showPending();
  }

  // ---------- manager home ----------
  function nextFixtures(clubId, n) {
    return E.clubSchedule(S, clubId).filter((f) => f.m.hg === null).slice(0, n);
  }
  function lastResults(clubId, n) {
    return E.clubSchedule(S, clubId).filter((f) => f.m.hg !== null).slice(-n).reverse();
  }
  function fixtureRow(f, clubId) {
    const home = f.m.h === clubId;
    const opp = S.clubs[home ? f.m.a : f.m.h];
    let res = null;
    if (f.m.hg !== null) {
      const gf = home ? f.m.hg : f.m.ag;
      const ga = home ? f.m.ag : f.m.hg;
      res = h('b', { class: gf > ga ? 'good num' : gf < ga ? 'bad num' : 'num', text: `${gf}-${ga}` });
    }
    return h('tr', null,
      h('td', { class: 'muted', text: shortDate.format(E.weekDate(S, f.week)) }),
      h('td', { text: home ? 'בית' : 'חוץ' }),
      h('td', null, clubLabel(opp)),
      h('td', { class: 'c' }, res || ''));
  }
  function positionOf(clubId) {
    const t = E.sortedTable(S, S.clubs[clubId].league);
    return t.findIndex((r) => r.id === clubId) + 1;
  }
  function miniTable(clubId) {
    const t = E.sortedTable(S, S.clubs[clubId].league);
    const i = t.findIndex((r) => r.id === clubId);
    const start = Math.max(0, Math.min(t.length - 7, i - 3));
    return h('table', null, h('tbody', null, t.slice(start, start + 7).map((r, k) => h('tr', { class: r.id === clubId ? 'me' : '' },
      h('td', { class: 'c', text: String(start + k + 1) }), h('td', null, clubLabel(S.clubs[r.id])),
      h('td', { class: 'c num', text: String(r.p) }), h('td', { class: 'c num', text: `${r.gd > 0 ? '+' : ''}${r.gd}` }), h('td', { class: 'c' }, h('b', { text: String(r.pts) }))))));
  }

  function kpi(ico, label, value, sub, extra) {
    return h('div', { class: 'card kpi' }, extra || h('div', { class: 'ico', text: ico }),
      h('div', null, h('div', { class: 'lbl', text: label }), h('div', { class: 'val' }, value), sub ? h('div', { class: 'sub', text: sub }) : null));
  }
  function ring(pct, color) {
    const r = h('div', { class: 'ring' }, h('span', { class: 'num', text: String(Math.round(pct)) }));
    r.style.setProperty('--p', String(pct));
    r.style.setProperty('--col', color || (pct >= 60 ? 'var(--accent)' : pct >= 35 ? 'var(--accent2)' : 'var(--danger)'));
    return r;
  }
  function heroMatch(clubId, next) {
    if (!next) return h('div', { class: 'card' }, h('h3', { text: 'המשחק הבא' }), h('p', { class: 'muted', text: 'אין משחקים נוספים העונה.' }));
    const home = S.clubs[next.m.h];
    const away = S.clubs[next.m.a];
    const side = (c) => {
      const el = h('div', { class: 'side' }, crest(c, true), h('div', { class: 'nm', text: c.name }),
        h('div', { class: 'sub', text: `מקום ${positionOf(c.id)}` }), formDots(c.form.slice(-5)));
      el.style.background = `linear-gradient(160deg, ${alpha(clubColor(c), 0.55)}, ${alpha(clubColor(c), 0.08)})`;
      el.querySelector('.badge').classList.add('huge');
      return el;
    };
    return h('div', { class: 'card hero-match' },
      h('span', { class: 'hero-label chip', text: next.m.h === clubId ? '🏟 משחק בית' : '✈ משחק חוץ' }),
      side(home),
      h('div', { class: 'mid' }, h('div', { class: 'vs', text: 'VS' }), h('div', { class: 'when', text: dateFmt.format(E.weekDate(S, next.week)) }),
        S.mode === 'manager' ? h('button', { class: 'small', text: 'טקטיקה', onclick: () => { tab = 'tactics'; gameScreen(); } }) : null),
      side(away));
  }
  function monthCalendar(clubId) {
    const key = E.monthKeyOf(S, S.week);
    const games = E.clubSchedule(S, clubId).filter((f) => E.monthKeyOf(S, f.week) === key);
    const next = games.find((f) => f.m.hg === null);
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: `החודש · ${E.monthLabel(key)}` }), h('span', { class: 'muted', text: `${games.length} משחקים` })),
      games.length ? h('div', { class: 'calendar' }, games.map((f) => {
        const home = f.m.h === clubId;
        const opp = S.clubs[home ? f.m.a : f.m.h];
        let res = h('span', { class: 'muted', text: f === next ? 'הבא' : '—' });
        if (f.m.hg !== null) {
          const gf = home ? f.m.hg : f.m.ag;
          const ga = home ? f.m.ag : f.m.hg;
          res = h('span', { class: `res num ${gf > ga ? 'W' : gf < ga ? 'L' : 'D'}`, text: `${gf}-${ga}` });
        }
        return h('div', { class: 'cal-cell' + (f === next ? ' now' : ''), title: opp.name },
          h('span', { class: 'muted', text: shortDate.format(E.weekDate(S, f.week)) }), crest(opp, true), h('span', { text: home ? 'בית' : 'חוץ' }), res);
      })) : h('p', { class: 'muted', text: 'אין משחקים החודש.' }));
  }

  function homeManager(main) {
    const club = S.clubs[S.user.clubId];
    const table = E.sortedTable(S, club.league);
    const pos = positionOf(club.id);
    const row = S.tables[club.league][club.id];
    const next = nextFixtures(club.id, 1)[0];
    const wages = E.squad(S, club.id).reduce((s, p) => s + p.w, 0);
    const conf = S.user.confidence === undefined ? 60 : S.user.confidence;
    const tr = E.trainingOf(club);
    main.append(
      h('div', { class: 'kpis' },
        kpi('🏆', 'מקום בליגה', h('span', null, h('span', { class: row.p === 0 ? '' : pos <= S.user.expected ? 'good' : pos > S.user.expected + 4 ? 'bad' : 'warn', text: String(pos) }), h('span', { class: 'muted', style: { fontSize: '14px' }, text: ` / ${table.length}` })), `ציפייה: מקום ${S.user.expected}`),
        kpi('📊', 'נקודות', String(row.pts), `${row.w} נ' · ${row.d} ת' · ${row.l} ה'`),
        kpi('', 'אמון ההנהלה', `${conf}%`, conf >= 60 ? 'יציב' : conf >= 35 ? 'בלחץ' : 'בסכנת פיטורים', ring(conf)),
        kpi('💰', 'מאזן שבועי', h('span', { class: 'num ' + (club.income - wages < 0 ? 'bad' : 'good'), text: money(club.income - wages) }), `יתרה ${money(club.balance)}`),
        kpi('🏋', 'אימון החודש', E.TRAINING_FOCUS[tr.focus].label, `עצימות ${E.TRAINING_INTENSITY[tr.intensity].label}`)),
      h('div', { class: 'grid two' },
        heroMatch(club.id, next),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: leagueName(club.league) }), h('button', { class: 'small', text: 'טבלה מלאה', onclick: () => { tab = 'league'; gameScreen(); } })), miniTable(club.id)),
        h('div', { class: 'span-all' }, monthCalendar(club.id)),
        h('div', { class: 'card' }, h('h3', { text: 'תוצאות אחרונות' }), h('table', null, h('tbody', null, lastResults(club.id, 5).map((f) => fixtureRow(f, club.id)))),
          lastResults(club.id, 1).length ? null : h('p', { class: 'muted', text: 'העונה עוד לא התחילה.' })),
        h('div', { class: 'card' }, h('h3', { text: 'חדשות העברות' }),
          S.news.length ? S.news.slice(0, 7).map((n) => h('p', { style: { margin: '6px 0' }, text: `• ${n.text}` })) : h('p', { class: 'muted', text: 'אין חדשות עדיין.' }))));
  }

  // ---------- squad ----------
  const sortState = { key: 'pos', dir: 1 };
  const POS_ORDER = ['GK', 'RB', 'RWB', 'CB', 'LB', 'LWB', 'CDM', 'CM', 'RM', 'LM', 'CAM', 'RW', 'LW', 'CF', 'ST'];
  function squadView(clubId, editable, main) {
    const club = S.clubs[clubId];
    const players = E.squad(S, clubId);
    const cols = [
      ['pos', 'עמדה', (p) => POS_ORDER.indexOf(p.pos)], ['n', 'שם', (p) => p.n], ['age', 'גיל', (p) => p.age], ['ovr', 'יכולת', (p) => p.ovr],
      ['cond', 'כושר', (p) => p.cond], ['morale', 'מורל', (p) => p.morale], ['v', 'שווי', (p) => p.v], ['w', 'שכר', (p) => p.w],
      ['app', 'הופ\'', (p) => p.st.app], ['gl', 'שערים', (p) => p.st.gl], ['as', 'בישולים', (p) => p.st.as], ['rt', 'ציון', (p) => E.avgRating(p)],
    ];
    const col = cols.find((c) => c[0] === sortState.key) || cols[0];
    players.sort((a, b) => {
      const x = col[2](a);
      const y = col[2](b);
      return (x < y ? -1 : x > y ? 1 : b.ovr - a.ovr) * sortState.dir;
    });
    const rerender = () => gameScreen();
    const table = h('table', null,
      h('thead', null, h('tr', null, cols.map(([k, label]) => h('th', {
        class: 'sortable' + (sortState.key === k ? ' sorted' : '') + (k === 'n' ? '' : ' c'),
        onclick: () => { sortState.dir = sortState.key === k ? -sortState.dir : k === 'n' || k === 'pos' ? 1 : -1; sortState.key = k; rerender(); },
        text: label,
      })))),
      h('tbody', null, players.map((p) => h('tr', { class: 'click' + (S.pro && p.id === S.pro.pid ? ' me' : ''), onclick: () => playerModal(p.id) },
        h('td', { class: 'c' }, posPill(p.pos)),
        h('td', null, h('span', { text: p.n }), p.inj > 0 ? h('span', { class: 'bad', title: `פצוע ${p.inj} שבועות`, text: ' ✚' }) : null,
          p.sus > 0 ? h('span', { class: 'bad', title: 'מושעה', text: ' 🟥' }) : null, p.listed ? h('span', { class: 'warn', title: 'ברשימת העברות', text: ' ⇄' }) : null),
        h('td', { class: 'c num', text: String(p.age) }), h('td', { class: 'c' }, ovrBadge(p.ovr)),
        h('td', { class: 'c num ' + (p.cond < 70 ? 'bad' : ''), text: `${Math.round(p.cond)}%` }),
        h('td', { class: 'c', text: p.morale >= 75 ? '😀' : p.morale >= 50 ? '🙂' : p.morale >= 30 ? '😐' : '☹️' }),
        h('td', { class: 'c num', text: money(p.v) }), h('td', { class: 'c num', text: money(p.w) }),
        h('td', { class: 'c num', text: String(p.st.app) }), h('td', { class: 'c num', text: String(p.st.gl) }), h('td', { class: 'c num', text: String(p.st.as) }),
        h('td', { class: 'c num', text: p.st.app ? E.avgRating(p).toFixed(2) : '-' })))));
    main.append(h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h3', { text: `הסגל של ${club.name} (${players.length})` }),
        editable ? h('span', { class: 'muted', text: 'לחץ על שחקן לפרטים, רשימת העברות ושחרור' }) : null),
      h('div', { class: 'table-wrap' }, table)));
  }

  function attrBars(p, xp) {
    const labels = p.pos === 'GK' ? E.GK_ATTR_HE : E.ATTR_HE;
    return h('div', null, p.at.map((v, i) => h('div', { class: 'attr' },
      h('span', { text: labels[i] }),
      h('div', null, h('div', { class: 'bar' }, h('i', { style: { width: `${v}%`, background: ovrColor(v) } })),
        xp ? h('div', { class: 'bar xp' }, h('i', { style: { width: `${Math.min(100, xp[i] || 0)}%` } })) : null),
      h('b', { class: 'num', text: String(v) }))));
  }

  function playerModal(pid) {
    const p = S.players[pid];
    if (!p) return;
    const club = S.clubs[p.c];
    const own = S.mode === 'manager' && p.c === S.user.clubId;
    const isPro = S.pro && p.id === S.pro.pid;
    const potText = own || isPro ? `${p.pot}` : `${Math.max(p.ovr, p.pot - 4)}-${p.pot + 3}`;
    openModal((close) => {
      const actions = h('div', { class: 'row', style: { marginTop: '14px' } });
      if (own) {
        actions.append(h('span', { class: 'muted', text: 'אימון אישי:' }), planSelect(p, () => { close(); gameScreen(); playerModal(p.id); }));
        actions.append(
          h('button', { text: p.listed ? 'הסר מרשימת העברות' : 'הכנס לרשימת העברות', onclick: () => { p.listed = !p.listed; close(); toast(p.listed ? `${p.n} ברשימת העברות. הצעות יגיעו לדואר.` : 'הוסר מהרשימה'); gameScreen(); } }),
          h('button', { class: 'danger', text: 'שחרר', onclick: () => confirmBox(`לשחרר את ${p.n}? תשלם פיצוי על יתרת החוזה.`, () => {
            const r = E.releasePlayer(S, p.id);
            toast(r.reason);
            close();
            gameScreen();
          }) }));
      } else if (S.mode === 'manager') {
        const ask = E.askingPrice(S, p);
        const input = h('input', { type: 'number', min: '0', step: '10000', value: String(ask), style: { width: '160px' } });
        const result = h('p', { class: 'muted' });
        actions.append(
          h('span', { class: 'muted', text: 'הצעה (€):' }), input,
          h('button', { class: 'primary', text: 'הגש הצעה', disabled: !E.windowOpen(S), onclick: () => {
            const fee = Math.round(Number(input.value) || 0);
            const r = E.makeOffer(S, p.id, fee);
            result.textContent = r.reason;
            result.className = r.status === 'done' ? 'good' : r.status === 'counter' ? 'warn' : 'bad';
            if (r.status === 'counter') input.value = String(r.ask);
            if (r.status === 'done') { saveGame(true); setTimeout(() => { close(); gameScreen(); }, 1200); }
          } }),
          E.windowOpen(S) ? null : h('span', { class: 'bad', text: 'חלון ההעברות סגור' }));
        return [modalHead(p.fn && p.fn !== p.n ? `${p.n} · ${p.fn}` : p.n, close), playerBody(p, club, potText), actions, result];
      }
      return [modalHead(p.fn && p.fn !== p.n ? `${p.n} · ${p.fn}` : p.n, close), playerBody(p, club, potText), actions];
    });
  }
  function playerBody(p, club, potText) {
    return h('div', { class: 'grid two' },
      h('div', null,
        h('div', { class: 'row' }, ovrBadge(p.ovr, true), h('div', null,
          h('div', null, posPill(p.pos), ' ', (p.alt || []).map((a) => [posPill(a), ' '])),
          h('div', { class: 'muted', text: `${E.POS_HE[p.pos] || p.pos} · גיל ${p.age} · ${natName(p.nat)} · רגל ${p.ft === 'L' ? 'שמאל' : 'ימין'}` }),
          h('div', { style: { marginTop: '4px' } }, clubLabel(club)))),
        h('dl', { class: 'kv', style: { marginTop: '14px' } },
          h('dt', { text: 'פוטנציאל' }), h('dd', { text: potText }),
          h('dt', { text: 'שווי' }), h('dd', { class: 'num', text: money(p.v) }),
          h('dt', { text: 'שכר שבועי' }), h('dd', { class: 'num', text: money(p.w) }),
          h('dt', { text: 'חוזה עד' }), h('dd', { text: String(p.ctr) }),
          h('dt', { text: 'כושר / מורל' }), h('dd', { text: `${Math.round(p.cond)}% / ${Math.round(p.morale)}` }),
          p.inj > 0 ? [h('dt', { text: 'פציעה' }), h('dd', { class: 'bad', text: `${p.inj} שבועות` })] : null,
          h('dt', { text: 'העונה' }), h('dd', { text: `${p.st.app} הופעות · ${p.st.gl} שערים · ${p.st.as} בישולים · ציון ${p.st.app ? E.avgRating(p).toFixed(2) : '-'}` }),
          p.gen ? [h('dt', { text: 'מקור' }), h('dd', { class: 'muted', text: 'שחקן שנוצר במשחק' })] : null,
          p.real ? [h('dt', { text: 'מקור' }), h('dd', null, h('span', { class: 'tag real', text: 'שחקן אמיתי · Transfermarkt' }))] : null)),
      h('div', null, h('h3', { text: 'תכונות' }), attrBars(p)));
  }

  // ---------- tactics ----------
  const ROW_Y = { GK: 91, LB: 72, CB: 76, RB: 72, LWB: 62, RWB: 62, CDM: 60, CM: 46, LM: 46, RM: 46, CAM: 33, LW: 22, RW: 22, ST: 12, CF: 16 };
  const SIDE = { LB: -1, LWB: -1, LM: -1, LW: -1, RB: 1, RWB: 1, RM: 1, RW: 1 };
  function slotPositions(formation) {
    const slots = E.FORMATIONS[formation];
    const rows = {};
    slots.forEach((s, i) => {
      const y = ROW_Y[s];
      (rows[y] || (rows[y] = [])).push(i);
    });
    const out = [];
    for (const [y, idxs] of Object.entries(rows)) {
      const sorted = idxs.slice().sort((a, b) => (SIDE[slots[a]] || 0) - (SIDE[slots[b]] || 0));
      const n = sorted.length;
      const hasWide = sorted.some((i) => SIDE[slots[i]]);
      // rows with wide players span the pitch; central-only rows stay compact
      const width = hasWide ? 76 : Math.min(60, 24 * (n - 1));
      sorted.forEach((i, k) => {
        const x = n === 1 ? 50 : 50 - width / 2 + (width * k) / (n - 1);
        out[i] = { x, y: Number(y) };
      });
    }
    return out;
  }
  function tacticsView(main) {
    const club = S.clubs[S.user.clubId];
    const lu = E.lineupFor(S, club.id);
    const commit = (xi, bench) => {
      club.lineup = { formation: club.formation, xi, bench };
      gameScreen();
    };
    const slots = E.FORMATIONS[club.formation];
    const pos = slotPositions(club.formation);
    const pitch = h('div', { class: 'pitch' }, h('div', { class: 'box-top' }), h('div', { class: 'box-bottom' }),
      slots.map((s, i) => {
        const p = lu.xi[i] ? S.players[lu.xi[i]] : null;
        const fitV = p ? E.fit(p, s) : 0;
        const el = h('div', { class: 'slot', style: { left: `${pos[i].x}%`, top: `${pos[i].y}%` }, onclick: () => chooseForSlot(i) },
          h('div', { class: 'shirt', style: { background: club.colors[0], color: textOn(club.colors[0]) }, text: p ? String(p.ovr) : '?' }),
          h('div', { class: 'nm' }, h('span', { class: fitV < 0.9 ? 'fit-bad' : '', text: `${s} ` }), p ? p.n : '—'));
        return el;
      }));
    function chooseForSlot(i) {
      const s = slots[i];
      const cands = E.squad(S, club.id).sort((a, b) => E.effective(b, s) - E.effective(a, s));
      openModal((close) => [modalHead(`בחר שחקן ל${E.POS_HE[s] || s} (${s})`, close),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, cands.map((p) => {
          const inXi = lu.xi.indexOf(p.id);
          const unavailable = !E.available(p);
          return h('tr', { class: unavailable ? '' : 'click', onclick: () => {
            if (unavailable) return;
            const xi = lu.xi.slice();
            let bench = lu.bench.filter((id) => id !== p.id);
            if (inXi >= 0) xi[inXi] = xi[i];
            else if (xi[i]) bench = [xi[i], ...bench];
            xi[i] = p.id;
            close();
            commit(xi, bench.slice(0, 9));
          } },
          h('td', null, posPill(p.pos)), h('td', { text: p.n }), h('td', null, ovrBadge(p.ovr)),
          h('td', { class: 'num', text: `התאמה ${Math.round(E.fit(p, s) * 100)}%` }),
          h('td', { class: 'num', text: `${Math.round(p.cond)}%` }),
          h('td', { class: unavailable ? 'bad' : 'muted', text: unavailable ? (p.inj ? 'פצוע' : 'מושעה') : inXi >= 0 ? 'בהרכב' : lu.bench.includes(p.id) ? 'ספסל' : '' }));
        }))))], { wide: true });
    }
    const strength = lu.xi.reduce((s, id, i) => s + (id ? E.effective(S.players[id], slots[i]) : 0), 0) / 11;
    main.append(h('div', { class: 'grid two' },
      h('div', { class: 'card' }, pitch),
      h('div', null,
        h('div', { class: 'card' }, h('h3', { text: 'מערך וגישה' }),
          h('div', { class: 'row' },
            h('label', null, 'מערך ', h('select', { onchange: (e) => { club.formation = e.target.value; club.lineup = null; gameScreen(); } },
              Object.keys(E.FORMATIONS).map((f) => h('option', { value: f, selected: f === club.formation, text: f })))),
            h('label', null, 'גישה ', h('select', { onchange: (e) => { club.mentality = e.target.value; gameScreen(); } },
              Object.entries(E.MENTALITIES).map(([k, m]) => h('option', { value: k, selected: k === club.mentality, text: m.label }))))),
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { text: 'הרכב אוטומטי', onclick: () => { club.lineup = null; gameScreen(); } }),
            h('button', { text: 'מערך מומלץ', onclick: () => { club.formation = E.bestFormation(S, club.id); club.lineup = null; gameScreen(); } }),
            h('span', { class: 'muted', text: `חוזק ממוצע: ${strength.toFixed(1)}` })),
          h('p', { class: 'muted', text: 'לחץ על עמדה במגרש כדי לבחור שחקן. עמדה אדומה = שחקן לא בעמדה הטבעית שלו.' })),
        h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { text: 'ספסל' }),
          h('table', null, h('tbody', null, lu.bench.map((id) => {
            const p = S.players[id];
            return h('tr', { class: 'click', onclick: () => playerModal(id) }, h('td', null, posPill(p.pos)), h('td', { text: p.n }), h('td', null, ovrBadge(p.ovr)), h('td', { class: 'num', text: `${Math.round(p.cond)}%` }));
          }))),
          (() => {
            const out = E.squad(S, club.id).filter((p) => !E.available(p));
            return out.length ? h('p', { class: 'bad', text: `לא זמינים: ${out.map((p) => `${p.n} (${p.inj ? 'פצוע' : 'מושעה'})`).join(', ')}` }) : null;
          })()))));
  }
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const l = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return l > 150 ? '#111' : '#fff';
  }

  // ---------- league ----------
  let leagueSel = null;
  let roundSel = null;
  function leagueView(main) {
    const mine = S.clubs[userClubId()].league;
    if (!leagueSel || !S.leagues.find((l) => l.id === leagueSel)) leagueSel = mine;
    const lg = S.leagues.find((l) => l.id === leagueSel);
    const table = E.sortedTable(S, lg.id);
    const rounds = S.fixtures[lg.id];
    const played = rounds.filter((r) => r.matches.every((m) => m.hg !== null)).length;
    if (roundSel === null || roundSel >= rounds.length) roundSel = Math.min(played, rounds.length - 1);
    const round = rounds[roundSel];
    const n = table.length;
    const scorers = Object.values(S.players).filter((p) => S.clubs[p.c] && S.clubs[p.c].league === lg.id && p.st.gl > 0).sort((a, b) => b.st.gl - a.st.gl || b.st.as - a.st.as).slice(0, 10);
    main.append(
      h('div', { class: 'tabs' }, S.countries.map((c) => h('button', {
        class: S.leagues.find((l) => l.id === leagueSel).country === c.id ? 'active' : '', text: `${c.flag} ${c.name}`,
        onclick: () => { leagueSel = S.leagues.find((l) => l.country === c.id && l.tier === lg.tier).id; roundSel = null; gameScreen(); },
      }))),
      h('div', { class: 'tabs' }, S.leagues.filter((l) => l.country === lg.country).map((l) => h('button', { class: l.id === lg.id ? 'active' : '', text: l.name, onclick: () => { leagueSel = l.id; roundSel = null; gameScreen(); } }))),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h3', { text: leagueName(lg.id) }),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['#', 'קבוצה', 'מש\'', 'נ', 'ת', 'ה', 'שערים', 'הפרש', 'נק\'', 'כושר'].map((t) => h('th', { class: t === 'קבוצה' ? '' : 'c', text: t })))),
            h('tbody', null, table.map((r, i) => h('tr', {
              class: [r.id === userClubId() ? 'me' : '', lg.up && i < lg.up ? 'zone-up' : '', lg.down && i >= n - lg.down ? 'zone-down' : '', lg.tier === 1 && i === 0 ? 'zone-up' : ''].join(' '),
            }, h('td', { class: 'c', text: String(i + 1) }), h('td', null, clubLabel(S.clubs[r.id])),
            h('td', { class: 'c num', text: String(r.p) }), h('td', { class: 'c num', text: String(r.w) }), h('td', { class: 'c num', text: String(r.d) }), h('td', { class: 'c num', text: String(r.l) }),
            h('td', { class: 'c num', text: `${r.gf}:${r.ga}` }), h('td', { class: 'c num', text: `${r.gd > 0 ? '+' : ''}${r.gd}` }),
            h('td', { class: 'c' }, h('b', { text: String(r.pts) })), h('td', { class: 'c' }, formDots(S.clubs[r.id].form.slice(-5))))))))),
        h('div', null,
          h('div', { class: 'card' },
            h('div', { class: 'row spread' },
              h('button', { class: 'small', text: '→', disabled: roundSel <= 0, onclick: () => { roundSel--; gameScreen(); } }),
              h('h3', { style: { margin: 0 }, text: `מחזור ${roundSel + 1} · ${shortDate.format(E.weekDate(S, round.week))}` }),
              h('button', { class: 'small', text: '←', disabled: roundSel >= rounds.length - 1, onclick: () => { roundSel++; gameScreen(); } })),
            h('table', null, h('tbody', null, round.matches.map((m) => h('tr', { class: m.h === userClubId() || m.a === userClubId() ? 'me' : '' },
              h('td', null, clubLabel(S.clubs[m.h])),
              h('td', { class: 'c num' }, h('b', { text: m.hg === null ? '-' : `${m.hg} : ${m.ag}` })),
              h('td', null, clubLabel(S.clubs[m.a]))))))),
          h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { text: 'מלך השערים' }),
            scorers.length ? h('table', null, h('tbody', null, scorers.map((p, i) => h('tr', { class: 'click', onclick: () => playerModal(p.id) },
              h('td', { class: 'c', text: String(i + 1) }), h('td', { text: p.n }), h('td', null, crest(S.clubs[p.c])),
              h('td', { class: 'c num' }, h('b', { text: String(p.st.gl) })), h('td', { class: 'c num muted', text: `${p.st.as} בישולים` })))))
              : h('p', { class: 'muted', text: 'עוד לא הובקעו שערים.' })))));
  }

  // ---------- transfers ----------
  const tf = { q: '', g: '', league: '', maxV: '', minO: '', maxAge: '' };
  function transfersView(main) {
    const open = E.windowOpen(S);
    const club = S.clubs[S.user.clubId];
    const results = h('tbody');
    const renderResults = () => {
      const q = tf.q.trim().toLowerCase();
      const list = [];
      for (const p of Object.values(S.players)) {
        if (p.c === club.id) continue;
        if (q && !p.n.toLowerCase().includes(q) && !(p.fn || '').toLowerCase().includes(q)) continue;
        if (tf.g && E.group(p.pos) !== tf.g) continue;
        if (tf.league && S.clubs[p.c].league !== tf.league) continue;
        if (tf.maxV && p.v > Number(tf.maxV) * 1e6) continue;
        if (tf.minO && p.ovr < Number(tf.minO)) continue;
        if (tf.maxAge && p.age > Number(tf.maxAge)) continue;
        list.push(p);
      }
      list.sort((a, b) => b.ovr - a.ovr || a.v - b.v);
      results.replaceChildren(...list.slice(0, 80).map((p) => h('tr', { class: 'click', onclick: () => playerModal(p.id) },
        h('td', null, posPill(p.pos)), h('td', { text: p.n }), h('td', { class: 'c num', text: String(p.age) }), h('td', { class: 'c' }, ovrBadge(p.ovr)),
        h('td', null, clubLabel(S.clubs[p.c])), h('td', { class: 'c num', text: money(p.v) }), h('td', { class: 'c num muted', text: money(p.w) }))));
      if (!list.length) results.appendChild(h('tr', null, h('td', { class: 'muted', text: 'אין תוצאות' })));
    };
    const input = (key, props) => h('input', { ...props, value: tf[key], oninput: (e) => { tf[key] = e.target.value; renderResults(); } });
    const select = (key, options) => h('select', { onchange: (e) => { tf[key] = e.target.value; renderResults(); } }, options.map(([v, l]) => h('option', { value: v, selected: tf[key] === v, text: l })));
    const listed = E.squad(S, club.id).filter((p) => p.listed);
    main.append(
      h('div', { class: 'card ' + (open ? '' : ''), style: { marginBottom: '14px' } },
        h('div', { class: 'row spread' },
          h('b', { class: open ? 'good' : 'bad', text: open ? '🟢 חלון ההעברות פתוח' : '🔴 חלון ההעברות סגור (נפתח בקיץ ובינואר)' }),
          h('span', null, 'תקציב: ', h('b', { class: 'num', text: money(club.balance) })))),
      h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0, 3fr) minmax(0, 1.3fr)' } },
        h('div', { class: 'card' }, h('h3', { text: 'חיפוש שחקנים' }),
          h('div', { class: 'row', style: { marginBottom: '10px' } },
            input('q', { placeholder: 'שם', style: { width: '140px' } }),
            select('g', [['', 'כל העמדות'], ['G', 'שוערים'], ['D', 'הגנה'], ['M', 'קישור'], ['A', 'התקפה']]),
            select('league', [['', 'כל הליגות'], ...S.leagues.map((l) => [l.id, leagueName(l.id)])]),
            input('minO', { type: 'number', placeholder: 'יכולת מינ\'', style: { width: '100px' } }),
            input('maxV', { type: 'number', placeholder: 'שווי מקס\' (מיליון)', style: { width: '150px' } }),
            input('maxAge', { type: 'number', placeholder: 'גיל מקס\'', style: { width: '90px' } })),
          h('div', { class: 'table-wrap' }, h('table', null,
            h('thead', null, h('tr', null, ['עמדה', 'שם', 'גיל', 'יכולת', 'קבוצה', 'שווי', 'שכר'].map((t) => h('th', { text: t })))), results))),
        h('div', null,
          h('div', { class: 'card' }, h('h3', { text: 'השחקנים שלי ברשימת העברות' }),
            listed.length ? listed.map((p) => h('p', { class: 'row' }, posPill(p.pos), p.n, ovrBadge(p.ovr), h('span', { class: 'muted num', text: money(p.v) })))
              : h('p', { class: 'muted', text: 'אין. פתח שחקן בסגל כדי להכניס אותו לרשימה.' })),
          h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { text: 'העברות אחרונות' }),
            S.transfersLog.slice(0, 12).map((t) => h('p', { style: { margin: '6px 0', fontSize: '13px' } },
              h('b', { text: t.name }), ` ${pre('מ', S.clubs[t.from].name)} ${pre('ל', S.clubs[t.to].name)} `, h('span', { class: 'num muted', text: money(t.fee) })))))));
    renderResults();
  }

  // ---------- inbox ----------
  function inboxView(main) {
    const list = h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h3', { text: 'דואר' }),
      h('button', { class: 'small', text: 'סמן הכל כנקרא', onclick: () => { S.inbox.forEach((m) => { m.read = true; }); gameScreen(); } })));
    if (!S.inbox.length) list.appendChild(h('p', { class: 'muted', text: 'אין הודעות.' }));
    for (const m of S.inbox) {
      const actions = [];
      if (m.bid && !m.done) {
        actions.push(h('button', { class: 'primary small', text: 'קבל', disabled: !E.windowOpen(S), onclick: () => { toast(E.acceptBid(S, m.id) || ''); saveGame(true); gameScreen(); } }),
          h('button', { class: 'small', text: 'דחה', onclick: () => { E.rejectBid(S, m.id); gameScreen(); } }));
      }
      if (m.kind === 'proOffer' && !m.done) {
        actions.push(h('button', { class: 'primary small', text: 'משא ומתן', onclick: () => {
          const offer = S.pro.offers.find((o) => o.club === m.offer.club);
          if (offer) negotiateModal(offer); else toast('ההצעה כבר לא בתוקף');
        } }),
          h('button', { class: 'small', text: 'דחה הכל', onclick: () => { E.proDeclineOffers(S); gameScreen(); } }));
      }
      list.appendChild(h('div', { class: 'msg' + (m.read ? '' : ' unread'), onclick: () => { if (!m.read) { m.read = true; } } },
        h('div', { class: 'row spread' }, h('span', { class: 'title', text: m.title }), h('span', { class: 'muted', text: `${E.seasonLabel(m.season)} · שבוע ${m.week}` })),
        h('p', { style: { margin: '6px 0' }, text: m.body }),
        m.done ? h('span', { class: 'muted', text: m.done === 'accepted' ? '✔ התקבל' : '✖ נדחה' }) : h('div', { class: 'row' }, actions)));
    }
    main.append(list);
    setTimeout(() => { S.inbox.forEach((m) => { m.read = true; }); }, 0);
  }

  // ---------- club ----------
  function clubView(main) {
    const club = S.clubs[S.user.clubId];
    const wages = E.squad(S, club.id).reduce((s, p) => s + p.w, 0);
    main.append(h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', { text: 'כספים' }), h('dl', { class: 'kv' },
        h('dt', { text: 'יתרה' }), h('dd', { class: 'num', text: money(club.balance) }),
        h('dt', { text: 'הכנסה שבועית' }), h('dd', { class: 'num', text: money(club.income) }),
        h('dt', { text: 'שכר שבועי' }), h('dd', { class: 'num', text: money(wages) }),
        h('dt', { text: 'מאזן שבועי' }), h('dd', { class: 'num ' + (club.income - wages < 0 ? 'bad' : 'good'), text: money(club.income - wages) })),
      h('p', { class: 'muted', text: 'שכר גבוה מההכנסה מוריד את היתרה כל שבוע. בסוף עונה מתקבל פרס כספי לפי המיקום בטבלה.' })),
      h('div', { class: 'card' }, h('h3', { text: 'הקריירה שלך' }),
        S.user.career.length ? h('table', null, h('tbody', null, S.user.career.slice().reverse().map((c) => h('tr', null,
          h('td', { text: E.seasonLabel(c.season) }), h('td', null, clubLabel(S.clubs[c.club])), h('td', { text: leagueName(c.league) }), h('td', { text: `מקום ${c.pos}` })))))
          : h('p', { class: 'muted', text: 'עונה ראשונה.' })),
      h('div', { class: 'card' }, h('h3', { text: 'היסטוריית אלופות' }), championsTable())));
  }
  function championsTable() {
    if (!S.history.length) return h('p', { class: 'muted', text: 'עדיין לא הסתיימה עונה.' });
    return h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { text: 'עונה' }), S.leagues.filter((l) => l.tier === 1).map((l) => h('th', { text: leagueName(l.id) })))),
      h('tbody', null, S.history.map((hs) => h('tr', null, h('td', { text: E.seasonLabel(hs.season) }),
        S.leagues.filter((l) => l.tier === 1).map((l) => h('td', null, hs.champions[l.id] ? clubLabel(S.clubs[hs.champions[l.id]]) : '')))))));
  }

  function menuView(main) {
    main.append(h('div', { class: 'card' }, h('h3', { text: 'תפריט' }),
      h('div', { class: 'row' },
        h('button', { class: 'primary', text: '💾 שמור עכשיו', onclick: () => saveGame() }),
        h('button', { text: '⬇ ייצוא קובץ שמירה', onclick: exportSave }),
        h('button', { text: 'חזרה לתפריט הראשי', onclick: async () => { await saveGame(true); startScreen(); } })),
      h('p', { class: 'muted', text: 'המשחק נשמר אוטומטית בשרת אחרי כל שבוע, כך שאפשר להמשיך מכל מכשיר שמחובר ל-VPN.' }),
      h('p', { class: 'muted', text: 'נתוני שחקנים: EA FC 26 (ספטמבר 2025). סגלי הקבוצות הישראליות נוצרו אוטומטית.' })));
  }

  // ---------- Be a Pro views ----------
  function homePro(main) {
    const pro = S.pro;
    const p = S.players[pro.pid];
    const club = S.clubs[p.c];
    const role = E.proSquadRole(S);
    const next = nextFixtures(club.id, 1)[0];
    const recent = pro.lastRatings.slice(-8);
    const trust = pro.trust === undefined ? 50 : pro.trust;
    const roleText = { start: '🟢 בהרכב', bench: '🟡 ספסל', out: '🔴 מחוץ לסגל' }[role];
    main.append(
      h('div', { class: 'kpis' },
        kpi('', 'דירוג כללי', String(p.ovr), `${E.POS_HE[p.pos]} · גיל ${p.age}`, ovrBadge(p.ovr, false)),
        kpi('👕', 'מעמד בקבוצה', roleText, `רמת הקבוצה ${club.rep}`),
        kpi('', 'אמון המאמן', `${Math.round(trust)}%`, 'משפיע על הבחירה להרכב', ring(trust)),
        kpi('💶', 'חשבון בנק', h('span', { class: 'num', text: money(pro.money || 0) }), `שכר ${money(p.w)} לשבוע`),
        kpi('⭐', 'מוניטין', '★'.repeat(Math.min(5, 1 + Math.floor(pro.fame / 20))), `${pro.caps} הופעות בנבחרת${pro.awards ? ` · ${pro.awards} פרסי שחקן החודש` : ''}`)),
      h('div', { class: 'grid two' },
        heroMatch(club.id, next),
        h('div', { class: 'card' },
          h('div', { class: 'row' }, ovrBadge(p.ovr, true), h('div', null,
            h('h2', { style: { margin: 0 }, text: p.n }),
            h('div', { class: 'muted', text: `${E.POS_HE[p.pos]} · גיל ${p.age} · ${natName(p.nat)}` }),
            h('div', { style: { marginTop: '4px' } }, clubLabel(club)))),
          h('div', { style: { marginTop: '10px' } }, attrBars(p, pro.xp)),
          h('p', { class: 'muted', style: { fontSize: '12px' }, text: 'הפס הצהוב מראה התקדמות לנקודה הבאה בכל תכונה.' })),
        h('div', { class: 'span-all' }, monthCalendar(club.id)),
        h('div', { class: 'card' }, h('h3', { text: `העונה (${E.seasonLabel(S.seasonYear)})` }),
          h('div', { class: 'stat-tiles' },
            [['הופעות', p.st.app], ['שערים', p.st.gl], ['בישולים', p.st.as], ['ציון', p.st.app ? E.avgRating(p).toFixed(2) : '-']].map(([l, v]) => h('div', { class: 'stat-tile' }, h('b', { text: String(v) }), h('span', { text: l })))),
          h('h3', { style: { marginTop: '16px' }, text: 'ציונים אחרונים' }),
          recent.length ? h('div', { class: 'spark' }, recent.map((r) => h('i', { title: String(r), style: { height: `${Math.max(8, (r - 4) * 16)}%`, background: ovrColor(r * 10 + 10) } }))) : h('p', { class: 'muted', text: 'עדיין לא שיחקת.' })),
        h('div', { class: 'card' }, h('h3', { text: leagueName(club.league) }), miniTable(club.id))));
  }

  function trainingView(main) {
    if (S.mode === 'manager') {
      const club = S.clubs[S.user.clubId];
      const tr = E.trainingOf(club);
      const sq = E.squad(S, club.id);
      const avgCond = Math.round(sq.reduce((s, p) => s + p.cond, 0) / sq.length);
      main.append(
        h('div', { class: 'kpis' },
          kpi('💪', 'כושר ממוצע', `${avgCond}%`, 'משתקם בין המשחקים'),
          kpi('✚', 'פצועים', String(sq.filter((p) => p.inj > 0).length), 'אימון אינטנסיבי מגדיל סיכון'),
          kpi('🌱', 'צעירים (עד 23)', String(sq.filter((p) => p.age <= 23).length), 'מתפתחים מהר יותר'),
          kpi('🙂', 'מורל ממוצע', String(Math.round(sq.reduce((s, p) => s + p.morale, 0) / sq.length)), '')),
        h('div', { class: 'card' }, h('h3', { text: 'מוקד האימון' }),
          h('p', { class: 'muted', text: 'המוקד משפיע על ביצועי הקבוצה במשחקים ועל התכונות שמשתפרות. השחקנים מתפתחים בכל תחילת חודש.' }),
          h('div', { class: 'choices' }, Object.entries(E.TRAINING_FOCUS).map(([k, f]) => h('button', {
            class: 'choice' + (tr.focus === k ? ' selected' : ''), onclick: () => { E.setTraining(S, k, tr.intensity); gameScreen(); },
          }, h('b', { text: f.label }), h('small', { text: f.desc }))))),
        h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', { text: 'עצימות' }),
          h('div', { class: 'choices' }, Object.entries(E.TRAINING_INTENSITY).map(([k, it]) => h('button', {
            class: 'choice' + (tr.intensity === k ? ' selected' : ''), onclick: () => { E.setTraining(S, tr.focus, k); gameScreen(); },
          }, h('b', { text: it.label }), h('small', { text: `התפתחות ×${it.dev} · התאוששות ${it.recovery}% בשבוע · סיכון פציעה ${(it.injury * 100).toFixed(2)}% לשחקן בשבוע` }))))),
        facilitiesCard(club),
        individualPlans(club));
      return;
    }
    const pro = S.pro;
    const p = S.players[pro.pid];
    const labels = p.pos === 'GK' ? E.GK_ATTR_HE : E.ATTR_HE;
    const intensity = pro.intensity || 'normal';
    main.append(
      h('div', { class: 'card' }, h('h3', { text: 'מוקד אימון' }),
        h('p', { class: 'muted', text: 'בכל שבוע אתה צובר ניסיון בתכונה שבחרת. גם ההחלטות במשחקים מפתחות את התכונות שבהן השתמשת, ושחקנים צעירים משתפרים מהר יותר.' }),
        h('div', { class: 'choices' }, labels.map((l, i) => h('button', {
          class: 'choice' + (pro.focus === i ? ' selected' : ''), onclick: () => { E.setTraining(S, i, intensity); gameScreen(); },
        }, h('div', { class: 'big-stat', text: String(p.at[i]) }), h('b', { text: l }),
        h('div', { class: 'bar xp', style: { marginTop: '6px' } }, h('i', { style: { width: `${Math.min(100, pro.xp[i])}%`, background: 'var(--accent2)' } })))))),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('h3', { text: 'עצימות' }),
        h('div', { class: 'choices' }, Object.entries(E.TRAINING_INTENSITY).map(([k, it]) => h('button', {
          class: 'choice' + (intensity === k ? ' selected' : ''), onclick: () => { E.setTraining(S, pro.focus, k); gameScreen(); },
        }, h('b', { text: it.label }), h('small', { text: `ניסיון ×${it.dev} · סיכון פציעה ${(it.injury * 150).toFixed(2)}% בשבוע` }))))),
      h('p', { class: 'muted', text: `הדירוג הכללי מחושב לפי העמדה שלך (${E.POS_HE[p.pos]}), כך שהתכונות החשובות לעמדה משפיעות עליו יותר.` }));
  }

  function facilitiesCard(club) {
    const lvl = E.facilitiesOf(club);
    const cost = E.facilityUpgradeCost(club);
    return h('div', { class: 'card', style: { marginTop: '16px' } },
      h('div', { class: 'card-head' }, h('h3', { text: 'מתקני אימון' }), h('span', { class: 'warn', style: { fontSize: '20px', letterSpacing: '2px' }, text: '★'.repeat(lvl) + '☆'.repeat(5 - lvl) })),
      h('p', { class: 'muted', text: `רמה ${lvl} מתוך 5. מכפיל התפתחות לכל הסגל: ×${E.FACILITY_DEV[lvl]}. מתקנים טובים מאטים גם את הירידה של שחקנים ותיקים.` }),
      cost === null ? h('b', { class: 'good', text: 'המתקנים ברמה המקסימלית' })
        : h('button', { class: 'primary', disabled: club.balance < cost, text: `שדרוג לרמה ${lvl + 1} · ${money(cost)}`, onclick: () => confirmBox(`לשדרג את המתקנים ב-${money(cost)}?`, () => {
          const r = E.upgradeFacilities(S, club.id);
          toast(r.reason);
          saveGame(true);
          gameScreen();
        }) }));
  }
  const PLAN_POS = ['GK', 'CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'];
  function planSelect(p, onChange) {
    const labels = p.pos === 'GK' ? E.GK_ATTR_HE : E.ATTR_HE;
    const cur = !p.plan ? '' : p.plan.type === 'attr' ? `a${p.plan.idx}` : `p${p.plan.pos}`;
    return h('select', { onchange: (e) => {
      const v = e.target.value;
      E.setPlayerPlan(S, p.id, !v ? null : v[0] === 'a' ? { type: 'attr', idx: Number(v.slice(1)) } : { type: 'pos', pos: v.slice(1) });
      onChange();
    } },
    h('option', { value: '', text: 'ללא (לפי תוכנית הקבוצה)' }),
    h('optgroup', { label: 'שיפור תכונה' }, labels.map((l, i) => h('option', { value: `a${i}`, selected: cur === `a${i}`, text: `🎯 ${l}` }))),
    h('optgroup', { label: 'הסבה לעמדה' }, PLAN_POS.filter((x) => x !== p.pos && !(p.alt || []).includes(x))
      .map((x) => h('option', { value: `p${x}`, selected: cur === `p${x}`, text: `🔄 ${E.POS_HE[x]} (${x})` }))));
  }
  function individualPlans(club) {
    const sq = E.squad(S, club.id).sort((a, b) => b.ovr - a.ovr);
    return h('div', { class: 'card', style: { marginTop: '16px' } },
      h('h3', { text: 'אימון אישי' }),
      h('p', { class: 'muted', text: 'שחקן עם מיקוד אישי מתפתח מהר יותר (×1.5) בתכונה שבחרת. הסבה לעמדה חדשה לוקחת כמה חודשים, ובסופה השחקן יכול לשחק בה בלי קנס. שחקנים צעירים מתקדמים מהר יותר.' }),
      h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['עמדה', 'שחקן', 'גיל', 'יכולת', 'פוטנציאל', 'תוכנית', 'התקדמות'].map((t) => h('th', { text: t })))),
        h('tbody', null, sq.map((p) => h('tr', null,
          h('td', null, posPill(p.pos), ' ', (p.alt || []).map((a) => [posPill(a), ' '])),
          h('td', { text: p.n }), h('td', { class: 'num', text: String(p.age) }), h('td', null, ovrBadge(p.ovr)),
          h('td', { class: 'num muted', text: String(p.pot) }),
          h('td', null, planSelect(p, () => gameScreen())),
          h('td', { style: { minWidth: '110px' } }, p.plan && p.plan.type === 'pos'
            ? h('div', null, h('div', { class: 'bar' }, h('i', { style: { width: `${p.plan.progress}%` } })), h('small', { class: 'muted', text: `${p.plan.progress}% · ${p.plan.pos}` }))
            : p.plan ? h('span', { class: 'good', text: 'פעיל' }) : '')))))));
  }

  // ---------- Be a Pro: progress, life, contract, national team, injuries ----------
  function progressView(main) {
    const pro = S.pro;
    const p = S.players[pro.pid];
    const prog = E.objectiveProgress(S);
    const perks = new Set(pro.perks || []);
    const ach = pro.ach || {};
    const thr = E.callUpThreshold(p.nat);
    main.append(h('div', { class: 'grid two' },
      h('div', { class: 'card' }, h('h3', { text: `יעדי העונה של ${S.clubs[p.c].name}` }),
        prog.length ? prog.map((o) => h('div', { style: { margin: '10px 0' } },
          h('div', { class: 'row spread' }, h('b', { text: o.label }), h('span', { class: 'num ' + (o.done ? 'good' : ''), text: `${o.type === 'rt' ? o.current.toFixed(2) : o.current} / ${o.type === 'rt' ? o.target.toFixed(1) : o.target}${o.done ? ' ✔' : ''}` })),
          h('div', { class: 'bar' }, h('i', { style: { width: `${Math.min(100, (o.current / o.target) * 100)}%`, background: o.done ? 'var(--accent)' : 'var(--accent2)' } }))))
          : h('p', { class: 'muted', text: 'היעדים ייקבעו בתחילת העונה.' }),
        h('p', { class: 'muted', text: 'בסוף העונה כל יעד שהושג מביא בונוס כספי ומעלה את אמון המאמן. יעד שלא הושג מוריד אותו.' })),
      h('div', { class: 'card' }, h('h3', { text: 'נבחרת' }),
        h('div', { class: 'stat-tiles' },
          [['הופעות', pro.caps || 0], ['שערים', pro.intlGoals || 0], ['חוזק הנבחרת', E.nationStrength(p.nat)], ['סף זימון', thr]].map(([l, v]) => h('div', { class: 'stat-tile' }, h('b', { class: 'num', text: String(v) }), h('span', { text: l })))),
        h('p', { class: p.ovr >= thr ? 'good' : 'muted', text: p.ovr >= thr ? `אתה ברמה של נבחרת ${natName(p.nat)}. זימונים מגיעים באוקטובר, בדצמבר ובמרץ, ובקיץ יש מונדיאל או יורו.` : `כדי להיות מזומן לנבחרת ${natName(p.nat)} צריך דירוג ${thr} (עכשיו ${p.ovr}).` })),
      h('div', { class: 'card span-all' }, h('h3', { text: 'יכולות מיוחדות' }),
        h('div', { class: 'choices' }, Object.entries(E.PERKS).map(([id, pk]) => h('div', { class: 'choice' + (perks.has(id) ? ' selected' : '') },
          h('b', { text: `${perks.has(id) ? '✨' : '🔒'} ${pk.name}` }), h('small', { text: pk.desc }), h('small', { class: perks.has(id) ? 'good' : 'warn', text: perks.has(id) ? 'פתוח' : `דרישה: ${pk.req}` }))))),
      h('div', { class: 'card span-all' }, h('h3', { text: `הישגים (${Object.keys(ach).length}/${Object.keys(E.ACHIEVEMENTS).length})` }),
        h('div', { class: 'choices' }, Object.entries(E.ACHIEVEMENTS).map(([id, a]) => h('div', { class: 'choice' + (ach[id] ? ' selected' : ''), style: { opacity: ach[id] ? 1 : 0.45 } },
          h('b', { text: `${a.ico} ${a.name}` }), h('small', { text: ach[id] ? `עונת ${E.seasonLabel(ach[id].season)}` : 'עוד לא' })))))));
  }

  function lifeView(main) {
    const pro = S.pro;
    const p = S.players[pro.pid];
    const club = S.clubs[p.c];
    const roleName = { star: 'כוכב', rotation: 'רוטציה', prospect: 'צעיר מבטיח' }[pro.contractRole || 'rotation'];
    const chem = Math.round((pro.chem || {})[p.c] || 0);
    main.append(
      h('div', { class: 'kpis' },
        kpi('💶', 'חשבון בנק', h('span', { class: 'num', text: money(pro.money || 0) }), `שכר ${money(p.w)} לשבוע`),
        kpi('', 'אוהדים', `${Math.round(pro.fans === undefined ? 50 : pro.fans)}%`, 'עולה עם ציונים טובים', ring(pro.fans === undefined ? 50 : pro.fans)),
        kpi('', 'כימיה עם הקבוצה', `${chem}%`, 'משפרת מסירות ברגעי המשחק', ring(chem, 'var(--info)')),
        kpi('©️', 'קפטן', pro.captain === p.c ? 'כן' : 'לא', pro.captain === p.c ? 'יכולת "מנהיג" פעילה' : 'דורש אמון, אוהדים וותק')),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h3', { text: 'חוזה וסוכן' }),
          h('dl', { class: 'kv' },
            h('dt', { text: 'קבוצה' }), h('dd', null, clubLabel(club), pro.loanActive ? h('span', { class: 'tag', text: ` בהשאלה מ-${S.clubs[pro.loanActive.parent].name}` }) : null),
            h('dt', { text: 'מעמד בחוזה' }), h('dd', { text: roleName }),
            h('dt', { text: 'שכר' }), h('dd', { class: 'num', text: `${money(p.w)} לשבוע` }),
            h('dt', { text: 'חוזה עד' }), h('dd', { text: String(p.ctr) }),
            h('dt', { text: 'סעיף שחרור' }), h('dd', { class: 'num', text: pro.releaseClause ? money(pro.releaseClause) : 'אין' }),
            h('dt', { text: 'בקשת העברה' }), h('dd', { text: pro.transferRequest ? 'פעילה' : 'לא' })),
          h('div', { class: 'row', style: { marginTop: '12px' } },
            h('button', { disabled: !!pro.transferRequest, text: 'לבקש העברה', onclick: () => confirmBox('לבקש העברה? אמון המאמן ירד, אבל יגיעו יותר הצעות בחלון ההעברות.', () => { toast(E.requestTransfer(S)); saveGame(true); gameScreen(); }) }),
            h('button', { disabled: !!pro.loanActive, text: 'לבקש השאלה', onclick: () => confirmBox('לצאת להשאלה עד סוף העונה לקבוצה שבה תשחק יותר?', () => { const r = E.requestLoan(S); toast(r.text, 4000); saveGame(true); gameScreen(); }) })),
          h('p', { class: 'muted', text: 'כשמגיעה הצעה מקבוצה אחרת (בדואר), אפשר לנהל משא ומתן על השכר, המעמד וסעיף השחרור.' })),
        h('div', { class: 'card' }, h('h3', { text: 'צוות אישי (עלות שבועית)' }),
          Object.entries(E.SERVICES).map(([id, sv]) => h('div', { class: 'row spread', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
            h('div', null, h('b', { text: sv.name }), h('div', { class: 'muted', style: { fontSize: '12px' }, text: sv.desc })),
            h('div', { class: 'row', style: { flexWrap: 'nowrap', flex: 'none' } }, h('span', { class: 'num muted', text: `${money(E.serviceCost(S, id))}/שבוע` }),
              h('button', { class: pro.services && pro.services[id] ? 'primary small' : 'small', text: pro.services && pro.services[id] ? 'פעיל' : 'לשכור', onclick: () => { E.toggleService(S, id); gameScreen(); } }))))),
        h('div', { class: 'card span-all' }, h('h3', { text: 'קניות' }),
          h('div', { class: 'choices' }, Object.entries(E.PURCHASES).map(([id, it]) => h('div', { class: 'choice' + (pro.bought && pro.bought[id] ? ' selected' : '') },
            h('b', { text: it.name }), h('small', { text: it.desc }), h('small', { class: 'num', text: money(it.cost) }),
            pro.bought && pro.bought[id] ? h('small', { class: 'good', text: '✔ שלך' })
              : h('button', { class: 'small', disabled: (pro.money || 0) < it.cost, text: 'לקנות', onclick: () => { const r = E.buy(S, id); toast(r.reason); saveGame(true); gameScreen(); } })))))));
  }

  function negotiateModal(offer) {
    const club = S.clubs[offer.club];
    const p = S.players[S.pro.pid];
    const t = { wage: 'fair', role: p.age <= 20 ? 'prospect' : 'rotation', clause: false };
    openModal((close) => {
      const body = h('div');
      const render = () => {
        const opt = (key, val, label, sub) => h('button', { class: 'choice' + (t[key] === val ? ' selected' : ''), onclick: () => { t[key] = val; render(); } }, h('b', { text: label }), sub ? h('small', { text: sub }) : null);
        body.replaceChildren(
          modalHead(`משא ומתן עם ${club.name}`, close),
          h('p', { class: 'muted', text: `דמי העברה: ${money(offer.fee)}. השכר ההתחלתי שהוצע: ${money(offer.wage)} לשבוע.` }),
          h('h3', { text: 'שכר' }),
          h('div', { class: 'choices' }, opt('wage', 'low', `${money(Math.round(offer.wage * 0.9))}`, 'כמעט בטוח שיסכימו'), opt('wage', 'fair', `${money(offer.wage)}`, 'סביר'), opt('wage', 'high', `${money(Math.round(offer.wage * 1.35))}`, 'סיכון שיבטלו')),
          h('h3', { style: { marginTop: '12px' }, text: 'מעמד' }),
          h('div', { class: 'choices' }, opt('role', 'star', 'כוכב', `אמון גבוה ויעדים גבוהים. ${p.ovr >= club.rep + 2 ? '' : 'קשה לקבל ברמה שלך.'}`), opt('role', 'rotation', 'רוטציה', 'סטנדרטי'), opt('role', 'prospect', 'צעיר מבטיח', 'יעדים נמוכים, עד גיל 22')),
          h('label', { class: 'row', style: { marginTop: '12px' } }, h('input', { type: 'checkbox', checked: t.clause, onchange: (e) => { t.clause = e.target.checked; } }), 'לדרוש סעיף שחרור (מקטין סיכוי)'),
          h('div', { class: 'row', style: { marginTop: '16px' } },
            h('button', { class: 'primary', text: 'להגיש', onclick: () => {
              const r = E.proNegotiate(S, offer.club, t);
              close();
              toast(r.text, 4500);
              saveGame(true);
              gameScreen();
            } }),
            h('button', { text: 'ביטול', onclick: close })));
      };
      render();
      return [body];
    }, { wide: true });
  }

  let intlOpen = false;
  function intlModal() {
    if (!S.pendingIntl || intlOpen) return;
    intlOpen = true;
    const p = S.players[S.pro.pid];
    openModal((close) => {
      const body = h('div');
      const render = (last) => {
        const im = S.pendingIntl;
        const head = h('div', null, h('div', { class: 'muted', text: im.label }),
          h('h2', { class: 'month-title', text: `${natName(p.nat)} נגד ${im.opp.name}` }),
          h('div', { class: 'muted', text: `חוזק ${im.us} מול ${im.opp.strength}` }));
        if (!im.done) {
          const m = im.current || E.intlNext(S);
          if (m) {
            body.replaceChildren(...[head, last ? h('p', { class: last.ok ? 'good' : 'bad', text: last.text }) : null,
              h('div', { class: 'decision' }, h('h2', { text: `🎌 ${m.title}` }), h('p', { text: m.desc }),
                m.options.map((o, i) => h('button', { class: 'opt', onclick: () => render(E.answerIntl(S, i)) }, h('span', { text: o.label }), h('span', { class: 'p', text: `${Math.round(o.p * 100)}%` })))),
              h('div', { class: 'muted', text: `רגע ${im.idx + 1} מתוך ${im.moments} · ${im.gf}-${im.ga}` })].filter(Boolean));
            return;
          }
        }
        body.replaceChildren(...[head, last ? h('p', { class: last.ok ? 'good' : 'bad', text: last.text }) : null,
          h('div', { class: 'scoreboard', style: { marginTop: '12px' } }, h('div', { class: 'team', text: natName(p.nat) }), h('div', { class: 'score', text: `${im.gf} - ${im.ga}` }), h('div', { class: 'team', text: im.opp.name })),
          im.pens !== undefined ? h('p', { class: 'muted', text: im.pens ? 'ניצחון בפנדלים!' : 'הפסד בפנדלים...' }) : null,
          h('button', { class: 'primary', style: { marginTop: '14px' }, text: 'המשך', onclick: () => {
            const res = E.closeIntl(S);
            saveGame(true);
            if (res && !res.over) { render(); return; }
            close();
            intlOpen = false;
            if (res && res.text) toast(res.text, 5000);
            gameScreen();
          } })].filter(Boolean));
      };
      render();
      return [body];
    }, { wide: true, locked: true });
  }

  let injuryOpen = false;
  function injuryModal() {
    if (!S.pendingInjury || injuryOpen) return;
    injuryOpen = true;
    openModal((close) => [modalHead('נפצעת באימון', null),
      h('p', { text: `הרופא אומר שצריך לנוח ${S.pendingInjury.weeks} שבועות. אפשר גם לנסות לשחק עם כאבים.` }),
      h('div', { class: 'choices' },
        h('button', { class: 'choice', onclick: () => { toast(E.answerInjury(S, true)); injuryOpen = false; close(); saveGame(true); gameScreen(); } }, h('b', { text: 'לשחק דרך הכאב' }), h('small', { text: 'תשחק כבר השבוע, אבל יש 35% שהפציעה תחמיר ותעדר יותר זמן.' })),
        h('button', { class: 'choice', onclick: () => { toast(E.answerInjury(S, false)); injuryOpen = false; close(); saveGame(true); gameScreen(); } }, h('b', { text: 'לנוח' }), h('small', { text: 'בטוח, אבל תפספס משחקים.' })))], { locked: true });
  }

  // Shows whichever pending event blocks the game (injury > national team > monthly review).
  function showPending() {
    if (!S || busy || suppressMonth) return false;
    if (S.pendingInjury) { injuryModal(); return true; }
    if (S.pendingIntl) { intlModal(); return true; }
    if (S.pendingMonth) { monthReviewModal(); return true; }
    return false;
  }

  function historyView(main) {
    const pro = S.pro;
    const p = S.players[pro.pid];
    const rows = pro.career.concat([{ season: S.seasonYear, club: p.c, st: p.st, current: true }]);
    main.append(h('div', { class: 'card' }, h('h3', { text: 'הקריירה שלך' }),
      h('table', null, h('thead', null, h('tr', null, ['עונה', 'קבוצה', 'הופעות', 'שערים', 'בישולים', 'ציון'].map((t) => h('th', { text: t })))),
        h('tbody', null, rows.slice().reverse().map((r) => h('tr', { class: r.current ? 'me' : '' },
          h('td', { text: E.seasonLabel(r.season) + (r.partial ? ' (עד העברה)' : '') }), h('td', null, clubLabel(S.clubs[r.club])),
          h('td', { class: 'num', text: String(r.st.app) }), h('td', { class: 'num', text: String(r.st.gl) }), h('td', { class: 'num', text: String(r.st.as) }),
          h('td', { class: 'num', text: r.st.app ? (r.st.rt / r.st.app).toFixed(2) : '-' })))))),
    h('div', { class: 'card', style: { marginTop: '14px' } }, h('h3', { text: 'היסטוריית אלופות' }), championsTable()));
  }

  // ---------- advancing time ----------
  async function onContinue() {
    if (busy) return;
    if (showPending()) return;
    const clubId = userClubId();
    const fx = E.clubFixture(S, clubId, S.week);
    if (fx && fx.m.hg === null) {
      if (S.mode === 'manager') return matchScreen(managerSim(fx));
      const sim = E.proMatchSim(S, fx);
      if (sim.proRole === 'out') {
        toast('לא נכללת בסגל המשחק השבוע. תמשיך להתאמן!');
        sim.runToEnd();
        return finishWeek(sim);
      }
      return matchScreen(sim);
    }
    busy = true;
    gameScreen();
    setTimeout(() => finishWeek(null), 20);
  }
  function managerSim(fx, quick) {
    const userSide = fx.m.h === S.user.clubId ? 0 : 1;
    return new E.MatchSim(S, fx.m.h, fx.m.a, { detail: !quick, userSide });
  }

  // Plays the rest of the week around `sim` (the user's match, or null).
  function advanceWeek(sim) {
    const results = E.playWeek(S, sim);
    let proReport = null;
    if (sim && S.mode === 'pro') {
      const r = results.find((x) => x.sim === sim);
      if (r) proReport = E.proAfterMatch(S, sim, r.ratings);
    }
    const summary = E.afterWeek(S);
    return { summary, proReport };
  }

  let suppressMonth = false;
  function finishWeek(sim) {
    busy = true;
    const { summary, proReport } = advanceWeek(sim);
    busy = false;
    saveGame(true);
    const report = proReport && proReport.played;
    suppressMonth = !!report; // show the match report first, then the monthly review
    gameScreen();
    if (report) {
      proReportModal(proReport, () => {
        suppressMonth = false;
        showPending();
      });
    }
    if (summary) seasonEndModal(summary);
  }

  // Simulates week after week (the user's matches too) until a new month starts.
  function simToNextMonth() {
    if (busy || S.pendingMonth || S.pendingIntl || S.pendingInjury) return;
    busy = true;
    gameScreen();
    toast('מדלג לחודש הבא...');
    let weeks = 0;
    let summary = null;
    const results = [];
    const step = () => {
      const clubId = userClubId();
      const fx = E.clubFixture(S, clubId, S.week);
      let sim = null;
      if (fx && fx.m.hg === null) {
        sim = S.mode === 'manager' ? managerSim(fx, true) : E.proMatchSim(S, fx);
        sim.runToEnd();
        const [H, A] = sim.sides;
        results.push(`${H.club.name} ${H.goals} - ${A.goals} ${A.club.name}`);
      }
      const r = advanceWeek(sim);
      summary = r.summary;
      weeks++;
      if (!summary && !S.pendingMonth && !S.pendingIntl && !S.pendingInjury && weeks < 8) return setTimeout(step, 0);
      busy = false;
      saveGame(true);
      gameScreen();
      if (results.length) toast(`שוחקו ${results.length} משחקים. אחרון: ${results[results.length - 1]}`, 4000);
      if (summary) seasonEndModal(summary);
    };
    setTimeout(step, 20);
  }

  let monthModalOpen = false;
  function monthReviewModal() {
    const r = S.pendingMonth;
    if (!r || monthModalOpen) return;
    monthModalOpen = true;
    openModal((close) => {
      const body = h('div');
      const render = () => {
        const allAnswered = r.decisions.every((d) => d.answer !== null);
        const parts = [
          h('div', { class: 'modal-head' }, h('div', null, h('div', { class: 'muted', text: 'סיכום חודשי' }), h('h2', { class: 'month-title', text: r.label })), h('span', { style: { fontSize: '40px' }, text: '📅' })),
        ];
        if (r.club) {
          const c = r.club;
          const tiles = S.mode === 'manager'
            ? [['משחקים', c.p], ['נצחונות', c.w], ['תיקו', c.d], ['הפסדים', c.l], ['שערים', `${c.gf}:${c.ga}`], ['מקום', `${c.posFrom}→${c.posTo}`], ['מאזן', money(c.balanceDelta)]]
            : [['הופעות', r.pro.app], ['שערים', r.pro.gl], ['בישולים', r.pro.as], ['ציון', r.pro.rating ? r.pro.rating.toFixed(2) : '-'], ['דירוג', `${r.pro.ovrFrom}→${r.pro.ovrTo}`], ['הקבוצה', `${c.w}-${c.d}-${c.l}`]];
          parts.push(h('div', { class: 'stat-tiles' }, tiles.map(([l, v]) => h('div', { class: 'stat-tile' }, h('b', { class: 'num', text: String(v) }), h('span', { text: l })))));
        }
        const awards = [];
        if (r.userMotm) awards.push(h('div', { class: 'award' }, h('span', { class: 'ico', text: '🏅' }), h('div', null, h('b', { text: 'מאמן החודש!' }), h('div', { class: 'muted', text: 'הקבוצה שלך צברה הכי הרבה נקודות בליגה החודש.' }))));
        if (r.pro && r.pro.award) awards.push(h('div', { class: 'award' }, h('span', { class: 'ico', text: '🏅' }), h('div', null, h('b', { text: 'שחקן החודש בליגה!' }), h('div', { class: 'muted', text: 'המוניטין שלך עלה.' }))));
        const potmRow = (label, x) => x && h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { class: 'muted', text: label }), crest(S.clubs[x.club]), h('b', { text: x.name }),
          h('span', { class: 'muted', text: `ציון ${x.rating.toFixed(2)} · ${x.gl} שערים · ${x.as} בישולים` }));
        const potms = [potmRow('שחקן החודש בקבוצה:', r.clubPotm), potmRow('שחקן החודש בליגה:', r.leaguePotm),
          r.motm ? h('div', { class: 'row', style: { margin: '6px 0' } }, h('span', { class: 'muted', text: 'מאמן החודש:' }), clubLabel(S.clubs[r.motm.clubId]), h('span', { class: 'muted', text: `${r.motm.pts} נק' מ-${r.motm.p} משחקים` })) : null].filter(Boolean);
        parts.push(h('div', { class: 'grid two', style: { marginTop: '14px' } },
          h('div', { class: 'card tight' }, h('h3', { text: 'פרסים' }), awards, potms.length ? potms : h('p', { class: 'muted', text: 'לא היו מספיק משחקים החודש.' })),
          r.confidence ? h('div', { class: 'card tight' }, h('h3', { text: 'אמון ההנהלה' }),
            h('div', { class: 'row' }, ring(r.confidence.to), h('div', null, h('b', { class: r.confidence.to >= r.confidence.from ? 'good' : 'bad', text: `${r.confidence.from}% ← ${r.confidence.to}%` }),
              r.confidence.reasons.map((x) => h('div', { class: 'muted', style: { fontSize: '13px' }, text: `• ${x}` })))),
            r.fired ? h('p', { class: 'bad', text: 'ההנהלה איבדה את האמון בך...' }) : null)
            : r.pro ? h('div', { class: 'card tight' }, h('h3', { text: 'מצב' }), h('div', { class: 'row' }, ring(S.pro.trust === undefined ? 50 : S.pro.trust), h('div', null, h('b', { text: 'אמון המאמן' }), h('div', { class: 'muted', text: `מוניטין ${r.pro.fame >= 0 ? '+' : ''}${r.pro.fame} החודש` })))) : null));
        if (r.news.length) parts.push(h('div', { style: { marginTop: '10px' } }, r.news.map((n) => h('p', { class: 'warn', text: `⚠ ${n}` }))));
        const tr = r.trainingReport;
        if (tr && (tr.up.length || tr.down.length || tr.learned.length || tr.progress.length)) {
          const labels = E.ATTR_HE;
          parts.push(h('div', { class: 'card tight', style: { marginTop: '14px' } }, h('h3', { text: 'דוח אימונים' }),
            tr.up.length ? h('p', { style: { margin: '4px 0' } }, h('b', { class: 'good', text: '📈 השתפרו: ' }),
              tr.up.map((x) => `${x.name} (${x.from}→${x.to}${x.attr !== null ? `, ${labels[x.attr]}` : ''})`).join(' · ')) : null,
            tr.down.length ? h('p', { style: { margin: '4px 0' } }, h('b', { class: 'bad', text: '📉 ירדו: ' }), tr.down.map((x) => `${x.name} (${x.from}→${x.to})`).join(' · ')) : null,
            tr.learned.length ? h('p', { style: { margin: '4px 0' } }, h('b', { class: 'warn', text: '🔄 סיימו הסבה: ' }), tr.learned.map((x) => `${x.name} → ${E.POS_HE[x.pos]}`).join(' · ')) : null,
            tr.progress.length ? h('p', { class: 'muted', style: { margin: '4px 0' } }, 'בתהליך הסבה: ', tr.progress.map((x) => `${x.name} (${x.pos} ${x.progress}%)`).join(' · ')) : null));
        }
        if (r.decisions.length) {
          parts.push(h('h3', { style: { marginTop: '18px' }, text: 'החלטות החודש' }));
          r.decisions.forEach((d, i) => {
            parts.push(h('div', { class: 'decision-card' + (d.answer !== null ? ' done' : '') },
              h('h4', { text: d.title }), h('div', { class: 'muted', text: d.body }),
              d.answer === null
                ? h('div', { class: 'opts' }, d.options.map((o, k) => h('button', { onclick: () => { E.answerDecision(S, i, k); render(); } }, h('b', { text: o.label }), o.hint ? h('small', { text: o.hint }) : null)))
                : h('div', { class: 'result' }, h('b', { text: `${d.options[d.answer].label}: ` }), d.result)));
          });
        }
        if (!r.fired) {
          parts.push(h('h3', { style: { marginTop: '18px' }, text: S.mode === 'manager' ? 'תוכנית אימונים לחודש הבא' : 'עצימות אימון לחודש הבא' }));
          if (S.mode === 'manager') {
            const tr = E.trainingOf(S.clubs[S.user.clubId]);
            parts.push(h('div', { class: 'choices' }, Object.entries(E.TRAINING_FOCUS).map(([k, f]) => h('button', {
              class: 'choice' + (tr.focus === k ? ' selected' : ''), onclick: () => { E.setTraining(S, k, tr.intensity); render(); },
            }, h('b', { text: f.label }), h('small', { text: f.desc })))));
            parts.push(h('div', { class: 'choices', style: { marginTop: '8px' } }, Object.entries(E.TRAINING_INTENSITY).map(([k, it]) => h('button', {
              class: 'choice' + (tr.intensity === k ? ' selected' : ''), onclick: () => { E.setTraining(S, tr.focus, k); render(); },
            }, h('b', { text: `עצימות: ${it.label}` })))));
          } else {
            const cur = S.pro.intensity || 'normal';
            parts.push(h('div', { class: 'choices' }, Object.entries(E.TRAINING_INTENSITY).map(([k, it]) => h('button', {
              class: 'choice' + (cur === k ? ' selected' : ''), onclick: () => { E.setTraining(S, S.pro.focus, k); render(); },
            }, h('b', { text: it.label }), h('small', { text: `ניסיון ×${it.dev}` })))));
          }
        }
        parts.push(h('div', { class: 'row', style: { marginTop: '18px', justifyContent: 'flex-end' } },
          allAnswered ? null : h('span', { class: 'muted', text: 'ענה על כל ההחלטות כדי להמשיך' }),
          h('button', { class: 'primary', disabled: !allAnswered, text: r.fired ? 'להמשך' : 'לחודש הבא ▸', onclick: () => {
            const fired = r.fired;
            E.closeMonth(S);
            monthModalOpen = false;
            close();
            saveGame(true);
            if (fired) firedModal();
            else gameScreen();
          } })));
        body.replaceChildren(...parts);
      };
      render();
      return [body];
    }, { wide: true, locked: true });
  }

  function firedModal() {
    const offers = E.jobOffers(S);
    openModal((close) => [modalHead('פוטרת!', null),
      h('p', { text: 'ההנהלה החליטה להיפרד ממך. אלו ההצעות שקיבלת:' }),
      h('div', { class: 'club-grid' }, offers.map((c) => h('div', { class: 'card tight club-card', onclick: () => {
        E.takeJob(S, c.id);
        close();
        saveGame(true);
        gameScreen();
      } }, crest(c, true), h('div', { class: 'info' }, h('div', { class: 'name', text: c.name }), h('div', { class: 'muted', text: leagueName(c.league) })), ovrBadge(c.rep))))], { wide: true, locked: true });
  }

  function proReportModal(r, onClose) {
    const p = S.players[S.pro.pid];
    openModal((close) => [modalHead('סיכום המשחק שלך', close),
      h('div', { class: 'row', style: { justifyContent: 'space-around', textAlign: 'center' } },
        h('div', null, h('div', { class: 'big-stat', style: { color: ovrColor(r.rating * 10 + 10) }, text: r.rating.toFixed(1) }), h('div', { class: 'muted', text: 'ציון' })),
        h('div', null, h('div', { class: 'big-stat', text: String(r.mins) }), h('div', { class: 'muted', text: 'דקות' })),
        h('div', null, h('div', { class: 'big-stat', text: String(r.goals) }), h('div', { class: 'muted', text: 'שערים' })),
        h('div', null, h('div', { class: 'big-stat', text: `+${r.xp}` }), h('div', { class: 'muted', text: 'ניסיון' }))),
      h('p', { class: 'muted', style: { textAlign: 'center' }, text: `${S.clubs[p.c].name} ${r.score[0]} - ${r.score[1]} ${r.opp}${r.assists ? ` · ${r.assists} בישולים` : ''}` }),
      r.gains.length ? h('p', { class: 'good', text: `השתפרת! ${r.gains.map((g) => (p.pos === 'GK' ? E.GK_ATTR_HE : E.ATTR_HE)[g.idx]).join(', ')} עלו. דירוג כללי: ${p.ovr}` }) : null,
      (r.newPerks || []).length ? h('p', { class: 'warn', text: `✨ יכולת חדשה: ${r.newPerks.map((id) => E.PERKS[id].name).join(', ')}` }) : null,
      r.decisions && r.decisions.length ? h('div', { class: 'table-wrap' }, h('h3', { style: { marginTop: '12px' }, text: 'ההחלטות שלך' }), h('table', null, h('tbody', null, r.decisions.map((d) => h('tr', null,
        h('td', { class: 'num muted', text: `${d.min}'` }), h('td', { text: d.title }), h('td', null, h('b', { text: d.choice }), d.pressure ? h('span', { class: 'tag', text: ' ⏱ לחץ' }) : null),
        h('td', { class: 'num muted', text: `${Math.round(d.p * 100)}%` }),
        h('td', { class: d.success ? 'good' : 'bad', text: d.success ? (d.result === 'goal' ? '⚽ גול' : d.result === 'chain' ? '✔ המשך' : '✔ הצליח') : '✖ נכשל' }),
        h('td', { class: 'num ' + (d.delta >= 0 ? 'good' : 'bad'), text: `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)}` })))))) : null,
      h('button', { class: 'primary', style: { marginTop: '12px' }, text: 'המשך', onclick: close })], { onClose, wide: true });
  }

  function seasonEndModal(sm) {
    openModal((close) => {
      const parts = [modalHead(`סיכום עונת ${E.seasonLabel(sm.season)}`, null)];
      if (sm.user) {
        const u = sm.user;
        parts.push(h('div', { class: 'card', style: { marginBottom: '12px' } },
          h('h3', { text: 'העונה שלך' }),
          h('p', null, `סיימת במקום `, h('b', { text: String(u.pos) }), ` (ציפייה: ${u.expected}). `,
            u.promoted ? h('b', { class: 'good', text: 'עלית ליגה! 🎉' }) : null, u.relegated ? h('b', { class: 'bad', text: 'ירדת ליגה.' }) : null)));
        if (u.fired) {
          const offers = E.jobOffers(S);
          parts.push(h('div', { class: 'card' }, h('h3', { class: 'bad', text: 'פוטרת!' }),
            h('p', { text: 'ההנהלה החליטה להיפרד ממך. אלו ההצעות שקיבלת:' }),
            h('div', { class: 'club-grid' }, offers.map((c) => h('div', { class: 'card tight club-card', onclick: () => {
              E.takeJob(S, c.id);
              close();
              saveGame(true);
              gameScreen();
            } }, crest(c, true), h('div', { class: 'info' }, h('div', { class: 'name', text: c.name }), h('div', { class: 'muted', text: leagueName(c.league) })), ovrBadge(c.rep))))));
        }
      }
      if (sm.pro) {
        const ob = sm.proObjectives;
        parts.push(h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', { text: 'העונה שלך' }),
          h('p', { text: `${sm.pro.st.app} הופעות · ${sm.pro.st.gl} שערים · ${sm.pro.st.as} בישולים · ציון ממוצע ${sm.pro.st.app ? (sm.pro.st.rt / sm.pro.st.app).toFixed(2) : '-'} · דירוג ${sm.pro.ovr}` }),
          ob ? h('p', null, `יעדים: ${ob.met}/${ob.list.length} · בונוס ${money(ob.bonus)} · `, ob.list.map((o) => h('span', { class: o.done ? 'good' : 'bad', text: `${o.label} ${o.type === 'rt' ? o.current.toFixed(2) : o.current}/${o.target}  ` }))) : null));
      }
      if (sm.awards) {
        const aw = sm.awards;
        const who = (x) => (x ? `${x.name} (${S.clubs[x.club] ? S.clubs[x.club].name : ''})` : '-');
        parts.push(h('div', { class: 'card', style: { marginBottom: '12px' } }, h('h3', { text: '🏆 פרסי העונה' }),
          aw.ballon && aw.ballon.length ? h('div', { class: 'award', style: { marginBottom: '10px' } }, h('span', { class: 'ico', text: '🥇' }),
            h('div', null, h('b', { text: `כדור הזהב: ${who(aw.ballon[0])}` }), h('div', { class: 'muted', text: `2. ${who(aw.ballon[1])} · 3. ${who(aw.ballon[2])}` }))) : null,
          h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, h('tr', null, ['ליגה', 'שחקן העונה', 'השחקן הצעיר'].map((t) => h('th', { text: t })))),
            h('tbody', null, S.leagues.map((l) => h('tr', null, h('td', { text: leagueName(l.id) }), h('td', { text: who(aw.season[l.id]) }), h('td', { class: 'muted', text: who(aw.young[l.id]) }))))))));
      }
      parts.push(h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['ליגה', 'אלופה', 'עלו / ירדו', 'מלך השערים'].map((t) => h('th', { text: t })))),
        h('tbody', null, S.leagues.map((l) => h('tr', null,
          h('td', { text: leagueName(l.id) }),
          h('td', null, sm.champions[l.id] ? clubLabel(S.clubs[sm.champions[l.id]]) : ''),
          h('td', { class: 'muted', text: (l.tier === 1 ? sm.relegated[l.id] : sm.promoted[l.id] || []).map((id) => S.clubs[id].name).join(', ') }),
          h('td', { text: sm.topScorers[l.id] ? `${sm.topScorers[l.id].name} (${sm.topScorers[l.id].goals})` : '' })))))));
      if (!sm.user || !sm.user.fired) parts.push(h('button', { class: 'primary', style: { marginTop: '12px' }, text: 'לעונה הבאה', onclick: close }));
      return parts;
    }, { wide: true, locked: true });
  }

  // ---------- 2D match view ----------
  // A top-down pitch drawn on a canvas. The engine simulates minute by minute; each minute
  // becomes a short animation: who has the ball, a couple of passes, and the shot if there was one.
  function colorDist(a, b) {
    const pa = parseInt(String(a).slice(1, 7), 16);
    const pb = parseInt(String(b).slice(1, 7), 16);
    const d = [16, 8, 0].map((sh) => ((pa >> sh) & 255) - ((pb >> sh) & 255));
    return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  }
  function pitchView(sim) {
    const L = 105;
    const WD = 68;
    const M = 3; // margin in metres
    const canvas = h('canvas', { class: 'pitch2d' });
    const ctx = canvas.getContext('2d');
    const [H, A] = sim.sides;
    const colH = clubColor(H.club);
    let colA = clubColor(A.club);
    if (colorDist(colH, colA) < 110) colA = A.club.colors.find((c) => colorDist(c, colH) >= 110) || (lightness(colH) > 128 ? '#1b1b1b' : '#f5f5f5');
    const teamCol = [colH, colA];
    const gkCol = ['#f4c542', '#9b5de5'];
    const dirOf = (i) => (i === 0 ? -1 : 1); // home attacks towards x=0
    const pos = new Map(); // player id -> {x, y, jx, jy}
    const ball = { x: L / 2, y: WD / 2 };
    let path = []; // [{x, y, t}] waypoints with arrival times
    let carrier = null;
    let atk = 0;
    let running = true;
    let focusId = null;
    let last = performance.now();
    let scale = 1;

    const rand = (a, b) => a + Math.random() * (b - a);
    function baseLayout(i) {
      const s = sim.sides[i];
      const slots = E.FORMATIONS[s.formation];
      const pts = slotPositions(s.formation);
      const used = new Set();
      const out = new Map();
      for (const x of s.onPitch) {
        let k = slots.findIndex((sl, j) => sl === x.slot && !used.has(j));
        if (k < 0) k = slots.findIndex((sl, j) => E.group(sl) === E.group(x.slot) && !used.has(j));
        if (k >= 0) used.add(k);
        const p = k >= 0 ? pts[k] : { x: 50, y: 50 };
        const fx = i === 0 ? (p.y / 100) * L : (1 - p.y / 100) * L;
        const fy = i === 0 ? (1 - p.x / 100) * WD : (p.x / 100) * WD;
        out.set(x.id, { fx, fy, gk: x.slot === 'GK' });
      }
      return out;
    }
    function targets() {
      const t = new Map();
      for (let i = 0; i < 2; i++) {
        const layout = baseLayout(i);
        const attacking = i === atk;
        const shift = (ball.x - L / 2) * 0.55 + (attacking ? dirOf(i) * 7 : -dirOf(i) * 3);
        for (const [id, b] of layout) {
          let x;
          let y;
          if (b.gk) {
            x = i === 0 ? L - 2 : 2;
            y = WD / 2 + (ball.y - WD / 2) * 0.15;
          } else {
            x = L / 2 + shift + (b.fx - L / 2) * 0.6;
            y = WD / 2 + (b.fy - WD / 2) * 0.85 + (ball.y - WD / 2) * 0.25;
          }
          const p = pos.get(id);
          if (p) {
            x += p.jx;
            y += p.jy;
          }
          t.set(id, { x: Math.max(1, Math.min(L - 1, x)), y: Math.max(1, Math.min(WD - 1, y)) });
        }
      }
      // the closest two defenders press the ball, the carrier is on it
      const def = sim.sides[1 - atk].onPitch.filter((x) => x.slot !== 'GK')
        .map((x) => ({ id: x.id, d: dist(pos.get(x.id), ball) })).sort((a, b) => a.d - b.d).slice(0, 2);
      for (const d of def) {
        const tt = t.get(d.id);
        if (tt) { tt.x += (ball.x - tt.x) * 0.6; tt.y += (ball.y - tt.y) * 0.6; }
      }
      if (carrier && t.get(carrier)) t.set(carrier, { x: ball.x - dirOf(atk) * 0.9, y: ball.y });
      return t;
    }
    function dist(a, b) {
      if (!a || !b) return 999;
      return Math.hypot(a.x - b.x, a.y - b.y);
    }
    function ensurePlayers() {
      for (let i = 0; i < 2; i++) {
        const layout = baseLayout(i);
        for (const [id, b] of layout) {
          if (!pos.has(id)) pos.set(id, { x: b.gk ? (i === 0 ? L - 2 : 2) : L / 2 + (b.fx - L / 2) * 0.6, y: b.fy, jx: 0, jy: 0 });
        }
      }
      const live = new Set(sim.sides.flatMap((s) => s.onPitch.map((x) => x.id)));
      for (const id of [...pos.keys()]) if (!live.has(id)) pos.delete(id);
    }
    function pickMate(i, forward) {
      const s = sim.sides[i];
      const cands = s.onPitch.filter((x) => x.slot !== 'GK' && x.id !== carrier);
      if (!cands.length) return null;
      // prefer players ahead of the ball when attacking forward
      let best = null;
      let bestW = -1;
      for (const x of cands) {
        const p = pos.get(x.id);
        if (!p) continue;
        const ahead = (p.x - ball.x) * dirOf(i);
        const w = Math.random() * 10 + (forward ? ahead * 0.4 : 0) - Math.abs(p.y - ball.y) * 0.08 - dist(p, ball) * 0.05;
        if (w > bestW) { bestW = w; best = x.id; }
      }
      return best;
    }

    // Called once per simulated minute.
    function tick(info) {
      ensurePlayers();
      focusId = null;
      atk = info.atk;
      for (const p of pos.values()) { p.jx = rand(-2.5, 2.5); p.jy = rand(-2.5, 2.5); }
      const now = performance.now();
      const dur = Math.max(120, info.dur * 0.95);
      const shot = info.events.find((e) => ['goal', 'save', 'miss', 'post'].includes(e.type));
      path = [];
      if (shot) {
        const i = shot.side;
        atk = i;
        const shooter = shot.scorer || shot.player;
        const sp = pos.get(shooter);
        if (sp) {
          // the shooter arrives at the edge of the box
          sp.x = i === 0 ? rand(11, 20) : L - rand(11, 20);
          sp.y = rand(WD / 2 - 12, WD / 2 + 12);
        }
        const goalX = i === 0 ? -1.2 : L + 1.2;
        let end;
        if (shot.type === 'goal') end = { x: goalX, y: WD / 2 + rand(-3, 3) };
        else if (shot.type === 'post') end = { x: i === 0 ? 0 : L, y: WD / 2 + (Math.random() < 0.5 ? -3.66 : 3.66) };
        else if (shot.type === 'save') end = { x: i === 0 ? 1.5 : L - 1.5, y: WD / 2 + rand(-2.5, 2.5) };
        else end = { x: goalX - dirOf(i) * 1.5, y: WD / 2 + (Math.random() < 0.5 ? -1 : 1) * rand(5, 12) };
        carrier = shooter;
        if (sp) path.push({ x: sp.x, y: sp.y, t: now + dur * 0.45 });
        path.push({ x: end.x, y: end.y, t: now + dur * 0.8 });
        if (shot.type === 'save' || shot.type === 'miss' || shot.type === 'post') {
          path.push({ x: end.x - dirOf(i) * (shot.type === 'save' ? 1 : -2), y: end.y, t: now + dur });
        }
        if (shot.type === 'goal') setTimeout(() => { ball.x = L / 2; ball.y = WD / 2; carrier = null; }, dur * 1.8);
      } else {
        const m1 = pickMate(atk, true);
        if (m1) {
          const p1 = pos.get(m1);
          path.push({ x: p1.x, y: p1.y, t: now + dur * 0.5 });
          carrier = m1;
          if (Math.random() < 0.6) {
            const keep = carrier;
            const m2 = pickMate(atk, Math.random() < 0.7);
            const p2 = m2 && pos.get(m2);
            if (p2) path.push({ x: p2.x, y: p2.y, t: now + dur, id: m2 });
            carrier = keep;
          }
        }
      }
      path.unshift({ x: ball.x, y: ball.y, t: now });
    }

    function advanceBall(now) {
      if (path.length < 2) return;
      while (path.length >= 2 && now >= path[1].t) {
        path.shift();
        if (path[0].id) carrier = path[0].id;
      }
      if (path.length < 2) {
        ball.x = path[0].x;
        ball.y = path[0].y;
        return;
      }
      const [a, b] = path;
      const k = Math.min(1, Math.max(0, (now - a.t) / Math.max(1, b.t - a.t)));
      ball.x = a.x + (b.x - a.x) * k;
      ball.y = a.y + (b.y - a.y) * k;
    }

    function resize() {
      const w = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const hgt = Math.round((w * (WD + 2 * M)) / (L + 2 * M));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${hgt}px`;
      scale = (w * dpr) / (L + 2 * M);
    }
    const X = (x) => (x + M) * scale;
    const Y = (y) => (y + M) * scale;

    function drawPitch() {
      const w = canvas.width;
      const hh = canvas.height;
      for (let k = 0; k < 12; k++) {
        ctx.fillStyle = k % 2 ? '#1c7a42' : '#1a6f3c';
        ctx.fillRect((w / 12) * k, 0, w / 12 + 1, hh);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = Math.max(1, scale * 0.15);
      ctx.strokeRect(X(0), Y(0), L * scale, WD * scale);
      ctx.beginPath(); ctx.moveTo(X(L / 2), Y(0)); ctx.lineTo(X(L / 2), Y(WD)); ctx.stroke();
      ctx.beginPath(); ctx.arc(X(L / 2), Y(WD / 2), 9.15 * scale, 0, Math.PI * 2); ctx.stroke();
      for (const side of [0, 1]) {
        const x0 = side ? L - 16.5 : 0;
        ctx.strokeRect(X(x0), Y(WD / 2 - 20.15), 16.5 * scale, 40.3 * scale);
        const x1 = side ? L - 5.5 : 0;
        ctx.strokeRect(X(x1), Y(WD / 2 - 9.15), 5.5 * scale, 18.3 * scale);
        ctx.beginPath(); ctx.arc(X(side ? L - 11 : 11), Y(WD / 2), 9.15 * scale, side ? Math.PI * 0.705 : -Math.PI * 0.295, side ? Math.PI * 1.295 : Math.PI * 0.295); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(X(side ? L : -2), Y(WD / 2 - 3.66), 2 * scale, 7.32 * scale);
      }
    }
    function drawPlayer(id, i, slot) {
      const p = pos.get(id);
      if (!p) return;
      const pl = S.players[id];
      const r = 1.7 * scale;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y) + r * 0.25, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = slot === 'GK' ? gkCol[i] : teamCol[i];
      ctx.fill();
      ctx.lineWidth = Math.max(1, scale * 0.25);
      ctx.strokeStyle = S.pro && id === S.pro.pid ? '#ffd166' : lightness(ctx.fillStyle) > 150 ? '#222' : '#fff';
      if (S.pro && id === S.pro.pid) ctx.lineWidth = scale * 0.6;
      ctx.stroke();
      ctx.fillStyle = lightness(slot === 'GK' ? gkCol[i] : teamCol[i]) > 150 ? '#111' : '#fff';
      ctx.font = `700 ${Math.round(r * 1.05)}px Heebo, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(pl && pl.no ? pl.no % 100 : ''), X(p.x), Y(p.y) + 0.5);
    }
    function draw() {
      drawPitch();
      for (let i = 0; i < 2; i++) for (const x of sim.sides[i].onPitch) drawPlayer(x.id, i, x.slot);
      const fp = focusId && pos.get(focusId);
      if (fp) {
        const pulse = 2.6 + Math.sin(performance.now() / 180) * 0.6;
        ctx.beginPath();
        ctx.arc(X(fp.x), Y(fp.y), pulse * scale, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = scale * 0.35;
        ctx.stroke();
      }
      // ball
      const r = 0.85 * scale;
      ctx.beginPath(); ctx.arc(X(ball.x) + r * 0.4, Y(ball.y) + r * 0.5, r, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();
      ctx.beginPath(); ctx.arc(X(ball.x), Y(ball.y), r, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = Math.max(1, scale * 0.12); ctx.strokeStyle = '#222'; ctx.stroke();
      // name of the player on the ball
      // label the player closest to the ball (if the ball is at someone's feet)
      let near = null;
      let nd = 3.2;
      for (const [id, p] of pos) {
        const d = Math.hypot(p.x - ball.x, p.y - ball.y);
        if (d < nd) { nd = d; near = id; }
      }
      const cp = near && pos.get(near);
      if (cp && S.players[near]) {
        const name = S.players[near].n;
        ctx.font = `700 ${Math.round(scale * 2.1)}px Heebo, sans-serif`;
        const tw = ctx.measureText(name).width;
        const bx = X(cp.x);
        const by = Y(cp.y) - scale * 3.6;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(bx - tw / 2 - scale * 0.8, by - scale * 1.4, tw + scale * 1.6, scale * 2.8);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, bx, by);
      }
    }
    function frame(now) {
      if (!running || !canvas.isConnected) {
        if (!canvas.isConnected && running && performance.now() - created > 2000) running = false;
        if (running) requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      advanceBall(now);
      const t = targets();
      const k = 1 - Math.exp(-dt * 3.2);
      for (const [id, tg] of t) {
        const p = pos.get(id);
        if (!p) continue;
        p.x += (tg.x - p.x) * k;
        p.y += (tg.y - p.y) * k;
      }
      draw();
      requestAnimationFrame(frame);
    }
    const created = performance.now();
    ensurePlayers();
    window.addEventListener('resize', resize);
    requestAnimationFrame(() => { resize(); requestAnimationFrame(frame); });
    return {
      el: canvas,
      tick,
      focus(id) {
        const p = pos.get(id);
        if (!p) return;
        focusId = id;
        const now = performance.now();
        path = [{ x: ball.x, y: ball.y, t: now }, { x: p.x - dirOf(atk) * 0.9, y: p.y, t: now + 350 }];
      },
      stop() { running = false; window.removeEventListener('resize', resize); },
    };
  }

  // ---------- match screen ----------
  const SPEEDS = [['x1', 450], ['x3', 150], ['x10', 45]];
  let speedIdx = 1;
  let autoDecide = false;

  function matchScreen(sim) {
    busy = true;
    const [H, A] = sim.sides;
    const userSide = S.mode === 'manager' ? sim.userSide : sim.proSide;
    let timer = null;
    let shown = 0;
    const scoreEl = h('div', { class: 'score row', style: { justifyContent: 'center', gap: '14px', flexWrap: 'nowrap' } });
    const minuteEl = h('div', { class: 'minute' });
    const feed = h('div', { class: 'commentary' });
    const statsEl = h('div');
    const controls = h('div', { class: 'row' });
    const endBox = h('div');
    const pv = pitchView(sim);
    let mom = 0;
    let live = false;
    const ICONS = { goal: '⚽', yellow: '🟨', red: '🟥', sub: '🔁', injury: '✚', save: '🧤', miss: '💨', post: '🥅', pro: '⭐', chance: '➜', half: '⏸', second: '▶', end: '🏁', kickoff: '🏁' };

    const team = (s) => h('div', { class: 'team' }, crest(s.club, true), h('span', { text: s.club.name }));
    const render = () => {
      scoreEl.replaceChildren(h('span', { text: String(H.goals) }), h('span', { text: '-' }), h('span', { text: String(A.goals) }));
      minuteEl.textContent = sim.done ? 'סיום' : sim.minute === 0 ? 'לפני המשחק' : `${sim.minute}'`;
      for (; shown < sim.events.length; shown++) {
        const e = sim.events[shown];
        if (!e.text) continue;
        feed.prepend(h('div', { class: `ev ${e.type}` }, h('span', { class: 'm num', text: `${e.min}'` }),
          h('span', { class: 'i', text: ICONS[e.type] || '•' }),
          e.side !== null && e.side !== undefined ? crest(sim.sides[e.side].club) : null,
          h('span', { text: e.text })));
        if (e.type === 'goal' && live) {
          const flash = h('div', { class: 'goal-flash', text: 'גול!' });
          flash.style.textShadow = `0 0 40px ${clubColor(sim.sides[e.side].club)}, 0 6px 0 rgba(0,0,0,.4)`;
          document.body.appendChild(flash);
          setTimeout(() => flash.remove(), 1500);
          mom = e.side === 0 ? 1 : -1;
        }
      }

      const tot = H.poss + A.poss || 1;
      const line = (label, a, b, fmt = (v) => String(v)) => h('div', { class: 'statline' },
        h('b', { class: 'num', text: fmt(a) }),
        h('div', null, h('div', { class: 'lbl', text: label }), h('div', { class: 'split' },
          h('i', { style: { width: `${(a / (a + b || 1)) * 100}%`, background: H.club.colors[0] === '#FFFFFF' ? '#ddd' : H.club.colors[0] } }),
          h('i', { style: { width: `${(b / (a + b || 1)) * 100}%`, background: A.club.colors[0] === '#FFFFFF' ? '#ddd' : A.club.colors[0] } }))),
        h('b', { class: 'num', text: fmt(b) }));
      statsEl.replaceChildren(
        line('החזקת כדור', Math.round((H.poss / tot) * 100), Math.round((A.poss / tot) * 100), (v) => `${v}%`),
        line('בעיטות', H.shots, A.shots), line('למסגרת', H.sot, A.sot),
        line('xG', Math.round(H.xg * 100) / 100, Math.round(A.xg * 100) / 100, (v) => v.toFixed(2)),
        line('כרטיסים צהובים', Object.values(H.yellows).reduce((s, v) => s + v, 0), Object.values(A.yellows).reduce((s, v) => s + v, 0)));
    };
    const stop = () => { clearInterval(timer); timer = null; renderControls(); };
    const tick = () => {
      const before = H.poss;
      const shotsBefore = [H.shots, A.shots];
      const evBefore = sim.events.length;
      sim.step();
      const homeBall = H.poss > before;
      pv.tick({ atk: homeBall ? 0 : 1, events: sim.events.slice(evBefore), dur: SPEEDS[speedIdx][1] });
      mom = mom * 0.75 + (homeBall ? 0.25 : -0.25);
      if (H.shots > shotsBefore[0]) mom = 0.95;
      if (A.shots > shotsBefore[1]) mom = -0.95;
      live = true;
      if (sim.pending) {
        if (autoDecide) sim.resolve(E.autoChoice(sim.pending));
        else {
          stop();
          render();
          if (S.pro) pv.focus(S.pro.pid);
          decisionModal(sim, () => { render(); if (sim.done) { renderControls(); showEnd(); } else start(); });
          return;
        }
      }
      render();
      if (sim.done) { stop(); showEnd(); }
    };
    const start = () => {
      if (sim.done) return;
      clearInterval(timer);
      timer = setInterval(tick, SPEEDS[speedIdx][1]);
      renderControls();
    };
    const renderControls = () => {
      controls.replaceChildren(...[
        sim.done ? null : h('button', { class: 'primary', text: timer ? '⏸ עצור' : sim.minute === 0 ? '▶ שריקת פתיחה' : '▶ המשך', onclick: () => (timer ? stop() : start()) }),
        h('span', { class: 'speed row', style: { gap: '4px' } }, SPEEDS.map(([l], i) => h('button', { class: 'small' + (i === speedIdx ? ' active' : ''), text: l, onclick: () => { speedIdx = i; if (timer) start(); else renderControls(); } }))),
        S.mode === 'pro' ? h('label', { class: 'row muted', style: { gap: '4px' } }, h('input', { type: 'checkbox', checked: autoDecide, onchange: (e) => { autoDecide = e.target.checked; } }), 'החלטות אוטומטיות') : null,
        S.mode === 'manager' && !sim.done ? h('button', { text: '🔁 חילופים וטקטיקה', onclick: () => { stop(); changesModal(sim, userSide, render); } }) : null,
        sim.done ? null : h('button', { class: 'small', text: 'דלג לסיום', onclick: () => {
          stop();
          while (!sim.done) {
            sim.step();
            if (sim.pending) sim.resolve(E.autoChoice(sim.pending));
          }
          live = false;
          pv.stop();
          render();
          renderControls();
          showEnd();
        } }),
      ].filter(Boolean));
    };
    const showEnd = () => {
      if (endBox.childNodes.length) return;
      const ratings = sim.ratings();
      const side = sim.sides[userSide];
      const rows = Object.keys(side.played).map((id) => S.players[id]).sort((a, b) => ratings[b.id] - ratings[a.id]);
      endBox.append(h('div', { class: 'card', style: { marginTop: '14px' } },
        h('h3', { text: 'ציונים' }),
        h('div', { class: 'table-wrap' }, h('table', null, h('tbody', null, rows.map((p) => h('tr', { class: S.pro && p.id === S.pro.pid ? 'me' : '' },
          h('td', null, posPill(p.pos)), h('td', { text: p.n }), h('td', { class: 'num muted', text: `${side.played[p.id]}'` }),
          h('td', { class: 'num' }, h('b', { style: { color: ovrColor(ratings[p.id] * 10 + 10) }, text: ratings[p.id].toFixed(1) }))))))),
        h('button', { class: 'primary', style: { marginTop: '12px' }, text: 'המשך ▸', onclick: () => { pv.stop(); finishWeek(sim); } })));
    };

    const proBanner = S.mode === 'pro' ? h('div', { class: 'card tight', style: { marginTop: '10px' } },
      sim.proRole === 'start' ? '⭐ אתה פותח בהרכב. ברגעי מפתח תתבקש לקבל החלטה.' : sim.proSubMinute ? '⭐ אתה על הספסל. ייתכן שתיכנס במחצית השנייה.' : '⭐ אתה על הספסל.') : null;
    const lineupCard = (s) => h('div', { class: 'card tight' }, h('h3', { text: s.club.name }),
      s.onPitch.map((x) => h('div', { class: 'row', style: { gap: '6px', margin: '3px 0' } }, posPill(x.slot), h('span', { text: S.players[x.id].n }), ovrBadge(S.players[x.id].ovr))));
    const board = h('div', { class: 'scoreboard' }, team(H), h('div', null, scoreEl, minuteEl), team(A));
    board.style.background = `linear-gradient(90deg, ${alpha(clubColor(A.club), 0.45)}, #0b1d16 38%, #0b1d16 62%, ${alpha(clubColor(H.club), 0.45)})`;
    app.replaceChildren(h('main', { class: 'match' },
      board,
      h('div', { class: 'pitch2d-wrap' }, pv.el,
        h('div', { class: 'lbls' }, h('span', { text: `◀ ${H.club.name} תוקפת` }), h('span', { text: `${A.club.name} תוקפת ▶` }))),
      proBanner,
      h('div', { class: 'row', style: { margin: '12px 0' } }, controls),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h3', { text: 'שידור חי' }), feed),
        h('div', null, h('div', { class: 'card' }, h('h3', { text: 'סטטיסטיקה' }), statsEl),
          h('div', { class: 'grid two', style: { marginTop: '14px' } }, lineupCard(H), lineupCard(A)))),
      endBox));
    render();
    renderControls();
  }

  function decisionModal(sim, onDone) {
    const m = sim.pending;
    openModal((close) => [
      h('div', { class: 'decision' + (m.injury ? ' injury' : '') },
        h('div', { class: 'row spread' }, h('span', { class: 'muted', text: `דקה ${sim.minute}'` }),
          m.pressure ? h('span', { class: 'tag', style: { background: 'rgba(255,107,107,.2)', color: '#ff9d9d' }, text: '⏱ לחץ של סוף משחק' }) : null),
        h('h2', { text: `${m.injury ? '🩹' : m.penalty ? '🎯' : '⭐'} ${m.title}` }),
        h('p', { text: m.desc }),
        m.options.map((o, i) => h('button', { class: 'opt' + (o.perk ? ' perk' : ''), onclick: () => {
          const r = sim.resolve(i);
          close();
          toast(`${r.success ? '✅' : '❌'} ${r.text}${r.result === 'goal' ? ' ⚽ גול!' : ''}`, 2200);
          if (r.chained && sim.pending) setTimeout(() => decisionModal(sim, onDone), 350);
          else onDone();
        } }, h('span', null, o.perk ? '✨ ' : '', o.label, o.boost ? h('small', { class: 'good', text: ` (+${o.boost}% מיכולות)` }) : null),
        h('span', { class: 'p', text: `${Math.round(o.p * 100)}%` }))),
        h('p', { class: 'muted', text: 'האחוז הוא סיכוי ההצלחה של הפעולה, לפי התכונות שלך מול היריבה, היכולות המיוחדות, הכימיה והלחץ.' })),
    ], { locked: true });
  }

  function changesModal(sim, i, rerender) {
    const s = sim.sides[i];
    openModal((close) => {
      const outSel = h('select', null, s.onPitch.map((x) => h('option', { value: String(x.id), text: `${x.slot} · ${S.players[x.id].n} (${Math.round(S.players[x.id].cond)}%)` })));
      const inSel = h('select', null, s.bench.filter((id) => E.available(S.players[id])).map((id) => h('option', { value: String(id), text: `${S.players[id].pos} · ${S.players[id].n} (${S.players[id].ovr})` })));
      return [modalHead('חילופים וטקטיקה', close),
        h('h3', { text: 'גישה' }),
        h('div', { class: 'row' }, Object.entries(E.MENTALITIES).map(([k, m]) => h('button', { class: s.mentality === k ? 'primary' : '', text: m.label, onclick: () => {
          s.mentality = k;
          sim.recalc();
          close();
          toast(`הגישה שונתה ל${m.label}`);
          rerender();
        } }))),
        h('h3', { style: { marginTop: '16px' }, text: `חילוף (נותרו ${s.subsLeft})` }),
        h('div', { class: 'row' }, 'יוצא:', outSel, 'נכנס:', inSel,
          h('button', { class: 'primary', disabled: s.subsLeft <= 0 || !inSel.options.length, text: 'בצע חילוף', onclick: () => {
            const ok = sim.substitute(i, Number(outSel.value), Number(inSel.value));
            toast(ok ? 'החילוף בוצע' : 'לא ניתן לבצע את החילוף');
            close();
            rerender();
          } }))];
    });
  }

  // Open the page with #debug to inspect the game state from the console: __tl()
  if (location.hash === '#debug') window.__tl = () => ({ S, refresh: gameScreen });

  startScreen();
})();
