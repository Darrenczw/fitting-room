// Fitting Room — prototype app shell (v0.1)
// Everything is stored on the phone (IndexedDB). Try-on is SIMULATED until the
// Cloudflare helper exists (milestone A4.1): it returns a demo result after a pause.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const COST = { pro: 0.13, flash: 0.07 };
const CAP = 5;
const CATS = { hair: 'Hair', top: 'Top', bottoms: 'Bottoms', outfit: 'Full outfit', shoes: 'Shoes', accessory: 'Accessory' };
const FILTER_OF = { hair: 'hair', top: 'clothes', bottoms: 'clothes', outfit: 'clothes', accessory: 'clothes', shoes: 'shoes' };

/* ---------- storage ---------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('fitting-room', 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('me');
    db.createObjectStore('looks', { keyPath: 'id', autoIncrement: true });
    db.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}
const db = {
  get: (st, k) => tx(st, 'readonly', s => s.get(k)),
  put: (st, v, k) => tx(st, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k))),
  del: (st, k) => tx(st, 'readwrite', s => s.delete(k)),
  all: (st) => tx(st, 'readonly', s => s.getAll()),
  clear: (st) => tx(st, 'readwrite', s => s.clear()),
};

/* ---------- image helpers ---------- */
const urls = new WeakMap();
const url = (blob) => { if (!blob) return ''; if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob)); return urls.get(blob); };
async function shrink(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
}
const fetchBlob = (p) => fetch(p).then(r => { if (!r.ok) throw new Error(p); return r.blob(); });

/* ---------- state ---------- */
let me = { face: null, body: null };
let looks = [];
let filter = 'all';
let current = null;      // look open in viewer
let draft = [];          // compose items [{blob, cat}]
let cancelTry = null;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms);
}
// iOS-style confirmation sheet (red destructive button + Cancel). Resolves true/false.
function ask(title, body, yes, destructive = true) {
  return new Promise(res => {
    $('#cfTitle').textContent = title; $('#cfBody').textContent = body || '';
    const y = $('#cfYes'); y.textContent = yes; y.className = destructive ? 'destructive' : '';
    const sh = $('#confirmSheet'), bd = $('#backdrop');
    const done = v => { sh.hidden = true; bd.hidden = true; bd.onclick = closeSheet; res(v); };
    y.onclick = () => done(true); $('#cfNo').onclick = () => done(false); bd.onclick = () => done(false);
    bd.hidden = false; sh.hidden = false; $('#cfNo').focus();
  });
}
const monthKey = () => new Date().toISOString().slice(0, 7);
async function spent() { return (await db.get('meta', 'spend-' + monthKey())) || 0; }
async function model() { return (await db.get('meta', 'model')) || 'pro'; }

/* ---------- home ---------- */
async function load() {
  me.face = await db.get('me', 'face');
  me.body = await db.get('me', 'body');
  looks = (await db.all('looks')).sort((a, b) => b.created - a.created);
}
function renderAvatars() {
  $('#avFace').src = url(me.face); $('#avBody').src = url(me.body);
}
function statusLabel(l) {
  if (l.status === 'bought') return l.cat === 'hair' ? 'Got the cut' : 'Bought';
  if (l.status === 'skipped') return 'Skipped';
  return '';
}
function renderGrid() {
  const list = looks.filter(l => filter === 'all' || FILTER_OF[l.cat] === filter || (filter === 'hair' && l.items?.some(i => i.cat === 'hair')));
  const g = $('#grid'); g.textContent = '';
  for (const l of list) {
    const t = document.createElement('button');
    t.className = 'tile';
    t.setAttribute('role', 'listitem');
    t.setAttribute('aria-label', `${CATS[l.cat] || 'Look'}${statusLabel(l) ? ', ' + statusLabel(l) : ''}${l.isNew ? ', new' : ''}`);
    const img = new Image(); img.src = url(l.result); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const orig = new Image(); orig.className = 'orig'; orig.alt = ''; orig.loading = 'lazy'; orig.src = url(l.original === 'face' ? me.face : me.body);
    t.append(img, orig);
    const s = statusLabel(l);
    if (s) { const c = document.createElement('span'); c.className = 'cap' + (l.status === 'skipped' ? ' skipped' : ''); c.textContent = s; t.append(c); }
    if (l.isNew) { const d = document.createElement('span'); d.className = 'dot'; t.append(d); }
    t.dataset.id = l.id;
    bindPeek(t, () => t.classList.add('peek'), () => t.classList.remove('peek'), () => openViewer(l, img));
    g.append(t);
  }
  $('#empty').hidden = looks.length > 0;
  $('#count').textContent = list.length ? `${list.length} ${list.length === 1 ? 'Look' : 'Looks'}` : (looks.length ? 'Nothing here yet' : '');
}
// Press-and-hold shows the original photo; a quick tap opens.
function bindPeek(el, on, off, tap) {
  let timer = null, peeking = false, moved = false, sx = 0, sy = 0;
  el.addEventListener('pointerdown', e => {
    moved = false; peeking = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { peeking = true; on(); navigator.vibrate?.(8); }, 280);
  });
  el.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { moved = true; clearTimeout(timer); if (peeking) { off(); peeking = false; } } });
  const end = () => { clearTimeout(timer); if (peeking) { off(); } else if (!moved && tap) tap(); peeking = false; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { clearTimeout(timer); off(); peeking = false; });
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap?.(); } });
}

$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  filter = b.dataset.f;
  $$('#filters button').forEach(x => x.setAttribute('aria-selected', x === b));
  renderGrid();
});
$('#scroller').addEventListener('scroll', e => $('#navbar').classList.toggle('scrolled', e.target.scrollTop > 40), { passive: true });

/* ---------- viewer ---------- */
const motionOK = () => document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches;
async function openViewer(l, fromImg) {
  if (fromImg && motionOK()) {
    fromImg.style.viewTransitionName = 'look';
    const vt = document.startViewTransition(async () => {
      fromImg.style.viewTransitionName = '';
      $('#vResult').style.viewTransitionName = 'look';
      $('#viewer').classList.add('vt');
      await showViewer(l);
    });
    await vt.finished.catch(() => {});
    $('#vResult').style.viewTransitionName = '';
    $('#viewer').classList.remove('vt');
    return;
  }
  await showViewer(l);
}
async function showViewer(l) {
  current = l;
  if (l.isNew) { l.isNew = false; await db.put('looks', l); }
  $('#vResult').src = url(l.result);
  $('#vOriginal').src = url(l.original === 'face' ? me.face : me.body);
  $('#vTitle').textContent = l.items?.length > 1 ? 'Full look' : (CATS[l.cat] || 'Look');
  const d = new Date(l.created);
  $('#vSub').textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (l.simulated ? ' · prototype' : '');
  const vi = $('#vItems'); vi.textContent = '';
  if (l.items?.some(i => i.blob)) {
    for (const it of l.items) if (it.blob) {
      const b = document.createElement('button');
      const im = new Image(); im.src = url(it.blob); im.alt = '';
      b.append(im, document.createTextNode(CATS[it.cat] || 'Item'));
      b.setAttribute('aria-label', 'Show inspiration photo');
      b.onclick = () => { $('#inspoImg').src = url(it.blob); $('#inspo').hidden = false; };
      vi.append(b);
    }
  } else if (l.words) {
    const p = document.createElement('span'); p.className = 'words'; p.textContent = l.words; vi.append(p);
  }
  const tags = $('#vTags'); tags.textContent = '';
  for (const [k, label] of [['bought', l.cat === 'hair' ? 'Got the cut' : 'Bought'], ['skipped', 'Skipped']]) {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', l.status === k); b.textContent = label;
    b.onclick = async () => { l.status = l.status === k ? null : k; await db.put('looks', l); openViewerTags(); renderGrid(); };
    tags.append(b);
  }
  $('#vHint').style.opacity = 1; setTimeout(() => ($('#vHint').style.opacity = 0), 2200);
  $('#viewer').hidden = false;
  renderGrid();
}
function openViewerTags() { $$('#vTags button').forEach((b, i) => b.setAttribute('aria-checked', current.status === (i ? 'skipped' : 'bought'))); }
{ // viewer: press and hold anywhere on the photo to see the original
  const st = $('#vStage');
  const on = () => { st.classList.add('peek'); $('#vBefore').hidden = false; $('#vHint').style.opacity = 0; };
  const off = () => { st.classList.remove('peek'); $('#vBefore').hidden = true; };
  // Swipe down to close, like Photos. A vertical drag cancels the before peek.
  let sy = null, dy = 0, drag = false;
  const img = $('#vResult'), v = $('#viewer');
  let peekT = null;
  st.addEventListener('pointerdown', e => { sy = e.clientY; dy = 0; drag = false; clearTimeout(peekT); peekT = setTimeout(on, 150); st.setPointerCapture?.(e.pointerId); });
  st.addEventListener('pointermove', e => {
    if (sy == null) return;
    dy = e.clientY - sy;
    if (Math.abs(dy) > 6) clearTimeout(peekT);
    if (!drag && dy > 12) { drag = true; off(); v.classList.add('dragging'); }
    if (drag) {
      const d = Math.max(0, dy);
      img.style.transform = 'translateY(' + d + 'px) scale(' + (1 - Math.min(d, 400) / 1600) + ')';
      v.style.setProperty('--fade', String(1 - Math.min(d, 300) / 400));
    }
  });
  const end = () => {
    clearTimeout(peekT);
    if (sy == null) return;
    sy = null; off();
    if (drag && dy > 110) { closeViewer(); return; }
    v.classList.remove('dragging'); v.style.removeProperty('--fade'); img.style.transform = '';
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('contextmenu', e => e.preventDefault());
}
function closeViewer() {
  const id = current?.id;
  const tileImg = id != null ? document.querySelector('.tile[data-id="' + id + '"] img') : null;
  const finish = () => {
    const v = $('#viewer');
    v.hidden = true; v.classList.remove('dragging'); v.style.removeProperty('--fade');
    $('#vResult').style.transform = ''; current = null;
  };
  if (tileImg && motionOK()) {
    $('#vResult').style.viewTransitionName = 'look';
    const vt = document.startViewTransition(() => { $('#vResult').style.viewTransitionName = ''; finish(); tileImg.style.viewTransitionName = 'look'; });
    vt.finished.finally(() => (tileImg.style.viewTransitionName = ''));
  } else finish();
}
$('#vClose').onclick = closeViewer;
$('#inspoClose').onclick = () => ($('#inspo').hidden = true);
$('#vShare').onclick = async () => {
  const f = new File([current.result], 'fitting-room.jpg', { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch {} }
  else { const a = document.createElement('a'); a.href = url(current.result); a.download = 'fitting-room.jpg'; a.click(); }
};
$('#vDelete').onclick = async () => {
  if (!(await ask('Delete this look?', 'It can’t be undone.', 'Delete Look'))) return;
  await db.del('looks', current.id); looks = looks.filter(l => l !== current);
  $('#viewer').hidden = true; current = null; renderGrid();
};
$('#vAgain').onclick = () => { const l = current; $('#viewer').hidden = true; runTryOn(l.items.map(i => ({ ...i })), l); };

/* ---------- compose ---------- */
function openSheet() { $('#backdrop').hidden = false; $('#actionsheet').hidden = false; }
function closeSheet() { $('#backdrop').hidden = true; $('#actionsheet').hidden = true; }
$('#tryOn').onclick = async () => {
  if (!navigator.onLine) return toast('Try On needs internet.');
  if ((await spent()) >= CAP && !(await ask('You’ve reached US$' + CAP + ' this month', 'Each try-on still costs about US$0.13.', 'Try On Anyway', false))) return;
  draft = []; openSheet();
};
$('#backdrop').onclick = closeSheet; $('#asCancel').onclick = closeSheet;
$('#asLibrary').onclick = () => { closeSheet(); $('#pickLibrary').click(); };
$('#asCamera').onclick = () => { closeSheet(); $('#pickCamera').click(); };
for (const id of ['#pickLibrary', '#pickCamera']) $(id).addEventListener('change', async e => {
  const files = [...e.target.files].slice(0, 3 - draft.length); e.target.value = '';
  if (!files.length) return;
  for (const f of files) draft.push({ blob: await shrink(f), cat: draft.length ? 'outfit' : 'outfit' });
  renderCompose(); $('#compose').hidden = false;
});
function renderCompose() {
  const c = $('#cItems'); c.textContent = '';
  draft.forEach((it, i) => {
    const w = document.createElement('div'); w.className = 'c-item';
    const im = new Image(); im.src = url(it.blob); im.alt = 'Item ' + (i + 1);
    const rm = document.createElement('button'); rm.className = 'rm'; rm.setAttribute('aria-label', 'Remove item');
    rm.innerHTML = '<svg><use href="#i-close"/></svg>';
    rm.onclick = () => { draft.splice(i, 1); draft.length ? renderCompose() : ($('#compose').hidden = true); };
    const sel = document.createElement('select'); sel.setAttribute('aria-label', 'What is it');
    for (const [k, v] of Object.entries(CATS)) sel.add(new Option(v, k, false, k === it.cat));
    sel.onchange = () => (it.cat = sel.value);
    w.append(im, rm, sel); c.append(w);
  });
  $('#cAdd').hidden = draft.length >= 3;
  $('#cNote').textContent = draft.length > 1 ? 'All items go on you in one picture.' : 'Check the label. In the finished app the AI fills it in.';
}
$('#cCancel').onclick = () => { $('#compose').hidden = true; draft = []; };
$('#cAdd').onclick = openSheet;
$('#cGo').onclick = () => { $('#compose').hidden = true; runTryOn(draft); };

/* ---------- try-on (simulated) ---------- */
// Simulated results use photos that no demo look uses, so a try-on never shows a duplicate.
const DEMO_RESULT = { hair: 'demo/flash-A-hair.jpg', shoes: 'demo/4-shoes-sneakers.jpg', default: 'demo/5-full-outfit.jpg' };
async function runTryOn(items, replace) {
  const onlyHair = items.every(i => i.cat === 'hair');
  const original = onlyHair ? 'face' : 'body';
  $('#wImg').src = url(me[original]); $('#waiting').hidden = false;
  const t0 = Date.now(); const tick = setInterval(() => ($('#wTime').textContent = Math.floor((Date.now() - t0) / 1000) + ' s'), 250);
  $('#wTime').textContent = '0 s';
  const cancelled = await new Promise(r => {
    const tm = setTimeout(() => r(false), 3200);
    cancelTry = () => { clearTimeout(tm); r(true); };
  });
  cancelTry = null; clearInterval(tick); $('#waiting').hidden = true;
  if (cancelled) return toast('Cancelled. Nothing was charged.');
  const cat = items.length > 1 ? 'outfit' : items[0].cat;
  let result;
  let placeholder = false;
  try { result = await fetchBlob(DEMO_RESULT[onlyHair ? 'hair' : cat === 'shoes' ? 'shoes' : 'default']); }
  catch { result = me[original]; placeholder = true; }
  const m = await model();
  await db.put('meta', (await spent()) + COST[m], 'spend-' + monthKey());
  const look = { cat: onlyHair ? 'hair' : cat, result, original, items, status: null, created: Date.now(), isNew: false, simulated: true };
  look.id = await db.put('looks', look);
  if (replace) toast('New version added to your looks.');
  looks.unshift(look); renderGrid(); openViewer(look);
  if (placeholder) toast('Prototype: the AI isn’t connected yet, so this shows your own photo.', 4200);
}
$('#wCancel').onclick = () => cancelTry?.();

/* ---------- me & settings ---------- */
let pickSlot = null;
async function openMe() {
  $$('#me .me-slot').forEach(s => ($('img', s).src = url(me[s.dataset.slot])));
  const m = await model(); $$('#me input[name=model]').forEach(r => (r.checked = r.value === m));
  const s = await spent();
  $('#spent').textContent = 'US$' + s.toFixed(2);
  $('#meterFill').style.width = Math.min(100, (s / CAP) * 100) + '%';
  $('#meter').classList.toggle('over', s >= CAP);
  $('#me').hidden = false;
}
$('#openMe').onclick = openMe;
$('#meDone').onclick = () => ($('#me').hidden = true);
$$('#me input[name=model]').forEach(r => r.onchange = () => db.put('meta', r.value, 'model'));
$$('.me-slot, .slot').forEach(b => b.onclick = () => { pickSlot = b.dataset.slot; $('#pickMe').click(); });
$('#pickMe').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  me[pickSlot] = await shrink(f); await db.put('me', me[pickSlot], pickSlot);
  renderAvatars(); renderSetup();
  if (!$('#me').hidden) openMe();
  renderGrid();
});
$('#eraseAll').onclick = async () => {
  if (!(await ask('Delete all looks?', 'Your two photos stay. This can’t be undone.', 'Delete All Looks'))) return;
  await db.clear('looks'); looks = []; $('#me').hidden = true; renderGrid();
};
$('#loadDemo').onclick = async () => { await loadDemo(); $('#me').hidden = true; };

/* ---------- setup ---------- */
function renderSetup() {
  $$('#setup .slot').forEach(s => { const im = $('img', s); const b = me[s.dataset.slot]; im.hidden = !b; if (b) im.src = url(b); });
  $('#setupDone').disabled = !(me.face && me.body);
}
$('#setupDone').onclick = () => { $('#setup').hidden = true; renderAvatars(); renderGrid(); };
$('#setupDemo').onclick = async () => { await loadDemo(); $('#setup').hidden = true; };

/* ---------- demo data (local only, never deployed) ---------- */
async function loadDemo() {
  try {
    const spec = await (await fetch('demo/demo.json')).json();
    for (const k of ['face', 'body']) { me[k] = await fetchBlob(spec.me[k]); await db.put('me', me[k], k); }
    await db.clear('looks');
    const now = Date.now();
    for (const [i, d] of spec.looks.entries()) {
      const items = [];
      for (const it of d.items || []) items.push({ cat: it.cat, blob: await fetchBlob(it.src) });
      await db.put('looks', { cat: d.cat, result: await fetchBlob(d.result), original: d.original, items, words: d.words || '', status: d.status || null, isNew: !!d.isNew, created: now - i * 3.6e6 * 7 });
    }
    await load(); renderAvatars(); renderGrid(); toast('Demo looks loaded.');
  } catch (e) { toast('No demo photos in this copy.'); }
}

/* ---------- boot ---------- */
function onlineUI() { $('#offline').hidden = navigator.onLine; $('#tryOn').disabled = !navigator.onLine; }
addEventListener('online', onlineUI); addEventListener('offline', onlineUI);
(async () => {
  fetch('demo/demo.json', { method: 'HEAD' }).then(r => { if (!r.ok) throw 0; }).catch(() => { $('#setupDemo').hidden = true; $('#loadDemo').hidden = true; });
  await load();
  onlineUI();
  if (!me.face || !me.body) { renderSetup(); $('#setup').hidden = false; }
  renderAvatars(); renderGrid();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
