import {
  SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET, MAX_PHOTOS, MAX_COMMAND_BYTES, ONLINE_MINUTES,
} from './config.js';
import { icon } from './icons.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const state = {
  session: null,
  productTypes: [],
  productMetrics: [],
  collapsed: readPref('sidebar-collapsed') === '1',
  cleanups: [],
};

const POLAND = [52.07, 19.48];

// ───────────────────────── Narzędzia ─────────────────────────

function readPref(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writePref(key, val) { try { localStorage.setItem(key, val); } catch { /* brak dostępu */ } }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function q(promise) {
  const { data, error, count } = await promise;
  if (error) throw error;
  return count ?? data;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

function fail(err) {
  console.error(err);
  toast(translateError(err), 'err');
}

function translateError(err) {
  const m = err?.message || String(err);
  if (/Invalid login credentials/i.test(m)) return 'Nieprawidłowy e-mail lub hasło.';
  if (/Email not confirmed/i.test(m)) return 'Konto nie zostało potwierdzone.';
  if (/maksymalnie 5 zdjęć/i.test(m)) return 'Inwestycja może mieć maksymalnie 5 zdjęć.';
  if (/Typu produktu nie można zmienić/i.test(m)) return m;
  if (/commands_payload_check/i.test(m)) return 'Dane dla ESP32 są za duże (maks. 8 kB).';
  if (/row-level security/i.test(m)) return 'Brak uprawnień do tej operacji.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Brak połączenia z serwerem. Sprawdź internet.';
  if (/JWT expired/i.test(m)) return 'Sesja wygasła, zaloguj się ponownie.';
  return m;
}

const fmtDate = (d) => (d ? new Date(d).toLocaleString('pl-PL', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

function ago(d) {
  if (!d) return 'nigdy';
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'przed chwilą';
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
  return `${Math.round(s / 86400)} dni temu`;
}

const isOnline = (lastSeen) => !!lastSeen && Date.now() - new Date(lastSeen).getTime() < ONLINE_MINUTES * 60000;

function fmtValue(metric, value) {
  if (value === undefined || value === null) return '—';
  if (metric && (metric.value_type === 'number' || metric.value_type === 'integer') && typeof value === 'number') {
    return value.toLocaleString('pl-PL', { maximumFractionDigits: 3 });
  }
  return String(value);
}

function parseCoord(v) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

const typeOf = (code) => state.productTypes.find((t) => t.code === code) || { name: code, connected: false };
const metricsOf = (code) => state.productMetrics.filter((m) => m.product_type === code);

function addCleanup(fn) { state.cleanups.push(fn); }
function runCleanups() { state.cleanups.splice(0).forEach((fn) => { try { fn(); } catch { /* ignoruj */ } }); }

// Prosty dialog z formularzem. Zwraca obiekt z polami formularza albo null.
function dialog({ title, body = '', ok = 'Zapisz', danger = false }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `
      <form class="modal glass fade-in" novalidate>
        <h3>${esc(title)}</h3>
        ${body}
        <div class="actions">
          <button type="button" class="btn ghost" data-cancel>Anuluj</button>
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button>
        </div>
      </form>`;
    const form = bg.querySelector('form');
    const close = (val) => { bg.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('click', (e) => { if (e.target === bg) close(null); });
    bg.querySelector('[data-cancel]').onclick = () => close(null);
    form.onsubmit = (e) => {
      e.preventDefault();
      if (!form.reportValidity()) return;
      close(Object.fromEntries(new FormData(form)));
    };
    document.body.append(bg);
    (form.querySelector('input, select, textarea') || form.querySelector('[type=submit]')).focus();
  });
}

const confirmDialog = (title, text, ok = 'Usuń') =>
  dialog({ title, body: `<p style="color:var(--muted);margin:0">${esc(text)}</p>`, ok, danger: true });

function makeMap(el, opts = {}) {
  const map = L.map(el, { scrollWheelZoom: opts.scroll ?? true, zoomControl: true }).setView(POLAND, 6);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  addCleanup(() => map.remove());
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

const pinIcon = () => L.divIcon({ className: '', html: '<div class="pin-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 22], popupAnchor: [0, -22] });

// ───────────────────────── Start i logowanie ─────────────────────────

async function boot() {
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  sb.auth.onAuthStateChange((event, session) => {
    const was = !!state.session;
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') { setNewPassword(); return; }
    if (was !== !!session) route();
  });
  window.addEventListener('hashchange', route);
  route();
}

function renderLogin() {
  runCleanups();
  document.title = 'Logowanie · Portal ESP32';
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card glass fade-in">
        <form class="login-form" id="login" novalidate>
          <div class="brand-mark"><span class="logo">${icon('road', 20)}</span> Portal ESP32</div>
          <h1>Logowanie</h1>
          <p class="sub">Zaloguj się, aby zarządzać inwestycjami i sterownikami.</p>
          <label class="field">${icon('mail')}
            <input type="email" name="email" placeholder="Adres e-mail" autocomplete="username" required>
          </label>
          <label class="field">${icon('lock')}
            <input type="password" name="password" placeholder="Hasło" autocomplete="current-password" required>
            <button type="button" class="eye" aria-label="Pokaż hasło">${icon('eye')}</button>
          </label>
          <div class="form-error" id="login-error"></div>
          <button class="btn block" type="submit">Zaloguj</button>
          <p style="text-align:center;margin:18px 0 0;font-size:13px">
            <a href="#" id="forgot" style="color:var(--muted)">Nie pamiętasz hasła?</a>
          </p>
        </form>
        <div class="login-hello">
          <h2>Witaj<br>ponownie!</h2>
          <p>Monitoruj sterowniki na inwestycjach drogowych, sprawdzaj odczyty i wysyłaj ustawienia do urządzeń.</p>
          <div class="hello-chips">
            <span class="chip">${icon('chip', 14)} Sterowniki ESP32</span>
            <span class="chip">${icon('chart', 14)} Odczyty</span>
            <span class="chip">${icon('pin', 14)} Mapa inwestycji</span>
          </div>
        </div>
      </div>
    </div>`;

  const form = app.querySelector('#login');
  const err = app.querySelector('#login-error');
  const pass = form.password;
  form.querySelector('.eye').onclick = (e) => {
    const show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    e.currentTarget.innerHTML = icon(show ? 'eyeOff' : 'eye');
    e.currentTarget.setAttribute('aria-label', show ? 'Ukryj hasło' : 'Pokaż hasło');
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    err.textContent = '';
    if (!form.email.value || !pass.value) { err.textContent = 'Podaj e-mail i hasło.'; return; }
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Logowanie…';
    const { error } = await sb.auth.signInWithPassword({ email: form.email.value.trim(), password: pass.value });
    btn.disabled = false; btn.textContent = 'Zaloguj';
    if (error) err.textContent = translateError(error);
    else if (!location.hash || location.hash === '#/login') location.hash = '#/';
  };
  app.querySelector('#forgot').onclick = async (e) => {
    e.preventDefault();
    const email = form.email.value.trim();
    if (!email) { err.textContent = 'Wpisz najpierw swój e-mail.'; form.email.focus(); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) err.textContent = translateError(error);
    else toast('Wysłaliśmy link do zmiany hasła na podany e-mail.', 'ok');
  };
}

async function setNewPassword() {
  const res = await dialog({
    title: 'Ustaw nowe hasło',
    body: `<label class="lbl">Nowe hasło (min. 8 znaków)<input class="inp" type="password" name="password" minlength="8" required autocomplete="new-password"></label>`,
  });
  if (!res) return;
  const { error } = await sb.auth.updateUser({ password: res.password });
  if (error) fail(error); else toast('Hasło zostało zmienione.', 'ok');
}

// ───────────────────────── Routing i układ ─────────────────────────

async function loadDictionaries() {
  if (state.productTypes.length) return;
  const [types, metrics] = await Promise.all([
    q(sb.from('product_types').select('*').order('sort_order')),
    q(sb.from('product_metrics').select('*').order('sort_order')),
  ]);
  state.productTypes = types;
  state.productMetrics = metrics;
}

async function route() {
  if (!state.session) { renderLogin(); return; }
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').map(decodeURIComponent);
  const [page = '', id, tab = 'urzadzenia'] = parts;
  if (page === 'login') { location.hash = '#/'; return; }

  try { await loadDictionaries(); } catch (e) { fail(e); }
  ensureShell();
  runCleanups();
  setActive(page === 'inwestycja' ? 'inwestycje' : page || 'pulpit');
  const content = app.querySelector('#content');
  content.innerHTML = '<div class="panel glass" style="color:var(--muted)">Ładowanie…</div>';
  app.querySelector('.shell').classList.remove('mobile-open');

  try {
    if (page === 'inwestycje') await pageInvestments(content);
    else if (page === 'mapa') await pageMap(content);
    else if (page === 'inwestycja' && id) await pageInvestment(content, id, tab);
    else await pageDashboard(content);
  } catch (e) {
    fail(e);
    content.innerHTML = `<div class="panel glass"><h2>Coś poszło nie tak</h2><p class="hint">${esc(translateError(e))}</p><a class="btn" href="#/">Wróć do pulpitu</a></div>`;
  }
}

function ensureShell() {
  if (app.querySelector('.shell')) return;
  const email = state.session.user.email || '';
  app.innerHTML = `
    <div class="shell ${state.collapsed ? 'collapsed' : ''}">
      <aside class="sidebar glass">
        <div class="dots hide-collapsed"><i></i><i></i><i></i></div>
        <div class="sb-head">
          <div class="sb-title"><span class="logo">${icon('road', 18)}</span><span class="hide-collapsed">Portal ESP32</span></div>
          <button class="sb-toggle" type="button" aria-label="Zwiń menu" title="Zwiń / rozwiń menu">${icon('chevronLeft', 16)}</button>
        </div>
        <div class="sb-user">
          <div class="avatar">${esc(email.slice(0, 1).toUpperCase())}</div>
          <div class="who hide-collapsed"><b title="${esc(email)}">${esc(email)}</b><span>Zalogowano</span></div>
        </div>
        <form class="sb-search hide-collapsed" id="sb-search" role="search">
          ${icon('search', 15)}<input name="q" placeholder="Szukaj inwestycji…" aria-label="Szukaj inwestycji">
        </form>
        <div class="sb-section">Menu</div>
        <nav class="sb-nav">
          <a class="sb-link" data-nav="pulpit" href="#/" title="Pulpit"><span class="bubble">${icon('home', 16)}</span><span class="hide-collapsed">Pulpit</span></a>
          <a class="sb-link" data-nav="inwestycje" href="#/inwestycje" title="Inwestycje"><span class="bubble">${icon('road', 16)}</span><span class="hide-collapsed">Inwestycje</span><span class="badge hide-collapsed" id="offline-badge" hidden title="Urządzenia offline"></span></a>
          <a class="sb-link" data-nav="mapa" href="#/mapa" title="Mapa"><span class="bubble">${icon('map', 16)}</span><span class="hide-collapsed">Mapa</span></a>
        </nav>
        <div class="sb-sep"></div>
        <div class="sb-foot">
          <div class="sb-section">Ogólne</div>
          <nav class="sb-nav">
            <button class="sb-link" id="logout" type="button" title="Wyloguj"><span class="bubble">${icon('logout', 16)}</span><span class="hide-collapsed">Wyloguj</span></button>
          </nav>
        </div>
      </aside>
      <main class="main">
        <div id="content"></div>
      </main>
    </div>`;

  const shell = app.querySelector('.shell');
  app.querySelector('.sb-toggle').onclick = () => {
    state.collapsed = !state.collapsed;
    shell.classList.toggle('collapsed', state.collapsed);
    writePref('sidebar-collapsed', state.collapsed ? '1' : '0');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 320);
  };
  app.querySelector('#logout').onclick = async () => { await sb.auth.signOut(); location.hash = '#/login'; };
  app.querySelector('#sb-search').onsubmit = (e) => {
    e.preventDefault();
    const v = e.currentTarget.q.value.trim();
    location.hash = `#/inwestycje${v ? `?q=${encodeURIComponent(v)}` : ''}`;
  };
  refreshOfflineBadge();
}

async function refreshOfflineBadge() {
  try {
    const devices = await q(sb.from('devices').select('last_seen, product_type'));
    const offline = devices.filter((d) => typeOf(d.product_type).connected && !isOnline(d.last_seen)).length;
    const b = app.querySelector('#offline-badge');
    if (b) { b.textContent = offline; b.hidden = offline === 0; }
  } catch { /* nieistotne */ }
}

function setActive(name) {
  app.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name.split('?')[0]));
}

function topbar(title, crumbs = '', actions = '') {
  return `
    <div class="topbar glass">
      <button class="btn icon ghost mobile-menu" type="button" data-mobile aria-label="Menu">${icon('road')}</button>
      <div style="min-width:0">
        ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
        <h1>${title}</h1>
      </div>
      <div class="spacer"></div>
      ${actions}
    </div>`;
}

function bindTopbar(root) {
  const m = root.querySelector('[data-mobile]');
  if (m) m.onclick = () => app.querySelector('.shell').classList.toggle('mobile-open');
}

// ───────────────────────── Pulpit ─────────────────────────

async function pageDashboard(root) {
  document.title = 'Pulpit · Portal ESP32';
  const since = new Date(Date.now() - 86400000).toISOString();
  const [investments, devices, readings24, latest] = await Promise.all([
    q(sb.from('investments').select('id, name, latitude, longitude').order('created_at', { ascending: false })),
    q(sb.from('devices').select('id, name, product_type, last_seen, investment_id')),
    q(sb.from('readings').select('id', { count: 'exact', head: true }).gte('created_at', since)),
    q(sb.from('readings').select('created_at, data, device_id').order('created_at', { ascending: false }).limit(8)),
  ]);
  const connected = devices.filter((d) => typeOf(d.product_type).connected);
  const online = connected.filter((d) => isOnline(d.last_seen));
  const invById = Object.fromEntries(investments.map((i) => [i.id, i]));
  const devById = Object.fromEntries(devices.map((d) => [d.id, d]));
  const offline = connected.filter((d) => !isOnline(d.last_seen));

  root.innerHTML = `
    ${topbar('Pulpit', 'Przegląd wszystkich inwestycji', `<a class="btn primary" href="#/inwestycje?nowa=1">${icon('plus', 16)} Nowa inwestycja</a>`)}
    <section class="stats fade-in">
      <div class="stat glass"><div class="label">${icon('road', 16)} Inwestycje</div><div class="value">${investments.length}</div></div>
      <div class="stat glass"><div class="label">${icon('chip', 16)} Urządzenia</div><div class="value">${devices.length}</div></div>
      <div class="stat glass"><div class="label">${icon('wifi', 16)} Online</div><div class="value">${online.length}<span style="font-size:16px;color:var(--muted)"> / ${connected.length}</span></div></div>
      <div class="stat glass"><div class="label">${icon('chart', 16)} Odczyty (24 h)</div><div class="value">${readings24}</div></div>
    </section>
    <section class="grid-2">
      <div class="panel glass">
        <h2>Mapa inwestycji</h2>
        <p class="hint">Kliknij pinezkę, aby otworzyć inwestycję.</p>
        <div class="map small" id="dash-map"></div>
      </div>
      <div class="panel glass">
        <h2>Ostatnie odczyty</h2>
        <p class="hint">Najnowsze dane przesłane przez sterowniki.</p>
        <div class="list">
          ${latest.length ? latest.map((r) => {
            const d = devById[r.device_id] || {};
            const inv = invById[d.investment_id] || {};
            const ms = metricsOf(d.product_type);
            const vals = Object.entries(r.data || {}).map(([k, v]) => {
              const m = ms.find((x) => x.key === k);
              return `${esc(m?.label || k)}: <b>${esc(fmtValue(m, v))}${m?.unit ? ` ${esc(m.unit)}` : ''}</b>`;
            }).join(' · ');
            return `<a class="row" href="#/inwestycja/${inv.id}/odczyty" style="text-decoration:none;color:inherit">
              <div class="grow"><div class="title">${esc(inv.name || '—')} · ${esc(d.name || typeOf(d.product_type).name)}</div>
              <div class="sub">${vals}</div></div>
              <span class="sub">${esc(ago(r.created_at))}</span></a>`;
          }).join('') : '<div class="empty">Brak odczytów. Pojawią się, gdy sterownik wyśle pierwsze dane.</div>'}
        </div>
        ${offline.length ? `<h2 style="margin-top:20px">Urządzenia offline</h2><p class="hint">Brak kontaktu dłużej niż ${ONLINE_MINUTES} min.</p>
          <div class="list">${offline.slice(0, 6).map((d) => `
            <a class="row" href="#/inwestycja/${d.investment_id}" style="text-decoration:none;color:inherit">
              <div class="grow"><div class="title">${esc(d.name || typeOf(d.product_type).name)}</div>
              <div class="sub">${esc(invById[d.investment_id]?.name || '')}</div></div>
              <span class="status off">${esc(ago(d.last_seen))}</span></a>`).join('')}</div>` : ''}
      </div>
    </section>`;
  bindTopbar(root);
  drawInvestmentPins(makeMap(root.querySelector('#dash-map'), { scroll: false }), investments);
}

function drawInvestmentPins(map, investments) {
  const pts = [];
  investments.filter((i) => i.latitude != null).forEach((i) => {
    pts.push([i.latitude, i.longitude]);
    L.marker([i.latitude, i.longitude], { icon: pinIcon() }).addTo(map)
      .bindPopup(`<b>${esc(i.name)}</b><br><a href="#/inwestycja/${i.id}">Otwórz inwestycję →</a>`);
  });
  if (pts.length === 1) map.setView(pts[0], 11);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
}

// ───────────────────────── Mapa ─────────────────────────

async function pageMap(root) {
  document.title = 'Mapa · Portal ESP32';
  const investments = await q(sb.from('investments').select('id, name, latitude, longitude'));
  const without = investments.filter((i) => i.latitude == null);
  root.innerHTML = `
    ${topbar('Mapa inwestycji', `${investments.length - without.length} z ${investments.length} inwestycji ma lokalizację`)}
    <div class="panel glass fade-in">
      <div class="map tall" id="big-map"></div>
      ${without.length ? `<p class="hint" style="margin:14px 0 0">Bez lokalizacji: ${without.map((i) => `<a href="#/inwestycja/${i.id}/lokalizacja">${esc(i.name)}</a>`).join(', ')}</p>` : ''}
    </div>`;
  bindTopbar(root);
  drawInvestmentPins(makeMap(root.querySelector('#big-map')), investments);
}

// ───────────────────────── Lista inwestycji ─────────────────────────

async function pageInvestments(root) {
  document.title = 'Inwestycje · Portal ESP32';
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filter = (params.get('q') || '').toLowerCase();
  const [investments, devices] = await Promise.all([
    q(sb.from('investments').select('id, name, notes, latitude, longitude, created_at').order('created_at', { ascending: false })),
    q(sb.from('devices').select('investment_id, product_type, last_seen')),
  ]);
  const shown = investments.filter((i) => !filter || i.name.toLowerCase().includes(filter) || (i.notes || '').toLowerCase().includes(filter));

  root.innerHTML = `
    ${topbar('Inwestycje', filter ? `Wyniki dla „${esc(filter)}” · <a href="#/inwestycje">wyczyść</a>` : `${investments.length} inwestycji`,
      `<button class="btn primary" type="button" data-new>${icon('plus', 16)} Nowa inwestycja</button>`)}
    <section class="inv-grid fade-in">
      ${shown.map((i) => {
        const ds = devices.filter((d) => d.investment_id === i.id);
        const conn = ds.filter((d) => typeOf(d.product_type).connected);
        const on = conn.filter((d) => isOnline(d.last_seen)).length;
        return `<a class="inv-card glass" href="#/inwestycja/${i.id}">
          <div style="display:flex;align-items:center;gap:10px"><span class="dev-icon" style="width:38px;height:38px">${icon('road', 18)}</span><h3>${esc(i.name)}</h3></div>
          ${i.notes ? `<div class="sub" style="color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.notes)}</div>` : ''}
          <div class="meta">
            <span>${icon('chip', 14)} ${ds.length} urządz.</span>
            ${conn.length ? `<span>${icon('wifi', 14)} ${on}/${conn.length} online</span>` : ''}
            <span>${icon('pin', 14)} ${i.latitude != null ? 'na mapie' : 'brak lokalizacji'}</span>
          </div></a>`;
      }).join('')}
      <button class="inv-card glass new" type="button" data-new>${icon('plus', 26)}<span>Dodaj inwestycję</span></button>
    </section>
    ${!shown.length && filter ? '<div class="empty">Nic nie znaleziono.</div>' : ''}`;
  bindTopbar(root);
  root.querySelectorAll('[data-new]').forEach((b) => { b.onclick = newInvestment; });
  if (params.get('nowa')) newInvestment();
}

async function newInvestment() {
  const res = await dialog({
    title: 'Nowa inwestycja',
    ok: 'Utwórz',
    body: `
      <div class="list">
        <label class="lbl">Nazwa inwestycji<input class="inp" name="name" maxlength="200" required placeholder="np. Stare Juchy"></label>
        <label class="lbl">Opis (opcjonalnie)<input class="inp" name="notes" placeholder="np. przejście dla pieszych, ul. Ełcka"></label>
      </div>`,
  });
  if (!res) { if (location.hash.includes('nowa=1')) location.hash = '#/inwestycje'; return; }
  try {
    const row = await q(sb.from('investments').insert({ name: res.name.trim(), notes: res.notes.trim() || null }).select('id').single());
    toast('Inwestycja utworzona. Dodaj teraz urządzenia.', 'ok');
    location.hash = `#/inwestycja/${row.id}/urzadzenia`;
  } catch (e) { fail(e); }
}

// ───────────────────────── Inwestycja ─────────────────────────

const TABS = [
  ['urzadzenia', 'Urządzenia', 'chip'],
  ['odczyty', 'Odczyty', 'chart'],
  ['galeria', 'Galeria', 'image'],
  ['lokalizacja', 'Lokalizacja', 'pin'],
];

async function pageInvestment(root, id, tab) {
  const inv = await q(sb.from('investments').select('*').eq('id', id).maybeSingle());
  if (!inv) { root.innerHTML = `<div class="panel glass"><h2>Nie znaleziono inwestycji</h2><a class="btn" href="#/inwestycje">Wróć do listy</a></div>`; return; }
  document.title = `${inv.name} · Portal ESP32`;
  if (!TABS.some(([k]) => k === tab)) tab = 'urzadzenia';

  root.innerHTML = `
    ${topbar(esc(inv.name), `<a href="#/inwestycje" style="color:var(--muted);text-decoration:none">${icon('arrowLeft', 12).replace('class="ic"', 'class="ic" style="display:inline;vertical-align:-1px"')} Inwestycje</a>${inv.notes ? ` · ${esc(inv.notes)}` : ''}`,
      `<button class="btn sm" type="button" data-edit>${icon('edit', 15)} Edytuj</button>
       <button class="btn sm danger" type="button" data-del>${icon('trash', 15)}</button>`)}
    <nav class="tabs glass" style="border-radius:999px">
      ${TABS.map(([k, label, ic]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/inwestycja/${id}/${k}">${icon(ic, 16)} ${label}</a>`).join('')}
    </nav>
    <div id="tab" class="fade-in"></div>`;
  bindTopbar(root);
  root.querySelector('[data-edit]').onclick = () => editInvestment(inv);
  root.querySelector('[data-del]').onclick = () => deleteInvestment(inv);

  const el = root.querySelector('#tab');
  if (tab === 'odczyty') await tabReadings(el, inv);
  else if (tab === 'galeria') await tabGallery(el, inv);
  else if (tab === 'lokalizacja') await tabLocation(el, inv);
  else await tabDevices(el, inv);
}

async function editInvestment(inv) {
  const res = await dialog({
    title: 'Edytuj inwestycję',
    body: `<div class="list">
      <label class="lbl">Nazwa<input class="inp" name="name" maxlength="200" required value="${esc(inv.name)}"></label>
      <label class="lbl">Opis<input class="inp" name="notes" value="${esc(inv.notes || '')}"></label></div>`,
  });
  if (!res) return;
  try {
    await q(sb.from('investments').update({ name: res.name.trim(), notes: res.notes.trim() || null }).eq('id', inv.id));
    toast('Zapisano.', 'ok'); route();
  } catch (e) { fail(e); }
}

async function deleteInvestment(inv) {
  if (!await confirmDialog('Usunąć inwestycję?', `„${inv.name}” zostanie usunięta razem z urządzeniami, odczytami i zdjęciami. Tego nie można cofnąć.`)) return;
  try {
    const photos = await q(sb.from('investment_photos').select('storage_path').eq('investment_id', inv.id));
    if (photos.length) await sb.storage.from(PHOTO_BUCKET).remove(photos.map((p) => p.storage_path));
    await q(sb.from('investments').delete().eq('id', inv.id));
    toast('Inwestycja usunięta.', 'ok');
    location.hash = '#/inwestycje';
  } catch (e) { fail(e); }
}

// ── Zakładka: urządzenia ──

async function tabDevices(el, inv) {
  const devices = await q(sb.from('devices').select('*').eq('investment_id', inv.id).order('created_at'));
  const ids = devices.map((d) => d.id);
  const [dms, readings, commands] = ids.length ? await Promise.all([
    q(sb.from('device_metrics').select('device_id, metric_key, enabled').in('device_id', ids)),
    q(sb.from('readings').select('device_id, created_at, data').in('device_id', ids).order('created_at', { ascending: false }).limit(300)),
    q(sb.from('commands').select('*').in('device_id', ids).order('created_at', { ascending: false }).limit(60)),
  ]) : [[], [], []];

  el.innerHTML = `
    <div class="panel glass" style="margin-bottom:16px">
      <h2>Dodaj produkt</h2>
      <p class="hint">Sterowniki łączące się ze stroną dostaną automatycznie klucz PL-…, który wpisujesz do programu ESP32.</p>
      <form class="form-grid" id="add-dev">
        <label class="lbl">Typ produktu
          <select class="inp" name="product_type" required>
            ${state.productTypes.map((t) => `<option value="${esc(t.code)}">${esc(t.name)}${t.connected ? '' : ' (informacyjnie)'}</option>`).join('')}
          </select></label>
        <label class="lbl">Nazwa / opis miejsca (opcjonalnie)<input class="inp" name="name" maxlength="200" placeholder="np. Przejście przy szkole"></label>
        <button class="btn primary" type="submit">${icon('plus', 16)} Dodaj</button>
      </form>
    </div>
    <div class="list" id="dev-list">
      ${devices.length ? devices.map((d) => deviceCard(d, dms, readings, commands)).join('') : '<div class="empty glass">Ta inwestycja nie ma jeszcze urządzeń.</div>'}
    </div>`;

  el.querySelector('#add-dev').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const row = await q(sb.from('devices').insert({ investment_id: inv.id, product_type: f.product_type.value, name: f.name.value.trim() || null }).select('device_key').single());
      toast(row.device_key ? `Dodano. Klucz urządzenia: ${row.device_key}` : 'Dodano urządzenie informacyjne.', 'ok');
      refreshOfflineBadge();
      tabDevices(el, inv);
    } catch (err) { fail(err); }
  };
  bindDeviceCards(el, inv, devices);

  // Odświeżanie statusów co 30 s, póki zakładka jest otwarta.
  const timer = setInterval(async () => {
    if (!document.body.contains(el) || el.querySelector('details.cmd[open] textarea:focus')) return;
    try {
      const fresh = await q(sb.from('devices').select('id, last_seen').eq('investment_id', inv.id));
      fresh.forEach((d) => {
        const s = el.querySelector(`[data-status="${d.id}"]`);
        if (s) setStatus(s, d.last_seen);
      });
    } catch { /* spróbujemy za chwilę */ }
  }, 30000);
  addCleanup(() => clearInterval(timer));
}

function setStatus(node, lastSeen) {
  const on = isOnline(lastSeen);
  node.className = `status ${on ? 'on' : 'off'}`;
  node.textContent = on ? 'Online' : `Offline · ${ago(lastSeen)}`;
  node.title = `Ostatni kontakt: ${fmtDate(lastSeen)}`;
}

function deviceCard(d, dms, readings, commands) {
  const t = typeOf(d.product_type);
  const title = esc(d.name || t.name);
  if (!t.connected) {
    return `<article class="dev glass" data-dev="${d.id}">
      <div class="dev-head">
        <div class="dev-icon info">${icon('info', 20)}</div>
        <div class="grow"><h3>${title}</h3><div class="type">${esc(t.name)} · urządzenie informacyjne, nie łączy się ze stroną</div></div>
        <button class="btn icon ghost" data-rename title="Zmień nazwę">${icon('edit', 16)}</button>
        <button class="btn icon ghost" data-remove title="Usuń">${icon('trash', 16)}</button>
      </div></article>`;
  }
  const ms = metricsOf(d.product_type);
  const enabled = Object.fromEntries(dms.filter((x) => x.device_id === d.id).map((x) => [x.metric_key, x.enabled]));
  const last = readings.find((r) => r.device_id === d.id);
  const lastVal = {};
  ms.forEach((m) => { const r = readings.find((x) => x.device_id === d.id && x.data && m.key in x.data); if (r) lastVal[m.key] = r.data[m.key]; });
  const cmds = commands.filter((c) => c.device_id === d.id).slice(0, 6);
  const on = isOnline(d.last_seen);
  const enumMs = ms.filter((m) => m.value_type === 'enum');

  return `<article class="dev glass" data-dev="${d.id}">
    <div class="dev-head">
      <div class="dev-icon">${icon('chip', 20)}</div>
      <div class="grow"><h3>${title}</h3><div class="type">${esc(t.name)}</div></div>
      <span class="status ${on ? 'on' : 'off'}" data-status="${d.id}" title="Ostatni kontakt: ${esc(fmtDate(d.last_seen))}">${on ? 'Online' : `Offline · ${esc(ago(d.last_seen))}`}</span>
      <span class="key" title="Klucz do wpisania w programie ESP32">${esc(d.device_key)}<button type="button" data-copy="${esc(d.device_key)}" aria-label="Kopiuj klucz">${icon('copy', 15)}</button></span>
      <button class="btn icon ghost" data-rename title="Zmień nazwę">${icon('edit', 16)}</button>
      <button class="btn icon ghost" data-remove title="Usuń">${icon('trash', 16)}</button>
    </div>
    ${ms.length ? `<div class="metrics">
      ${ms.map((m) => `<div class="metric ${enabled[m.key] === false ? 'off' : ''}">
        <div class="m-label"><span>${esc(m.label)}</span>
          <label class="switch" title="Czy te dane mają przychodzić na stronę"><input type="checkbox" data-metric="${esc(m.key)}" ${enabled[m.key] !== false ? 'checked' : ''}><span></span></label></div>
        <div class="m-value">${esc(fmtValue(m, lastVal[m.key]))}${m.unit && lastVal[m.key] !== undefined ? `<small>${esc(m.unit)}</small>` : ''}</div>
      </div>`).join('')}
    </div>` : '<div class="hint" style="color:var(--muted);font-size:13px">Ten typ nie ma jeszcze zdefiniowanych danych.</div>'}
    <details class="cmd">
      <summary>${icon('send', 16)} Wyślij dane do urządzenia</summary>
      <form data-cmd>
        ${enumMs.length ? `<div class="form-grid" style="margin-bottom:10px">${enumMs.map((m) => `
          <label class="lbl">${esc(m.label)} (szablon)
            <select class="inp" data-template="${esc(m.key)}"><option value="">— wybierz —</option>${(m.allowed_values || []).map((v) => `<option>${esc(v)}</option>`).join('')}</select></label>`).join('')}</div>` : ''}
        <label class="lbl">Dane w formacie JSON
          <textarea class="inp" name="payload" spellcheck="false" placeholder='{"led": true}'></textarea></label>
        <div style="display:flex;align-items:center;gap:10px;margin-top:10px">
          <span class="counter" data-counter>0 / ${MAX_COMMAND_BYTES} B</span><span class="spacer" style="flex:1"></span>
          <button class="btn primary sm" type="submit">${icon('send', 15)} Wyślij</button>
        </div>
      </form>
      <div class="cmd-hist">
        ${cmds.length ? cmds.map((c) => `<div class="row"><span class="pill ${c.status}">${{ new: 'oczekuje', received: 'odebrane', done: 'wykonane', failed: 'błąd' }[c.status]}</span>
          <div class="grow"><code>${esc(JSON.stringify(c.payload))}</code>${c.result ? `<div class="sub">${esc(c.result)}</div>` : ''}</div>
          <span class="sub">${esc(fmtDate(c.created_at))}</span></div>`).join('') : '<div class="sub" style="color:var(--dim)">Jeszcze nic nie wysłano.</div>'}
      </div>
    </details>
    <div class="dev-foot"><span>Ostatni odczyt: ${last ? esc(fmtDate(last.created_at)) : 'brak'}</span><span class="spacer"></span><span>Dodano: ${esc(fmtDate(d.created_at))}</span></div>
  </article>`;
}

function bindDeviceCards(el, inv, devices) {
  el.querySelectorAll('[data-dev]').forEach((card) => {
    const d = devices.find((x) => x.id === card.dataset.dev);
    card.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
      try { await navigator.clipboard.writeText(e.currentTarget.dataset.copy); toast('Skopiowano klucz.', 'ok'); } catch { toast('Nie udało się skopiować.', 'err'); }
    });
    card.querySelector('[data-rename]').onclick = async () => {
      const res = await dialog({ title: 'Nazwa urządzenia', body: `<label class="lbl">Nazwa / opis miejsca<input class="inp" name="name" maxlength="200" value="${esc(d.name || '')}"></label>` });
      if (!res) return;
      try { await q(sb.from('devices').update({ name: res.name.trim() || null }).eq('id', d.id)); tabDevices(el, inv); } catch (e) { fail(e); }
    };
    card.querySelector('[data-remove]').onclick = async () => {
      if (!await confirmDialog('Usunąć urządzenie?', `${d.name || typeOf(d.product_type).name} zostanie usunięte razem z odczytami. Klucz ${d.device_key || ''} przestanie działać.`)) return;
      try { await q(sb.from('devices').delete().eq('id', d.id)); toast('Usunięto.', 'ok'); refreshOfflineBadge(); tabDevices(el, inv); } catch (e) { fail(e); }
    };
    card.querySelectorAll('[data-metric]').forEach((cb) => {
      cb.onchange = async () => {
        try {
          await q(sb.from('device_metrics').update({ enabled: cb.checked }).eq('device_id', d.id).eq('metric_key', cb.dataset.metric));
          cb.closest('.metric').classList.toggle('off', !cb.checked);
          toast(cb.checked ? 'Dane włączone.' : 'Dane wyłączone. Urządzenie przestanie je wysyłać.', 'ok');
        } catch (e) { cb.checked = !cb.checked; fail(e); }
      };
    });
    const form = card.querySelector('[data-cmd]');
    if (!form) return;
    const ta = form.payload;
    const counter = form.querySelector('[data-counter]');
    const update = () => {
      const n = new TextEncoder().encode(ta.value).length;
      counter.textContent = `${n} / ${MAX_COMMAND_BYTES} B`;
      counter.classList.toggle('bad', n > MAX_COMMAND_BYTES);
    };
    ta.oninput = update;
    form.querySelectorAll('[data-template]').forEach((s) => {
      s.onchange = () => { if (s.value) { ta.value = JSON.stringify({ [s.dataset.template]: s.value }, null, 2); update(); } };
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      let payload;
      try { payload = JSON.parse(ta.value); } catch { toast('To nie jest poprawny JSON, np. {"led": true}.', 'err'); return; }
      if (new TextEncoder().encode(JSON.stringify(payload)).length > MAX_COMMAND_BYTES) { toast('Dane są za duże (maks. 8 kB).', 'err'); return; }
      try {
        await q(sb.from('commands').insert({ device_id: d.id, payload }));
        toast('Wysłano. Urządzenie odbierze dane przy najbliższym połączeniu.', 'ok');
        tabDevices(el, inv);
      } catch (err) { fail(err); }
    };
  });
}

// ── Zakładka: odczyty ──

const RANGES = [['24h', 'Ostatnie 24 h', 1], ['7d', 'Ostatnie 7 dni', 7], ['30d', 'Ostatnie 30 dni', 30], ['all', 'Wszystkie (maks. 1000)', null]];

async function tabReadings(el, inv) {
  const devices = (await q(sb.from('devices').select('id, name, product_type').eq('investment_id', inv.id).order('created_at')))
    .filter((d) => typeOf(d.product_type).connected);
  if (!devices.length) { el.innerHTML = '<div class="empty glass">Brak urządzeń wysyłających dane. Dodaj sterownik w zakładce Urządzenia.</div>'; return; }

  el.innerHTML = `
    <div class="panel glass">
      <div class="toolbar">
        <label class="lbl">Urządzenie<select class="inp" id="r-dev">${devices.map((d) => `<option value="${d.id}">${esc(d.name || typeOf(d.product_type).name)} · ${esc(typeOf(d.product_type).name)}</option>`).join('')}</select></label>
        <label class="lbl">Zakres<select class="inp" id="r-range">${RANGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
        <span style="flex:1"></span>
        <button class="btn sm" type="button" id="r-refresh">${icon('refresh', 15)} Odśwież</button>
        <button class="btn sm" type="button" id="r-csv">Pobierz CSV</button>
      </div>
      <div id="r-body"></div>
    </div>`;
  const devSel = el.querySelector('#r-dev');
  const rangeSel = el.querySelector('#r-range');
  let current = [];
  let charts = [];
  addCleanup(() => charts.forEach((c) => c.destroy()));

  const load = async () => {
    const body = el.querySelector('#r-body');
    body.innerHTML = '<p class="hint">Ładowanie…</p>';
    charts.forEach((c) => c.destroy()); charts = [];
    const d = devices.find((x) => x.id === devSel.value);
    const days = RANGES.find(([k]) => k === rangeSel.value)[2];
    let query = sb.from('readings').select('created_at, data').eq('device_id', d.id).order('created_at', { ascending: false }).limit(1000);
    if (days) query = query.gte('created_at', new Date(Date.now() - days * 86400000).toISOString());
    try { current = (await q(query)).reverse(); } catch (e) { fail(e); return; }
    const ms = metricsOf(d.product_type);
    const keys = [...new Set(current.flatMap((r) => Object.keys(r.data || {})))];
    const cols = [...ms.filter((m) => keys.includes(m.key)), ...keys.filter((k) => !ms.some((m) => m.key === k)).map((k) => ({ key: k, label: k, value_type: 'text' }))];
    if (!current.length) { body.innerHTML = '<div class="empty">Brak odczytów w wybranym zakresie.</div>'; return; }
    const numeric = cols.filter((m) => m.value_type === 'number' || m.value_type === 'integer');

    body.innerHTML = `
      ${numeric.length ? `<div class="charts">${numeric.map((m) => `<div class="chart-box glass"><h4>${esc(m.label)}${m.unit ? ` [${esc(m.unit)}]` : ''}</h4><div class="cv"><canvas data-chart="${esc(m.key)}"></canvas></div></div>`).join('')}</div>` : ''}
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Czas</th>${cols.map((m) => `<th>${esc(m.label)}${m.unit ? ` [${esc(m.unit)}]` : ''}</th>`).join('')}</tr></thead>
        <tbody>${[...current].reverse().slice(0, 200).map((r) => `<tr><td>${esc(fmtDate(r.created_at))}</td>${cols.map((m) => `<td>${esc(fmtValue(m, r.data?.[m.key]))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      ${current.length > 200 ? `<p class="hint" style="margin-top:10px">Tabela pokazuje 200 najnowszych z ${current.length} odczytów. Wszystkie są w pliku CSV.</p>` : ''}`;

    numeric.forEach((m) => {
      const pts = current.filter((r) => typeof r.data?.[m.key] === 'number');
      const ctx = body.querySelector(`[data-chart="${CSS.escape(m.key)}"]`);
      charts.push(new Chart(ctx, {
        type: 'line',
        data: {
          labels: pts.map((r) => fmtDate(r.created_at)),
          datasets: [{
            label: m.label, data: pts.map((r) => r.data[m.key]),
            borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)', fill: true, tension: 0.3,
            pointRadius: pts.length > 60 ? 0 : 3, borderWidth: 2,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${fmtValue(m, c.parsed.y)}${m.unit ? ` ${m.unit}` : ''}` } } },
          scales: {
            x: { ticks: { maxTicksLimit: 6, color: '#8a8f99' }, grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { ticks: { color: '#8a8f99' }, grid: { color: 'rgba(255,255,255,0.07)' }, beginAtZero: m.value_type === 'integer' },
          },
        },
      }));
    });
  };

  el.querySelector('#r-csv').onclick = () => {
    if (!current.length) { toast('Brak danych do pobrania.', 'err'); return; }
    const d = devices.find((x) => x.id === devSel.value);
    const keys = [...new Set(current.flatMap((r) => Object.keys(r.data || {})))];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['czas', ...keys].map(cell).join(';'), ...current.map((r) => [new Date(r.created_at).toLocaleString('pl-PL'), ...keys.map((k) => {
      const v = r.data?.[k];
      return typeof v === 'number' ? String(v).replace('.', ',') : v;
    })].map(cell).join(';'))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `odczyty_${(inv.name + '_' + (d.name || d.product_type)).replace(/[^\w\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]+/g, '_')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  devSel.onchange = load; rangeSel.onchange = load;
  el.querySelector('#r-refresh').onclick = load;
  await load();
}

// ── Zakładka: galeria ──

async function tabGallery(el, inv) {
  const photos = await q(sb.from('investment_photos').select('*').eq('investment_id', inv.id).order('sort_order').order('created_at'));
  let urls = {};
  if (photos.length) {
    const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(photos.map((p) => p.storage_path), 3600);
    (data || []).forEach((u) => { urls[u.path] = u.signedUrl; });
  }
  el.innerHTML = `
    <div class="panel glass">
      <h2>Galeria</h2>
      <p class="hint">${photos.length} z ${MAX_PHOTOS} zdjęć. Duże zdjęcia są automatycznie zmniejszane przed wysłaniem.</p>
      <div class="gallery">
        ${photos.map((p) => `<figure class="photo" style="margin:0" data-photo="${p.id}">
          <img src="${esc(urls[p.storage_path] || '')}" alt="${esc(p.caption || 'Zdjęcie inwestycji')}" loading="lazy">
          ${p.caption ? `<figcaption class="cap">${esc(p.caption)}</figcaption>` : ''}
          <div class="del" style="display:flex;gap:6px">
            <button class="btn icon sm" type="button" data-caption title="Podpis">${icon('edit', 15)}</button>
            <button class="btn icon sm danger" type="button" data-delete title="Usuń">${icon('trash', 15)}</button>
          </div></figure>`).join('')}
        ${photos.length < MAX_PHOTOS ? `<label class="upload">${icon('upload', 26)}<b>Dodaj zdjęcia</b><span style="font-size:12px">JPEG, PNG lub WebP · jeszcze ${MAX_PHOTOS - photos.length}</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden></label>` : ''}
      </div>
    </div>`;

  el.querySelectorAll('[data-photo]').forEach((fig) => {
    const p = photos.find((x) => x.id === fig.dataset.photo);
    fig.querySelector('img').onclick = () => {
      const lb = document.createElement('div');
      lb.className = 'lightbox';
      lb.innerHTML = `<img src="${esc(urls[p.storage_path])}" alt="${esc(p.caption || '')}">`;
      lb.onclick = () => lb.remove();
      document.body.append(lb);
    };
    fig.querySelector('[data-caption]').onclick = async () => {
      const res = await dialog({ title: 'Podpis zdjęcia', body: `<label class="lbl">Podpis<input class="inp" name="caption" maxlength="300" value="${esc(p.caption || '')}"></label>` });
      if (!res) return;
      try { await q(sb.from('investment_photos').update({ caption: res.caption.trim() || null }).eq('id', p.id)); tabGallery(el, inv); } catch (e) { fail(e); }
    };
    fig.querySelector('[data-delete]').onclick = async () => {
      if (!await confirmDialog('Usunąć zdjęcie?', 'Zdjęcie zostanie trwale usunięte.')) return;
      try {
        await q(sb.from('investment_photos').delete().eq('id', p.id));
        await sb.storage.from(PHOTO_BUCKET).remove([p.storage_path]);
        tabGallery(el, inv);
      } catch (e) { fail(e); }
    };
  });

  const input = el.querySelector('.upload input');
  if (input) input.onchange = async () => {
    const files = [...input.files].slice(0, MAX_PHOTOS - photos.length);
    if (input.files.length > files.length) toast(`Dodam tylko ${files.length}, limit to ${MAX_PHOTOS} zdjęć.`, 'err');
    const label = el.querySelector('.upload b');
    for (const [i, file] of files.entries()) {
      label.textContent = `Wysyłanie ${i + 1} z ${files.length}…`;
      try {
        const blob = await shrinkImage(file);
        const path = `${inv.id}/${crypto.randomUUID()}.${blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type });
        if (error) throw error;
        const { error: e2 } = await sb.from('investment_photos').insert({ investment_id: inv.id, storage_path: path, sort_order: photos.length + i });
        if (e2) { await sb.storage.from(PHOTO_BUCKET).remove([path]); throw e2; }
      } catch (e) { fail(e); break; }
    }
    tabGallery(el, inv);
  };
}

// Zmniejsza zdjęcia z telefonu do max 1920 px (JPEG), żeby zmieściły się w limicie 5 MB.
async function shrinkImage(file) {
  if (file.size < 1.5 * 1024 * 1024 && file.type !== 'image/png') return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1920 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}

// ── Zakładka: lokalizacja ──

async function tabLocation(el, inv) {
  const has = inv.latitude != null;
  el.innerHTML = `
    <div class="panel glass">
      <h2>Lokalizacja</h2>
      <p class="hint">Wpisz współrzędne albo kliknij miejsce na mapie, potem zapisz.</p>
      <form class="form-grid" id="loc" style="margin-bottom:16px">
        <label class="lbl">Szerokość (N)<input class="inp" name="lat" inputmode="decimal" placeholder="np. 53,9131" value="${has ? esc(String(inv.latitude).replace('.', ',')) : ''}"></label>
        <label class="lbl">Długość (E)<input class="inp" name="lon" inputmode="decimal" placeholder="np. 22,1756" value="${has ? esc(String(inv.longitude).replace('.', ',')) : ''}"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" type="submit">Zapisz</button>
          <button class="btn" type="button" id="loc-gps" title="Użyj lokalizacji tego urządzenia">${icon('pin', 15)} Moja lokalizacja</button>
          ${has ? `<button class="btn ghost" type="button" id="loc-clear">Wyczyść</button>` : ''}
        </div>
      </form>
      <div class="map" id="loc-map"></div>
      ${has ? `<p class="hint" style="margin:12px 0 0"><a href="https://www.google.com/maps?q=${inv.latitude},${inv.longitude}" target="_blank" rel="noopener">Otwórz w Google Maps →</a></p>` : ''}
    </div>`;

  const form = el.querySelector('#loc');
  const map = makeMap(el.querySelector('#loc-map'));
  let marker = null;
  const place = (lat, lon, zoom) => {
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.marker([lat, lon], { icon: pinIcon(), draggable: true }).addTo(map)
      .on('dragend', () => { const p = marker.getLatLng(); setInputs(p.lat, p.lng); });
    if (zoom) map.setView([lat, lon], zoom);
  };
  const setInputs = (lat, lon) => {
    form.lat.value = lat.toFixed(6).replace('.', ',');
    form.lon.value = lon.toFixed(6).replace('.', ',');
  };
  if (has) place(inv.latitude, inv.longitude, 13);
  map.on('click', (e) => { place(e.latlng.lat, e.latlng.lng); setInputs(e.latlng.lat, e.latlng.lng); });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const lat = parseCoord(form.lat.value);
    const lon = parseCoord(form.lon.value);
    if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      toast('Podaj obie współrzędne, np. 53,9131 i 22,1756.', 'err'); return;
    }
    try {
      await q(sb.from('investments').update({ latitude: lat, longitude: lon }).eq('id', inv.id));
      toast('Lokalizacja zapisana.', 'ok');
      inv.latitude = lat; inv.longitude = lon;
      runCleanups(); tabLocation(el, inv);
    } catch (err) { fail(err); }
  };
  el.querySelector('#loc-gps').onclick = () => {
    if (!navigator.geolocation) { toast('Ta przeglądarka nie udostępnia lokalizacji.', 'err'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { place(p.coords.latitude, p.coords.longitude, 15); setInputs(p.coords.latitude, p.coords.longitude); toast('Pobrano lokalizację. Kliknij Zapisz.', 'ok'); },
      () => toast('Nie udało się pobrać lokalizacji.', 'err'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  el.querySelector('#loc-clear')?.addEventListener('click', async () => {
    try {
      await q(sb.from('investments').update({ latitude: null, longitude: null }).eq('id', inv.id));
      inv.latitude = null; inv.longitude = null;
      runCleanups(); tabLocation(el, inv);
    } catch (err) { fail(err); }
  });
}

if (window.Chart) {
  Chart.defaults.color = '#a3a7b0';
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}

boot().catch(fail);
