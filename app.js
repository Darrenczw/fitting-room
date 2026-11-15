// Fitting Room (v0.2)
// Photos and looks are stored on the phone only (IndexedDB). Try-ons go through the
// private Cloudflare helper (fitting-room-ai), which holds the Gemini key and stores nothing.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const COST = { pro: 0.13, flash: 0.07 };
const CAP = 5;
const VERSION = '0.2.3';
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
async function decode(file) {
  try { return await createImageBitmap(file); } catch {}
  const u = URL.createObjectURL(file);
  try { const im = new Image(); im.src = u; await im.decode(); return im; }
  finally { setTimeout(() => URL.revokeObjectURL(u), 1000); }
}
async function shrink(file, max = 1600) {
  try {
    const src = await decode(file);
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.86));
    if (out) return out;
  } catch (err) { console.warn('shrink failed', err); }
  return file; // last resort: keep the original photo
}
const AI = 'https://fitting-room-ai.darren-chow-1.workers.dev';
async function toB64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer()); let out = '';
  for (let i = 0; i < buf.length; i += 0x8000) out += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(out);
}
const img64 = async (blob) => ({ mime: blob.type || 'image/jpeg', data: await toB64(blob) });
let hasKey = false;
const extractKey = (txt) => (String(txt || '').match(/(?:key=)?([\w-]{24,})/) || [])[1] || '';
// Checks a key with the helper: a right key gets 400 (empty request), a wrong one gets 401.
async function checkKey(k) {
  try {
    const r = await fetch(AI + '/label', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Passphrase': k }, body: '{}' });
    return r.status === 400 ? 'ok' : r.status === 401 ? 'wrong' : 'error';
  } catch { return 'offline'; }
}
function openKeySheet() {
  $('#keyInput').value = ''; $('#keyMsg').textContent = 'Paste the setup link or key you were sent.'; $('#keyMsg').className = '';
  $('#backdrop').hidden = false; $('#keySheet').hidden = false; $('#backdrop').onclick = closeKeySheet;
}
function closeKeySheet() { $('#keySheet').hidden = true; $('#backdrop').hidden = true; $('#backdrop').onclick = null; }
$('#keyCancel').onclick = closeKeySheet;
$('#keyPaste').onclick = async () => {
  try { $('#keyInput').value = await navigator.clipboard.readText(); } catch { $('#keyInput').focus(); }
};
$('#keySave').onclick = async () => {
  const k = extractKey($('#keyInput').value);
  const msg = $('#keyMsg');
  if (!k) { msg.textContent = 'That doesn’t look like a setup key.'; msg.className = 'bad'; return; }
  msg.textContent = 'Checking…'; msg.className = '';
  const res = await checkKey(k);
  if (res === 'ok') { await db.put('meta', k, 'passphrase'); hasKey = true; closeKeySheet(); renderKeyRow(); toast('Fitting Room is set up on this phone.'); }
  else { msg.textContent = res === 'wrong' ? 'That key didn’t work. Check you copied all of it.' : 'Couldn’t check the key. Check your internet.'; msg.className = 'bad'; }
};
function renderKeyRow() { $('#keyState').textContent = hasKey ? 'Connected' : 'Not set up'; }
$('#keyRow').onclick = openKeySheet;
async function ai(path, body, signal) {
  const pass = await db.get('meta', 'passphrase');
  if (!pass) throw Object.assign(new Error('Add your setup key first.'), { code: 'locked' });
  let r;
  try {
    r = await fetch(AI + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Passphrase': pass }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw Object.assign(new Error('Couldn’t reach the AI. Check your internet and try again.'), { code: 'network' });
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.message || 'The AI had a problem. Try again.'), { code: d.code || 'http_' + r.status });
  return d;
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
    const done = v => { sh.hidden = true; bd.hidden = true; bd.onclick = null; res(v); };
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
  for (const [id, b] of [['#avFace', me.face], ['#avBody', me.body]]) { $(id).hidden = !b; if (b) $(id).src = url(b); }
}
// Use the best photo of you for this try-on, or the other one if only one is saved.
const pickOriginal = (preferred) => me[preferred] ? preferred : (preferred === 'face' ? 'body' : 'face');
function renderGrid() {
  const list = looks.filter(l => filter === 'all' || FILTER_OF[l.cat] === filter || (filter === 'hair' && l.items?.some(i => i.cat === 'hair')));
  const g = $('#grid'); g.textContent = '';
  for (const l of list) {
    const t = document.createElement('button');
    t.className = 'tile';
    t.setAttribute('role', 'listitem');
    t.setAttribute('aria-label', `${CATS[l.cat] || 'Look'}${l.isNew ? ', new' : ''}`);
    const img = new Image(); img.src = url(l.result); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
    const orig = new Image(); orig.className = 'orig'; orig.alt = ''; orig.loading = 'lazy'; orig.src = url(l.original === 'face' ? me.face : me.body);
    t.append(img, orig);
    const ck = document.createElement('span'); ck.className = 'check'; ck.innerHTML = '<svg><use href="#i-check"/></svg>'; t.append(ck);
    if (l.isNew) { const d = document.createElement('span'); d.className = 'dot'; t.append(d); }
    t.dataset.id = l.id;
    if (selected.has(l.id)) t.classList.add('sel');
    bindPeek(t, () => { if (!selecting) t.classList.add('peek'); }, () => t.classList.remove('peek'), () => (selecting ? toggleSel(l.id) : openViewer(l, img)));
    g.append(t);
  }
  $('#empty').hidden = looks.length > 0;
  $('#selectBtn').hidden = !looks.length;
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

let selecting = false;
const selected = new Set();
function setSelecting(on) {
  selecting = on; selected.clear();
  document.body.classList.toggle('selecting', on);
  $('#selectBtn').textContent = on ? 'Cancel' : 'Select';
  $('#tryOn').hidden = on; $('#selbar').hidden = !on;
  updateSel();
}
function toggleSel(id) { selected.has(id) ? selected.delete(id) : selected.add(id); updateSel(); }
function updateSel() {
  $$('.tile').forEach(t => t.classList.toggle('sel', selected.has(+t.dataset.id)));
  const n = selected.size;
  $('#selCount').textContent = n ? `${n} ${n === 1 ? 'Look' : 'Looks'} Selected` : 'Select Items';
  $('#selDelete').disabled = !n; $('#selShare').disabled = !n;
}
$('#selectBtn').onclick = () => setSelecting(!selecting);
{ // drag sideways across tiles to select a run of them, like Photos; vertical drags still scroll
  const g = $('#grid'); let start = null, active = false, mode = true, base = null, sx = 0, sy = 0;
  g.addEventListener('pointerdown', e => { if (!selecting) return; start = e.target.closest('.tile'); sx = e.clientX; sy = e.clientY; active = false; });
  g.addEventListener('pointermove', e => {
    if (!selecting || !start) return;
    if (!active) {
      const dx = Math.abs(e.clientX - sx), dy = Math.abs(e.clientY - sy);
      if (dx > 10 && dx > dy) { active = true; mode = !selected.has(+start.dataset.id); base = new Set(selected); }
      else if (dy > 10) { start = null; return; } else return;
    }
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('.tile'); if (!t) return;
    const tiles = $$('.tile', g), a = tiles.indexOf(start), b = tiles.indexOf(t);
    selected.clear(); base.forEach(id => selected.add(id));
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) { const id = +tiles[i].dataset.id; mode ? selected.add(id) : selected.delete(id); }
    updateSel();
  });
  const end = () => { start = null; active = false; };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
}
$('#selDelete').onclick = async () => {
  const n = selected.size; if (!n) return;
  if (!(await ask(n === 1 ? 'Delete this look?' : `Delete ${n} looks?`, 'This can’t be undone.', n === 1 ? 'Delete Look' : `Delete ${n} Looks`))) return;
  for (const id of selected) await db.del('looks', id);
  looks = looks.filter(l => !selected.has(l.id));
  setSelecting(false); renderGrid();
};
$('#selShare').onclick = async () => {
  const files = looks.filter(l => selected.has(l.id)).map((l, i) => new File([l.result], `fitting-room-${i + 1}.jpg`, { type: l.result.type || 'image/jpeg' }));
  if (navigator.canShare?.({ files })) { try { await navigator.share({ files }); } catch {} }
  else toast('Sharing isn’t available here.');
};

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
  const key = location.hash.match(/key=([\w-]{16,})/);
  if (key) {
    await db.put('meta', key[1], 'passphrase');
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => toast('Fitting Room is set up on this phone.'), 600);
  }
      fromImg.style.viewTransitionName = '';
      $('#vResult').style.viewTransitionName = 'look';
      $('#viewer').classList.add('vt');
      await showViewer(l);
    });
    vt.ready.catch(() => {}); vt.updateCallbackDone.catch(() => {});
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
  $('#vSub').textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + (l.model ? ' · ' + (l.model === 'flash' ? 'Flash' : 'Pro') : '');
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
  $('#vHint').style.opacity = 1; setTimeout(() => ($('#vHint').style.opacity = 0), 2200);
  $('#viewer').hidden = false;
  renderGrid();
}
{ // viewer: press and hold anywhere on the photo to see the original
  const st = $('#vStage');
  const on = () => { st.classList.add('peek'); $('#vBefore').hidden = false; $('#vHint').style.opacity = 0; };
  const off = () => { st.classList.remove('peek'); $('#vBefore').hidden = true; };
  // Swipe down to close, like Photos. A vertical drag cancels the before peek.
  let sy = null, dy = 0, drag = false;
  const img = $('#vResult'), v = $('#viewer');
  let peekT = null;
  st.addEventListener('pointerdown', e => { sy = e.clientY; dy = 0; drag = false; clearTimeout(peekT); peekT = setTimeout(on, 150); try { st.setPointerCapture(e.pointerId); } catch {} });
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
    vt.ready.catch(() => {}); vt.updateCallbackDone.catch(() => {});
    vt.finished.catch(() => {}).finally(() => (tileImg.style.viewTransitionName = ''));
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
// Try On opens the iPhone's own menu (Photo Library / Take Photo) straight away: one tap.
// The click must stay synchronous so iOS treats it as the user's tap.
$('#tryOn').onclick = () => {
  if (!navigator.onLine) return toast('Try On needs internet.');
  if (!hasKey) return openKeySheet();
  draft = []; $('#pickLibrary').click();
};
$('#pickLibrary').addEventListener('change', async e => {
  const files = [...e.target.files].slice(0, 3 - draft.length); e.target.value = '';
  if (!files.length) return;
  try {
    for (const f of files) { const it = { blob: await shrink(f), cat: null, labelling: true }; draft.push(it); autoLabel(it); }
    renderCompose(); $('#compose').hidden = false;
  } catch (err) { toast('Couldn’t open that photo. Try another one.'); console.error(err); }
});
async function autoLabel(it) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const small = await shrink(it.blob, 512);
    const { cat } = await ai('/label', { image: await img64(small) }, ctl.signal);
    if (!it.userSet && CATS[cat]) { it.cat = cat; it.detected = true; }
  } catch {}
  clearTimeout(t); it.labelling = false;
  if (!$('#compose').hidden) renderCompose();
}
function renderCompose() {
  const c = $('#cItems'); c.textContent = '';
  c.classList.toggle('single', draft.length === 1);
  draft.forEach((it, i) => {
    const row = document.createElement('div'); row.className = 'c-row';
    const im = new Image(); im.src = url(it.blob); im.alt = 'Item ' + (i + 1); im.className = 'c-thumb';
    const side = document.createElement('div'); side.className = 'c-side';
    const st = document.createElement('p'); st.className = 'c-status' + (it.labelling ? ' busy' : '');
    st.textContent = it.labelling ? 'Working out what this is…' : it.userSet ? 'What is it?' : it.detected ? 'Looks like ' + CATS[it.cat].toLowerCase() + '. Tap to change.' : 'What is it? Tap one.';
    const chips = document.createElement('div'); chips.className = 'chips'; chips.setAttribute('role', 'radiogroup'); chips.setAttribute('aria-label', 'What is it');
    for (const [k, v] of Object.entries(CATS)) {
      const b = document.createElement('button'); b.className = 'chip'; b.textContent = v;
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', !it.labelling && it.cat === k);
      b.onclick = () => { it.cat = k; it.userSet = true; it.labelling = false; renderCompose(); };
      chips.append(b);
    }
    const rm = document.createElement('button'); rm.className = 'rm'; rm.setAttribute('aria-label', 'Remove item');
    rm.innerHTML = '<svg><use href="#i-close"/></svg>';
    rm.onclick = () => { draft.splice(i, 1); draft.length ? renderCompose() : ($('#compose').hidden = true); };
    side.append(st, chips); row.append(im, side, rm); c.append(row);
  });
  $('#cAdd').hidden = draft.length >= 3;
  const busy = draft.some(it => it.labelling), missing = draft.some(it => !it.cat);
  $('#cGo').disabled = busy || missing;
  $('#cGo').textContent = busy ? 'Checking…' : 'Try On';
  const needsBody = draft.some(it => it.cat && it.cat !== 'hair') && !me.body;
  const needsFace = draft.length && draft.every(it => it.cat === 'hair') && !me.face;
  $('#cNote').textContent = needsBody ? 'Tip: add a full-body photo of you for clothes and shoes. Your face photo will be used for now.'
    : needsFace ? 'Tip: add a face photo for haircuts. Your full-body photo will be used for now.'
    : draft.length > 1 ? 'All items go on you in one picture.' : '';
}
$('#cCancel').onclick = () => { $('#compose').hidden = true; draft = []; };
$('#cAdd').onclick = () => $('#pickLibrary').click();
$('#cGo').onclick = async () => {
  if ((await spent()) >= CAP && !(await ask('You’ve reached US$' + CAP + ' this month', 'Each try-on still costs about US$' + COST[await model()].toFixed(2) + '.', 'Try On Anyway', false))) return;
  $('#compose').hidden = true; runTryOn(draft.map(({ blob, cat }) => ({ blob, cat })));
};

/* ---------- try-on (real, through the private helper) ---------- */
async function runTryOn(items, replace) {
  const onlyHair = items.every(i => i.cat === 'hair');
  const original = pickOriginal(onlyHair ? 'face' : 'body');
  $('#wImg').src = url(me[original]); $('#waiting').hidden = false;
  const t0 = Date.now(); const tick = setInterval(() => ($('#wTime').textContent = Math.floor((Date.now() - t0) / 1000) + ' s'), 250);
  $('#wTime').textContent = '0 s';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), 90000);
  cancelTry = () => ctl.abort('cancel');
  const m = await model();
  let res = null, err = null;
  try {
    res = await ai('/tryon', {
      model: m,
      person: await img64(me[original]),
      items: await Promise.all(items.map(async i => ({ cat: i.cat, image: await img64(i.blob) }))),
    }, ctl.signal);
  } catch (e) { err = e; }
  clearTimeout(timer); cancelTry = null; clearInterval(tick); $('#waiting').hidden = true;
  if (ctl.signal.aborted) return toast(ctl.signal.reason === 'cancel' ? 'Cancelled.' : 'That took too long. Try again.');
  if (err?.code === 'locked') { hasKey = false; renderKeyRow(); return openKeySheet(); }
  if (err) return toast(err.message, 4500);
  const result = await (await fetch(`data:${res.mime};base64,${res.image}`)).blob();
  await db.put('meta', (await spent()) + COST[m], 'spend-' + monthKey());
  const cat = onlyHair ? 'hair' : items.length > 1 ? 'outfit' : items[0].cat;
  const look = { cat, result, original, items, created: Date.now(), isNew: false, model: m, ms: res.ms };
  look.id = await db.put('looks', look);
  if (replace) toast('New version added to your looks.');
  looks.unshift(look); renderGrid(); openViewer(look);
}
$('#wCancel').onclick = () => cancelTry?.();

/* ---------- me & settings ---------- */
let pickSlot = null;
async function openMe() {
  $$('#me .me-slot').forEach(s => { const b = me[s.dataset.slot]; $('img', s).hidden = !b; if (b) $('img', s).src = url(b); $('small', s).textContent = b ? 'Change' : 'Add'; });
  const m = await model(); $$('#me input[name=model]').forEach(r => (r.checked = r.value === m));
  const s = await spent();
  $('#spent').textContent = 'US$' + s.toFixed(2);
  $('#meterFill').style.width = Math.min(100, (s / CAP) * 100) + '%';
  $('#meter').classList.toggle('over', s >= CAP);
  $('#version').textContent = 'Fitting Room ' + VERSION;
  $('#me').hidden = false;
}
$('#openMe').onclick = openMe;
$('#meDone').onclick = () => ($('#me').hidden = true);
$$('#me input[name=model]').forEach(r => r.onchange = () => db.put('meta', r.value, 'model'));
$$('.me-slot, .slot').forEach(b => b.onclick = () => { pickSlot = b.dataset.slot; $('#pickMe').click(); });
$('#pickMe').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { me[pickSlot] = await shrink(f); await db.put('me', me[pickSlot], pickSlot); }
  catch (err) { toast('Couldn’t save that photo. Try another one.'); console.error(err); return; }
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
  $('#setupDone').disabled = !(me.face || me.body);
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
addEventListener('unhandledrejection', e => e.reason?.name === 'AbortError' || toast('Something went wrong: ' + (e.reason?.message || e.reason || 'unknown')));
addEventListener('error', e => toast('Something went wrong: ' + (e.message || 'unknown')));
function onlineUI() { $('#offline').hidden = navigator.onLine; $('#tryOn').disabled = !navigator.onLine; }
addEventListener('online', onlineUI); addEventListener('offline', onlineUI);
(async () => {
  const key = location.hash.match(/key=([\w-]{16,})/);
  if (key) {
    await db.put('meta', key[1], 'passphrase');
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => toast('Fitting Room is set up on this phone.'), 600);
  }
  fetch('demo/demo.json', { method: 'HEAD' }).then(r => { if (!r.ok) throw 0; }).catch(() => { $('#setupDemo').hidden = true; $('#loadDemo').hidden = true; });
  await load();
  hasKey = !!(await db.get('meta', 'passphrase')); renderKeyRow();
  onlineUI();
  if (!me.face && !me.body) { renderSetup(); $('#setup').hidden = false; }
  renderAvatars(); renderGrid();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
})();
