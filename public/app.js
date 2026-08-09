/* Stunt Flashcards — frontend logic.
   All roster data lives in memory + localStorage; the Worker only fetches/parses. */

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    setup: $('setup'), study: $('study'), done: $('done'),
    urlInput: $('url-input'), buildBtn: $('build-btn'), status: $('setup-status'),
    resumeBtn: $('resume-btn'), sampleBtn: $('sample-btn'),
    optAbout: $('opt-about'), optSkills: $('opt-skills'),
    backBtn: $('back-btn'), reshuffleBtn: $('reshuffle-btn'),
    listTitle: $('list-title'), progress: $('progress'), score: $('score'),
    card: $('card'), cardFront: $('card-front'), cardBack: $('card-back'),
    feedback: $('feedback'), choices: $('choices'), selfgrade: $('selfgrade'),
    gradeHit: $('grade-hit'), gradeMiss: $('grade-miss'),
    prevBtn: $('prev-btn'), flipBtn: $('flip-btn'), nextBtn: $('next-btn'),
    doneHeadline: $('done-headline'), doneSummary: $('done-summary'),
    againBtn: $('again-btn'), missedBtn: $('missed-btn'), doneBackBtn: $('done-back-btn'),
  };

  const LS = { settings: 'sfc:settings', roster: 'sfc:roster', url: 'sfc:url' };

  const state = {
    roster: null,   // { title, sourceUrl, people: [{name, headshot, about, skills}] }
    deck: [],       // [{ type: 'headshot'|'about'|'skill', person, skill?, options?, answered?, correct? }]
    idx: 0,
    flipped: false,
    autoTimer: null,
  };

  // ------------------------------------------------------------------
  // Utilities
  // ------------------------------------------------------------------

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sample(arr, n) {
    return shuffle(arr).slice(0, n);
  }

  function settings() {
    const mode = document.querySelector('input[name="mode"]:checked')?.value || 'flip';
    return { mode, about: els.optAbout.checked, skills: els.optSkills.checked };
  }

  function applySettings(s) {
    if (!s) return;
    const radio = document.querySelector(`input[name="mode"][value="${s.mode === 'choice' ? 'choice' : 'flip'}"]`);
    if (radio) radio.checked = true;
    els.optAbout.checked = s.about !== false;
    els.optSkills.checked = s.skills !== false;
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS.settings, JSON.stringify(settings()));
      if (state.roster) localStorage.setItem(LS.roster, JSON.stringify(state.roster));
      localStorage.setItem(LS.url, els.urlInput.value || '');
    } catch { /* storage full or blocked — fine */ }
  }

  function loadLocal() {
    try {
      applySettings(JSON.parse(localStorage.getItem(LS.settings) || 'null'));
      els.urlInput.value = localStorage.getItem(LS.url) || '';
      const roster = JSON.parse(localStorage.getItem(LS.roster) || 'null');
      if (roster && Array.isArray(roster.people) && roster.people.length) {
        state.roster = roster;
        els.resumeBtn.textContent = `Resume: ${roster.title || 'last list'} (${roster.people.length} people)`;
        els.resumeBtn.classList.remove('hidden');
      }
    } catch { /* corrupted storage — ignore */ }
  }

  // Deterministic hue per name for placeholder avatars.
  function nameHue(name) {
    let h = 0;
    for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  function avatarDataUri(name) {
    const initials = name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
    const hue = nameHue(name);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500">` +
      `<rect width="400" height="500" fill="hsl(${hue},45%,26%)"/>` +
      `<circle cx="200" cy="185" r="85" fill="hsl(${hue},50%,42%)"/>` +
      `<ellipse cx="200" cy="410" rx="150" ry="115" fill="hsl(${hue},50%,42%)"/>` +
      `<text x="200" y="212" text-anchor="middle" font-family="Arial, sans-serif" font-size="72" font-weight="bold" fill="hsl(${hue},70%,88%)">${initials}</text>` +
      `</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  // Headshot <img> with graceful fallback: direct -> worker proxy -> initials avatar.
  function personImg(person) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'eager';
    img.decoding = 'async';
    const src = person.headshot;
    if (!src || src.startsWith('data:')) {
      img.src = src || avatarDataUri(person.name);
      return img;
    }
    let stage = 0;
    img.onerror = () => {
      stage++;
      if (stage === 1) img.src = '/api/img?src=' + encodeURIComponent(src);
      else { img.onerror = null; img.src = avatarDataUri(person.name); }
    };
    img.src = src;
    return img;
  }

  // Hide the person's own name inside bio/skill text so cards don't self-answer.
  function redactName(text, name) {
    let out = text;
    const tokens = name.split(/\s+/).filter((t) => t.length >= 3);
    if (name.length >= 3) tokens.unshift(name);
    for (const t of tokens) {
      const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(^|\\P{L})${esc}(?=\\P{L}|$)`, 'giu'), '$1▮▮▮');
    }
    return out;
  }

  function truncate(text, n) {
    if (!text || text.length <= n) return text || '';
    const cut = text.slice(0, n);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 20)) + '…';
  }

  // ------------------------------------------------------------------
  // Deck building
  // ------------------------------------------------------------------

  function buildDeck(roster, opts) {
    const people = roster.people;
    const cards = [];

    // Every single person gets a headshot card — nobody is left out.
    for (const p of people) cards.push({ type: 'headshot', person: p });

    if (opts.about) {
      for (const p of people) {
        if ((p.about || '').trim().length >= 30) cards.push({ type: 'about', person: p });
      }
    }

    if (opts.skills) {
      let skillCards = [];
      for (const p of people) {
        const described = (p.skills || []).filter((s) => (s.description || '').trim().length >= 25);
        for (const s of sample(described, 2)) skillCards.push({ type: 'skill', person: p, skill: s });
      }
      // Random subset so skills never dominate the deck.
      skillCards = sample(skillCards, Math.max(4, people.length));
      cards.push(...skillCards);
    }

    const deck = shuffle(cards);

    // Pre-compute multiple-choice options (correct + up to 3 distractors).
    for (const card of deck) {
      const others = people.filter((p) => p !== card.person);
      card.options = shuffle([card.person, ...sample(others, Math.min(3, others.length))]);
      card.answered = false;
      card.correct = null;
    }
    return deck;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderCardFaces(card) {
    els.cardFront.replaceChildren();
    els.cardBack.replaceChildren();
    const p = card.person;

    // ---- front ----
    if (card.type === 'headshot') {
      els.cardFront.append(el('div', 'face-ribbon', 'Who is this?'));
      const hero = el('div', 'face-body');
      const wrap = el('div', 'headshot-hero');
      wrap.append(personImg(p));
      hero.append(wrap);
      els.cardFront.append(hero);
    } else if (card.type === 'about') {
      els.cardFront.append(el('div', 'face-ribbon', 'About me — who is it?'));
      const body = el('div', 'face-body text-front');
      body.append(el('div', 'quote', truncate(redactName(p.about, p.name), 700)));
      els.cardFront.append(body);
    } else {
      els.cardFront.append(el('div', 'face-ribbon', 'Skill — whose is it?'));
      const body = el('div', 'face-body text-front');
      body.append(el('span', 'skill-pill', card.skill.name));
      body.append(el('div', 'quote', truncate(redactName(card.skill.description, p.name), 650)));
      els.cardFront.append(body);
    }

    // ---- back ----
    els.cardBack.append(el('div', 'face-ribbon answer', 'Answer'));
    const backBody = el('div', 'face-body');
    const photo = el('div', 'back-photo');
    photo.append(personImg(p));
    backBody.append(photo);
    const info = el('div', 'back-info');
    info.append(el('div', 'back-name', p.name));
    if (card.type === 'skill') {
      info.append(el('div', 'back-sub', `Skill: ${card.skill.name}`));
    } else if (card.type === 'headshot' && (p.about || '').trim()) {
      info.append(el('div', 'back-sub', truncate(p.about, 140)));
    }
    const skillNames = (p.skills || []).map((s) => s.name).filter(Boolean);
    if (card.type !== 'skill' && skillNames.length) {
      const row = el('div', 'chip-row');
      for (const s of skillNames.slice(0, 5)) row.append(el('span', 'chip', s));
      info.append(row);
    }
    backBody.append(info);
    els.cardBack.append(backBody);
  }

  function renderChoices(card) {
    els.choices.replaceChildren();
    card.options.forEach((personOpt, i) => {
      const btn = el('button', 'choice');
      btn.append(el('span', 'num', String(i + 1)));
      btn.append(document.createTextNode(personOpt.name));
      btn.dataset.index = String(i);
      if (card.answered) {
        btn.disabled = true;
        if (personOpt === card.person) btn.classList.add('correct');
        else if (card.chosen === personOpt && !card.correct) btn.classList.add('wrong');
      } else {
        btn.addEventListener('click', () => answerChoice(card, personOpt, btn));
      }
      els.choices.append(btn);
    });
  }

  function currentCard() {
    return state.deck[state.idx];
  }

  function scoreCounts() {
    let right = 0, wrong = 0;
    for (const c of state.deck) {
      if (c.answered && c.correct === true) right++;
      if (c.answered && c.correct === false) wrong++;
    }
    return { right, wrong };
  }

  function renderStudy() {
    clearTimeout(state.autoTimer);
    const card = currentCard();
    const mode = settings().mode;
    if (!card) return;

    renderCardFaces(card);
    els.card.classList.toggle('flipped', state.flipped);
    els.progress.textContent = `Card ${state.idx + 1} / ${state.deck.length}`;

    const { right, wrong } = scoreCounts();
    els.score.replaceChildren();
    if (right || wrong) {
      const g = el('span', 'good', `✓ ${right}`);
      const b = el('span', 'bad', `✗ ${wrong}`);
      els.score.append(g, document.createTextNode(' · '), b);
    }

    els.feedback.className = 'feedback';
    els.feedback.textContent = '';
    if (card.answered) {
      els.feedback.classList.add(card.correct ? 'good' : 'bad');
      els.feedback.textContent = card.correct ? 'Correct!' : `It’s ${card.person.name}`;
    }

    const choiceMode = mode === 'choice' && card.options.length >= 2;
    els.choices.classList.toggle('hidden', !choiceMode);
    if (choiceMode) renderChoices(card);

    const showGrade = mode === 'flip' && state.flipped && !card.answered;
    els.selfgrade.classList.toggle('hidden', !showGrade);

    els.prevBtn.disabled = state.idx === 0;
    els.flipBtn.textContent = state.flipped ? 'Flip back' : 'Flip';
    els.nextBtn.textContent = state.idx === state.deck.length - 1 ? 'Finish' : '→';
  }

  function show(section) {
    for (const s of [els.setup, els.study, els.done]) s.classList.add('hidden');
    section.classList.remove('hidden');
  }

  // ------------------------------------------------------------------
  // Study flow
  // ------------------------------------------------------------------

  function startStudy({ deck } = {}) {
    state.deck = deck || buildDeck(state.roster, settings());
    if (!state.deck.length) {
      showStatus('error', 'No cards could be built from this list.');
      show(els.setup);
      return;
    }
    state.idx = 0;
    state.flipped = false;
    els.listTitle.textContent = state.roster.title || 'Stunt list';
    show(els.study);
    renderStudy();
    els.card.focus({ preventScroll: true });
  }

  function flip() {
    state.flipped = !state.flipped;
    renderStudy();
  }

  function go(delta) {
    const next = state.idx + delta;
    if (next < 0) return;
    if (next >= state.deck.length) {
      finishDeck();
      return;
    }
    state.idx = next;
    state.flipped = false;
    renderStudy();
  }

  function answerChoice(card, personOpt, btn) {
    if (card.answered) return;
    card.answered = true;
    card.chosen = personOpt;
    card.correct = personOpt === card.person;
    state.flipped = true;
    renderStudy();
    if (card.correct) {
      state.autoTimer = setTimeout(() => go(1), 900);
    }
  }

  function selfGrade(correct) {
    const card = currentCard();
    if (!card || card.answered) return;
    card.answered = true;
    card.correct = correct;
    renderStudy();
    state.autoTimer = setTimeout(() => go(1), 500);
  }

  function finishDeck() {
    clearTimeout(state.autoTimer);
    const { right, wrong } = scoreCounts();
    const total = state.deck.length;
    const answered = right + wrong;
    const missed = state.deck.filter((c) => c.answered && !c.correct);

    els.doneHeadline.textContent = wrong === 0 && answered > 0 ? 'Perfect run! 🏆' : 'Deck complete! 🎬';
    els.doneSummary.textContent =
      answered > 0
        ? `You went ${right} for ${answered} on ${total} cards covering ${state.roster.people.length} people.`
        : `You flipped through ${total} cards covering ${state.roster.people.length} people.`;
    els.missedBtn.textContent = `Review missed cards (${missed.length})`;
    els.missedBtn.disabled = missed.length === 0;
    show(els.done);
  }

  // ------------------------------------------------------------------
  // Roster loading
  // ------------------------------------------------------------------

  function showStatus(kind, text) {
    els.status.className = 'status ' + kind;
    els.status.textContent = text;
    els.status.classList.remove('hidden');
  }

  function hideStatus() {
    els.status.classList.add('hidden');
  }

  function normalizeRoster(data, url) {
    const people = (data.people || [])
      .filter((p) => p && typeof p.name === 'string' && p.name.trim())
      .map((p) => ({
        name: p.name.trim(),
        headshot: typeof p.headshot === 'string' ? p.headshot : null,
        about: typeof p.about === 'string' ? p.about : '',
        skills: Array.isArray(p.skills)
          ? p.skills
              .filter((s) => s && typeof s.name === 'string')
              .map((s) => ({ name: s.name, description: typeof s.description === 'string' ? s.description : '' }))
          : [],
      }));
    return { title: data.title || 'Stunt list', sourceUrl: url, people };
  }

  async function buildFromUrl(explicitUrl) {
    const url = (explicitUrl || els.urlInput.value || '').trim();
    if (!url) {
      showStatus('error', 'Paste a list URL first.');
      return;
    }
    els.urlInput.value = url;
    els.buildBtn.disabled = true;
    els.sampleBtn.disabled = true;
    showStatus('loading', 'Fetching the list and building your deck…');
    try {
      const res = await fetch('/api/list?url=' + encodeURIComponent(url));
      const data = await res.json().catch(() => ({ ok: false, error: `Unexpected response (HTTP ${res.status})` }));
      if (!data.ok) throw new Error(data.error || `Could not read that list (HTTP ${res.status}).`);
      const roster = normalizeRoster(data, url);
      if (!roster.people.length) throw new Error('The page was fetched, but no people were found on it.');
      const withPhotos = roster.people.filter((p) => p.headshot).length;
      state.roster = roster;
      hideStatus();
      saveLocal();
      // Make the loaded deck a shareable/bookmarkable link.
      try {
        const share = new URL(window.location.href);
        share.searchParams.set('list', url);
        history.replaceState(null, '', share);
      } catch { /* non-fatal */ }
      startStudy();
      if (withPhotos === 0) {
        showStatus('error', `Loaded ${roster.people.length} people, but none had a headshot the app could read — cards show initials instead.`);
      }
    } catch (err) {
      showStatus('error', String(err.message || err));
    } finally {
      els.buildBtn.disabled = false;
      els.sampleBtn.disabled = false;
    }
  }

  // Optional one-click sample deck, configured server-side via SAMPLE_LIST_URL.
  async function loadSampleConfig() {
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      if (!cfg.ok || !cfg.sampleListUrl) return;
      els.sampleBtn.textContent = cfg.sampleListLabel;
      els.sampleBtn.classList.remove('hidden');
      els.sampleBtn.addEventListener('click', () => buildFromUrl(cfg.sampleListUrl));
    } catch { /* no sample configured — fine */ }
  }

  // ------------------------------------------------------------------
  // Wire-up
  // ------------------------------------------------------------------

  els.buildBtn.addEventListener('click', () => buildFromUrl());
  els.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') buildFromUrl();
  });

  els.resumeBtn.addEventListener('click', () => {
    if (state.roster) startStudy();
  });

  function goToSetup() {
    clearTimeout(state.autoTimer);
    show(els.setup);
    if (state.roster) {
      els.resumeBtn.textContent = `Resume: ${state.roster.title || 'last list'} (${state.roster.people.length} people)`;
      els.resumeBtn.classList.remove('hidden');
    }
  }

  els.backBtn.addEventListener('click', goToSetup);
  els.doneBackBtn.addEventListener('click', goToSetup);

  els.reshuffleBtn.addEventListener('click', () => startStudy());
  els.againBtn.addEventListener('click', () => startStudy());
  els.missedBtn.addEventListener('click', () => {
    const missed = state.deck.filter((c) => c.answered && !c.correct);
    if (!missed.length) return;
    const deck = shuffle(missed).map((c) => ({ ...c, answered: false, correct: null, chosen: null }));
    startStudy({ deck });
  });

  els.card.addEventListener('click', flip);
  els.card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      flip();
    }
  });
  els.flipBtn.addEventListener('click', flip);
  els.prevBtn.addEventListener('click', () => go(-1));
  els.nextBtn.addEventListener('click', () => go(1));
  els.gradeHit.addEventListener('click', () => selfGrade(true));
  els.gradeMiss.addEventListener('click', () => selfGrade(false));

  document.addEventListener('keydown', (e) => {
    if (els.study.classList.contains('hidden')) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      flip();
    } else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
    else if (/^[1-4]$/.test(e.key) && settings().mode === 'choice') {
      const card = currentCard();
      const i = Number(e.key) - 1;
      if (card && !card.answered && card.options[i]) {
        const btn = els.choices.querySelector(`[data-index="${i}"]`);
        if (btn) btn.click();
      }
    }
  });

  for (const input of document.querySelectorAll('input[name="mode"], #opt-about, #opt-skills')) {
    input.addEventListener('change', saveLocal);
  }

  loadLocal();
  loadSampleConfig();

  // Deep link: /?list=<url> loads that roster straight away, so a specific
  // list (a New York crew, a show's stunt team) can be bookmarked or shared.
  const deepLink = new URLSearchParams(window.location.search).get('list');
  if (deepLink) buildFromUrl(deepLink);
})();
