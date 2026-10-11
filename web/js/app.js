import {
  SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET, DOC_BUCKET, MAX_DOC_BYTES, MAX_PHOTOS, ONLINE_MINUTES, DB_LIMIT_BYTES, FILES_LIMIT_BYTES,
} from './config.js';
import { icon } from './icons.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const state = {
  session: null,
  productTypes: [],
  productMetrics: [],
  profile: null, // { role: 'admin' | 'user', full_name, email }
  collapsed: readPref('sidebar-collapsed') === '1',
  cleanups: [],
};

const POLAND = [52.07, 19.48];
const POLAND_BOUNDS = [[49.0, 14.12], [54.84, 24.15]];

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
  if (/row-level security/i.test(m)) return 'Brak uprawnień do tej operacji. Poproś administratora.';
  if (/schema cache/i.test(m)) return 'Baza danych nie ma jeszcze tej funkcji. Trwa aktualizacja, spróbuj za kilka minut.';
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

const isAdmin = () => state.profile?.role === 'admin';
const ROLE_LABEL = { admin: 'Administrator', user: 'Użytkownik' };

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
  // Mapa liczy swój rozmiar przy tworzeniu; gdy kontener zmieni wymiary (układ strony,
  // pasek przewijania), dopasowujemy ją, żeby pinezka została na środku.
  const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  ro.observe(el);
  addCleanup(() => { ro.disconnect(); map.remove(); });
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
    if (state.session?.user.id !== session?.user.id) state.profile = null;
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') { setNewPassword(); return; }
    if (was !== !!session) route();
  });
  window.addEventListener('hashchange', route);
  route();
}

function renderLogin() {
  runCleanups();
  document.title = 'Logowanie · CloudEA';
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card glass fade-in">
        <form class="login-form" id="login" novalidate>
          <div class="brand-mark"><span class="logo">${icon('road', 20)}</span> CloudEA</div>
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
  if (!state.profile) {
    try {
      state.profile = await q(sb.from('profiles').select('role, full_name, email').eq('user_id', state.session.user.id).maybeSingle());
    } catch { /* starsza baza bez ról */ }
    state.profile ||= { role: 'user', email: state.session.user.email };
  }
  document.body.classList.toggle('role-user', !isAdmin());
  ensureShell();
  runCleanups();
  setActive(page === 'inwestycja' ? 'inwestycje' : page || 'pulpit');
  const content = app.querySelector('#content');
  content.innerHTML = '<div class="panel glass" style="color:var(--muted)">Ładowanie…</div>';
  app.querySelector('.shell').classList.remove('mobile-open');

  try {
    if (page === 'inwestycje') await pageInvestments(content);
    else if (page === 'mapa') await pageMap(content);
    else if (page === 'uzytkownicy' && isAdmin()) await pageUsers(content);
    else if (page === 'hurtownia') await pageWarehouse(content);
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
        <div class="sb-head">
          <div class="sb-title"><span class="logo">${icon('road', 18)}</span><span class="hide-collapsed">CloudEA</span></div>
          <button class="sb-toggle" type="button" aria-label="Zwiń menu" title="Zwiń / rozwiń menu">${icon('chevronLeft', 16)}</button>
        </div>
        <div class="sb-user">
          <div class="avatar">${esc((state.profile.full_name || email).slice(0, 1).toUpperCase())}</div>
          <div class="who hide-collapsed"><b title="${esc(email)}">${esc(state.profile.full_name || email)}</b><span>${ROLE_LABEL[state.profile.role] || 'Zalogowano'}</span></div>
        </div>
        <div class="sb-section">Menu</div>
        <nav class="sb-nav">
          <a class="sb-link" data-nav="pulpit" href="#/" title="Pulpit"><span class="bubble">${icon('home', 16)}</span><span class="hide-collapsed">Pulpit</span></a>
          <a class="sb-link" data-nav="inwestycje" href="#/inwestycje" title="Inwestycje"><span class="bubble">${icon('road', 16)}</span><span class="hide-collapsed">Inwestycje</span><span class="badge hide-collapsed" id="offline-badge" hidden title="Urządzenia offline"></span></a>
          <a class="sb-link" data-nav="mapa" href="#/mapa" title="Mapa"><span class="bubble">${icon('map', 16)}</span><span class="hide-collapsed">Mapa</span></a>
          <a class="sb-link" data-nav="hurtownia" href="#/hurtownia" title="Hurtownia danych"><span class="bubble">${icon('database', 16)}</span><span class="hide-collapsed">Hurtownia danych</span></a>
          ${isAdmin() ? `<a class="sb-link" data-nav="uzytkownicy" href="#/uzytkownicy" title="Użytkownicy"><span class="bubble">${icon('users', 16)}</span><span class="hide-collapsed">Użytkownicy</span></a>` : ''}
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

function topbar(title, crumbs = '', actions = '', { center = false } = {}) {
  return `
    <div class="topbar glass${center ? ' center' : ''}">
      <button class="btn icon ghost mobile-menu" type="button" data-mobile aria-label="Menu">${icon('road')}</button>
      <div class="tb-title" style="min-width:0">
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
  document.title = 'Pulpit · CloudEA';
  const since = new Date(Date.now() - 86400000).toISOString();
  const [investments, devices, readings24] = await Promise.all([
    q(sb.from('investments').select('id, name, latitude, longitude').order('created_at', { ascending: false })),
    q(sb.from('devices').select('id, name, product_type, last_seen, investment_id')),
    q(sb.from('readings').select('id', { count: 'exact', head: true }).gte('created_at', since)),
  ]);
  const connected = devices.filter((d) => typeOf(d.product_type).connected);
  const online = connected.filter((d) => isOnline(d.last_seen));
  const invById = Object.fromEntries(investments.map((i) => [i.id, i]));
  const offline = connected.filter((d) => !isOnline(d.last_seen));

  root.innerHTML = `
    ${topbar('Euroasfalt inteligentne rozwiązania dla miast', 'Przegląd wszystkich inwestycji', `<a class="btn primary" data-admin href="#/inwestycje?nowa=1">${icon('plus', 16)} Nowa inwestycja</a>`, { center: true })}
    <section class="stats fade-in">
      <div class="stat glass"><div class="label">${icon('road', 16)} Inwestycje</div><div class="value">${investments.length}</div></div>
      <div class="stat glass"><div class="label">${icon('chip', 16)} Urządzenia</div><div class="value">${devices.length}</div></div>
      <div class="stat glass"><div class="label">${icon('wifi', 16)} Online</div><div class="value">${online.length}<span style="font-size:16px;color:var(--muted)"> / ${connected.length}</span></div></div>
      <div class="stat glass"><div class="label">${icon('chart', 16)} Odczyty (24 h)</div><div class="value">${readings24}</div></div>
    </section>
    <section class="${offline.length ? 'grid-2' : ''}">
      <div class="panel glass">
        <h2>Mapa inwestycji</h2>
        <p class="hint">Kliknij pinezkę, aby otworzyć inwestycję.</p>
        <div class="map dash" id="dash-map"></div>
      </div>
      ${offline.length ? `<div class="panel glass">
        <h2>Urządzenia offline</h2><p class="hint">Brak kontaktu dłużej niż ${ONLINE_MINUTES} min.</p>
        <div class="list">${offline.slice(0, 8).map((d) => `
          <a class="row" href="#/inwestycja/${d.investment_id}" style="text-decoration:none;color:inherit">
            <div class="grow"><div class="title">${esc(d.name || typeOf(d.product_type).name)}</div>
            <div class="sub">${esc(invById[d.investment_id]?.name || '')}</div></div>
            <span class="status off">${esc(ago(d.last_seen))}</span></a>`).join('')}</div>
      </div>` : ''}
    </section>`;
  bindTopbar(root);
  // Na Pulpicie zawsze cała Polska z pinezkami inwestycji.
  const dashMap = makeMap(root.querySelector('#dash-map'), { scroll: false });
  drawInvestmentPins(dashMap, investments, { fit: false });
  const showPoland = () => dashMap.fitBounds(POLAND_BOUNDS, { padding: [8, 8] });
  showPoland(); setTimeout(showPoland, 120);
}

function drawInvestmentPins(map, investments, { fit = true } = {}) {
  const pts = [];
  investments.filter((i) => i.latitude != null).forEach((i) => {
    pts.push([i.latitude, i.longitude]);
    L.marker([i.latitude, i.longitude], { icon: pinIcon() }).addTo(map)
      .bindPopup(`<b>${esc(i.name)}</b><br><a href="#/inwestycja/${i.id}">Otwórz inwestycję →</a>`);
  });
  if (!fit) return;
  if (pts.length === 1) map.setView(pts[0], 11);
  else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 12 });
}

// ───────────────────────── Mapa ─────────────────────────

// ───────────────────────── Hurtownia danych ─────────────────────────

const TABLE_LABEL = {
  readings: 'Odczyty z urządzeń', commands: 'Polecenia dla urządzeń', devices: 'Urządzenia', device_metrics: 'Wybór danych urządzeń',
  investments: 'Inwestycje', investment_photos: 'Zdjęcia (opisy)', investment_documents: 'Dokumenty (opisy)',
  service_entries: 'Wpisy serwisowe', profiles: 'Użytkownicy', product_types: 'Typy produktów', product_metrics: 'Rodzaje danych',
};
const BUCKET_LABEL = { 'investment-photos': 'Zdjęcia', 'investment-docs': 'Dokumentacja PDF' };

function usageCard(title, ic, used, limit, note) {
  const pct = Math.min(100, (used / limit) * 100);
  const free = 100 - pct;
  const level = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return `<div class="usage glass">
    <div class="usage-head"><span class="dev-icon">${icon(ic, 20)}</span><h3>${title}</h3></div>
    <div class="usage-free"><b>${free.toLocaleString('pl-PL', { maximumFractionDigits: 1 })}%</b> wolnego miejsca</div>
    <div class="bar ${level}"><span style="width:${Math.max(pct, 0.6)}%"></span></div>
    <div class="usage-nums"><span>Zajęte: <b>${fmtSize(used)}</b></span><span>Limit: ${fmtSize(limit)}</span></div>
    ${note ? `<p class="hint">${note}</p>` : ''}
  </div>`;
}

async function pageWarehouse(root) {
  document.title = 'Hurtownia danych · CloudEA';
  const st = await q(sb.rpc('storage_stats'));
  const filesBytes = st.buckets.reduce((a, b) => a + Number(b.bytes), 0);
  const tables = [...st.tables].sort((a, b) => b.bytes - a.bytes);
  const rd = st.readings;
  const rdTable = st.tables.find((t) => t.name === 'readings');
  // Szacunek: ile jeszcze odczytów zmieści się w bazie i na ile czasu przy obecnym tempie.
  // Przy małej liczbie odczytów rozmiar tabeli to głównie stały narzut, więc liczymy ok. 250 B na odczyt.
  const perReading = rd.count > 5000 && rdTable ? rdTable.bytes / rd.count : 250;
  const freeDb = Math.max(0, DB_LIMIT_BYTES - st.db_bytes);
  const fits = Math.floor(freeDb / perReading);
  const days = rd.last_24h ? fits / rd.last_24h : null;
  const n = (x) => Number(x).toLocaleString('pl-PL');
  const howLong = days == null ? '' : days > 730 ? `ponad ${n(Math.floor(days / 365))} lat` : days > 60 ? `ok. ${n(Math.round(days / 30))} miesięcy` : `ok. ${n(Math.round(days))} dni`;

  root.innerHTML = `
    ${topbar('Hurtownia danych', 'Zajętość miejsca w darmowym planie Supabase')}
    <section class="usage-grid fade-in">
      ${usageCard('Baza danych', 'database', st.db_bytes, DB_LIMIT_BYTES, 'Tabele, odczyty z urządzeń i dane systemowe Supabase.')}
      ${usageCard('Pliki (zdjęcia i PDF)', 'image', filesBytes, FILES_LIMIT_BYTES, st.buckets.map((b) => `${esc(BUCKET_LABEL[b.bucket] || b.bucket)}: ${n(b.files)} plików, ${fmtSize(Number(b.bytes))}`).join(' · ') || 'Brak plików.')}
    </section>
    <section class="stats fade-in">
      <div class="stat glass"><div class="label">${icon('chart', 15)} Odczyty w bazie</div><div class="value">${n(rd.count)}</div></div>
      <div class="stat glass"><div class="label">${icon('calendar', 15)} Odczyty z ostatnich 24 h</div><div class="value">${n(rd.last_24h)}</div></div>
      <div class="stat glass"><div class="label">${icon('database', 15)} Zmieści się jeszcze</div><div class="value">~${n(fits)}</div><div class="hint">odczytów (ok. ${Math.round(perReading)} B każdy)</div></div>
      <div class="stat glass"><div class="label">${icon('refresh', 15)} Przy obecnym tempie</div><div class="value" style="font-size:22px">${howLong || '—'}</div><div class="hint">${howLong ? 'zanim baza się zapełni' : 'brak odczytów z ostatniej doby'}</div></div>
    </section>
    <div class="panel glass fade-in">
      <h2>Co zajmuje miejsce w bazie</h2>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Dane</th><th>Wierszy</th><th>Rozmiar</th><th style="width:40%">Udział</th></tr></thead>
        <tbody>${tables.map((t) => `<tr><td>${esc(TABLE_LABEL[t.name] || t.name)}</td><td>${t.rows == null ? '—' : n(t.rows)}</td><td>${fmtSize(t.bytes)}</td>
          <td><div class="bar thin"><span style="width:${Math.max(1, (t.bytes / tables[0].bytes) * 100)}%"></span></div></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="hint" style="margin-top:10px">Pozostałe ${fmtSize(Math.max(0, st.db_bytes - tables.reduce((a, t) => a + t.bytes, 0)))} to tabele systemowe Supabase (logowanie, pliki, indeksy wewnętrzne).${rd.first ? ` Najstarszy odczyt: ${esc(fmtDate(rd.first))}.` : ''}</p>
    </div>`;
  bindTopbar(root);
}

async function pageMap(root) {
  document.title = 'Mapa · CloudEA';
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
  document.title = 'Inwestycje · CloudEA';
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [investments, devices] = await Promise.all([
    q(sb.from('investments').select('id, name, notes, address, latitude, longitude, created_at').order('created_at', { ascending: false })),
    q(sb.from('devices').select('investment_id, product_type, last_seen')),
  ]);

  root.innerHTML = `
    ${topbar('Inwestycje', `${investments.length} inwestycji`,
      `<button class="btn primary" type="button" data-admin data-new>${icon('plus', 16)} Nowa inwestycja</button>`)}
    <label class="inv-search glass">${icon('search', 18)}
      <input type="search" id="inv-q" placeholder="Szukaj inwestycji po nazwie, opisie lub adresie…" aria-label="Szukaj inwestycji" autocomplete="off"></label>
    <section class="inv-grid fade-in">
      ${investments.map((i) => {
        const ds = devices.filter((d) => d.investment_id === i.id);
        const conn = ds.filter((d) => typeOf(d.product_type).connected);
        const on = conn.filter((d) => isOnline(d.last_seen)).length;
        const hay = [i.name, i.notes, i.address].filter(Boolean).join(' ').toLowerCase();
        return `<a class="inv-card glass" href="#/inwestycja/${i.id}" data-hay="${esc(hay)}">
          <div style="display:flex;align-items:center;gap:10px"><span class="dev-icon" style="width:38px;height:38px">${icon('road', 18)}</span><h3>${esc(i.name)}</h3></div>
          ${i.notes ? `<div class="sub" style="color:var(--muted);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.notes)}</div>` : ''}
          <div class="meta">
            <span>${icon('chip', 14)} ${ds.length} urządz.</span>
            ${conn.length ? `<span>${icon('wifi', 14)} ${on}/${conn.length} online</span>` : ''}
            <span title="${esc(i.address || '')}">${icon('pin', 14)} ${i.address ? esc(i.address.length > 34 ? `${i.address.slice(0, 32)}…` : i.address) : i.latitude != null ? 'na mapie' : 'brak lokalizacji'}</span>
          </div></a>`;
      }).join('')}
      <button class="inv-card glass new" type="button" data-admin data-new>${icon('plus', 26)}<span>Dodaj inwestycję</span></button>
    </section>
    <div class="empty" id="inv-none" hidden>Nic nie znaleziono.</div>`;

  // Wyszukiwanie na bieżąco, podczas pisania.
  const input = root.querySelector('#inv-q');
  const applyFilter = () => {
    const v = input.value.trim().toLowerCase();
    let n = 0;
    root.querySelectorAll('.inv-card[data-hay]').forEach((c) => { const ok = !v || c.dataset.hay.includes(v); c.hidden = !ok; n += ok; });
    root.querySelectorAll('.inv-card.new').forEach((c) => { c.hidden = !!v; });
    root.querySelector('#inv-none').hidden = !(v && !n);
  };
  input.oninput = applyFilter;
  input.value = params.get('q') || '';
  applyFilter();
  bindTopbar(root);
  root.querySelectorAll('[data-new]').forEach((b) => { b.onclick = newInvestment; });
  if (params.get('nowa') && isAdmin()) newInvestment();
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
  ['odczyty', 'Wykresy', 'chart'],
  ['dane', 'Dane rzeczywiste', 'table'],
  ['galeria', 'Galeria', 'image'],
  ['lokalizacja', 'Lokalizacja', 'pin'],
  ['serwis', 'Serwis', 'wrench'],
  ['dokumentacja', 'Dokumentacja', 'file'],
];

async function pageInvestment(root, id, tab) {
  const inv = await q(sb.from('investments').select('*').eq('id', id).maybeSingle());
  if (!inv) { root.innerHTML = `<div class="panel glass"><h2>Nie znaleziono inwestycji</h2><a class="btn" href="#/inwestycje">Wróć do listy</a></div>`; return; }
  document.title = `${inv.name} · CloudEA`;
  if (!TABS.some(([k]) => k === tab)) tab = 'urzadzenia';

  root.innerHTML = `
    ${topbar(esc(inv.name), `<a href="#/inwestycje" style="color:var(--muted);text-decoration:none">${icon('arrowLeft', 12).replace('class="ic"', 'class="ic" style="display:inline;vertical-align:-1px"')} Inwestycje</a>${inv.notes ? ` · ${esc(inv.notes)}` : ''}${inv.address ? ` · ${esc(inv.address)}` : ''}`,
      `<button class="btn sm" type="button" data-admin data-edit>${icon('edit', 15)} Edytuj</button>
       <button class="btn sm danger" type="button" data-admin data-del>${icon('trash', 15)}</button>`)}
    <nav class="tabs glass" style="border-radius:999px">
      ${TABS.map(([k, label, ic]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/inwestycja/${id}/${k}">${icon(ic, 16)} ${label}</a>`).join('')}
    </nav>
    <div id="tab" class="fade-in"></div>`;
  bindTopbar(root);
  root.querySelector('[data-edit]').onclick = () => editInvestment(inv);
  root.querySelector('[data-del]').onclick = () => deleteInvestment(inv);

  const el = root.querySelector('#tab');
  if (tab === 'odczyty') await tabReadings(el, inv, 'charts');
  else if (tab === 'dane') await tabReadings(el, inv, 'table');
  else if (tab === 'galeria') await tabGallery(el, inv);
  else if (tab === 'lokalizacja') await tabLocation(el, inv);
  else if (tab === 'serwis') await tabService(el, inv);
  else if (tab === 'dokumentacja') await tabDocuments(el, inv);
  else await tabDevices(el, inv);
}

async function editInvestment(inv) {
  const res = await dialog({
    title: 'Edytuj inwestycję',
    body: `<div class="list">
      <label class="lbl">Nazwa<input class="inp" name="name" maxlength="200" required value="${esc(inv.name)}"></label>
      <label class="lbl">Opis<input class="inp" name="notes" value="${esc(inv.notes || '')}"></label>
      <label class="lbl">Dokładny adres<input class="inp" name="address" maxlength="300" value="${esc(inv.address || '')}" placeholder="np. ul. Ełcka 12, 19-330 Stare Juchy"></label>
      <p class="hint" style="margin:0">Po zmianie adresu pinezka na mapie ustawi się automatycznie. Dokładne miejsce poprawisz w zakładce Lokalizacja.</p></div>`,
  });
  if (!res) return;
  const address = res.address.trim() || null;
  const patch = { name: res.name.trim(), notes: res.notes.trim() || null, address };
  try {
    if (address && address !== inv.address) {
      const [hit] = await geocode(address, 1);
      if (hit) { patch.latitude = hit.lat; patch.longitude = hit.lon; } else toast('Nie znaleziono adresu na mapie. Zapisuję adres bez zmiany pinezki.', 'err');
    }
    await q(sb.from('investments').update(patch).eq('id', inv.id));
    toast('Zapisano.', 'ok'); route();
  } catch (e) { fail(e); }
}

// Wyszukiwanie adresu w OpenStreetMap (Nominatim, bezpłatne; max ok. 1 zapytanie na sekundę).
async function geocode(text, limit = 5) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=pl&accept-language=pl&limit=${limit}&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('Wyszukiwarka adresów jest chwilowo niedostępna. Spróbuj za chwilę.');
  const rows = await res.json();
  return rows.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), label: r.display_name }));
}

async function deleteInvestment(inv) {
  if (!await confirmDialog('Usunąć inwestycję?', `„${inv.name}” zostanie usunięta razem z urządzeniami, odczytami, zdjęciami, historią serwisu i dokumentacją. Tego nie można cofnąć.`)) return;
  try {
    const photos = await q(sb.from('investment_photos').select('storage_path').eq('investment_id', inv.id));
    if (photos.length) await sb.storage.from(PHOTO_BUCKET).remove(photos.map((p) => p.storage_path));
    const docs = await q(sb.from('investment_documents').select('storage_path').eq('investment_id', inv.id));
    if (docs.length) await sb.storage.from(DOC_BUCKET).remove(docs.map((d) => d.storage_path));
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
    <div class="panel glass" data-admin style="margin-bottom:16px">
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
    if (!document.body.contains(el)) return;
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

// Polecenie „Uruchom przejście”: ESP32 odbiera je przez device_fetch_commands jako {"turn on": true}.
const RUN_KEY = 'turn on';
const CMD_STATUS = { new: 'oczekuje', received: 'odebrane', done: 'wykonane', failed: 'błąd' };

function deviceCard(d, dms, readings, commands) {
  const t = typeOf(d.product_type);
  const title = esc(d.name || t.name);
  if (!t.connected) {
    return `<article class="dev glass" data-dev="${d.id}">
      <div class="dev-head">
        <div class="dev-icon info">${icon('info', 20)}</div>
        <div class="grow"><h3>${title}</h3><div class="type">${esc(t.name)} · urządzenie informacyjne, nie łączy się ze stroną</div></div>
        <button class="btn icon ghost" data-admin data-rename title="Zmień nazwę">${icon('edit', 16)}</button>
        <button class="btn icon ghost" data-admin data-remove title="Usuń">${icon('trash', 16)}</button>
      </div></article>`;
  }
  const ms = metricsOf(d.product_type);
  const enabled = Object.fromEntries(dms.filter((x) => x.device_id === d.id).map((x) => [x.metric_key, x.enabled]));
  const last = readings.find((r) => r.device_id === d.id);
  const lastVal = {};
  ms.forEach((m) => { const r = readings.find((x) => x.device_id === d.id && x.data && m.key in x.data); if (r) lastVal[m.key] = r.data[m.key]; });
  const lastRun = commands.find((c) => c.device_id === d.id && c.payload?.[RUN_KEY] === true);
  const on = isOnline(d.last_seen);

  return `<article class="dev glass" data-dev="${d.id}">
    <div class="dev-head">
      <div class="dev-icon">${icon('chip', 20)}</div>
      <div class="grow"><h3>${title}</h3><div class="type">${esc(t.name)}</div></div>
      <span class="status ${on ? 'on' : 'off'}" data-status="${d.id}" title="Ostatni kontakt: ${esc(fmtDate(d.last_seen))}">${on ? 'Online' : `Offline · ${esc(ago(d.last_seen))}`}</span>
      <span class="key" title="Klucz do wpisania w programie ESP32">${esc(d.device_key)}<button type="button" data-copy="${esc(d.device_key)}" aria-label="Kopiuj klucz">${icon('copy', 15)}</button></span>
      <button class="btn icon ghost" data-admin data-rename title="Zmień nazwę">${icon('edit', 16)}</button>
      <button class="btn icon ghost" data-admin data-remove title="Usuń">${icon('trash', 16)}</button>
    </div>
    ${ms.length ? `<div class="metrics">
      ${ms.map((m) => `<div class="metric ${enabled[m.key] === false ? 'off' : ''}">
        <div class="m-label"><span>${esc(m.label)}</span>
          <label class="switch" title="Czy te dane mają przychodzić na stronę"><input type="checkbox" data-metric="${esc(m.key)}" ${enabled[m.key] !== false ? 'checked' : ''} ${isAdmin() ? '' : 'disabled'}><span></span></label></div>
        <div class="m-value">${esc(fmtValue(m, lastVal[m.key]))}${m.unit && lastVal[m.key] !== undefined ? `<small>${esc(m.unit)}</small>` : ''}</div>
      </div>`).join('')}
    </div>` : '<div class="hint" style="color:var(--muted);font-size:13px">Ten typ nie ma jeszcze zdefiniowanych danych.</div>'}
    <div class="run-row">
      <button class="btn primary" type="button" data-admin data-run>${icon('play', 16)} Uruchom przejście</button>
      <span class="run-last" data-run-last>${lastRun ? `Ostatnio: ${esc(fmtDate(lastRun.created_at))} · <span class="pill ${lastRun.status}">${CMD_STATUS[lastRun.status]}</span>` : 'Jeszcze nie uruchamiano ze strony.'}</span>
    </div>
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
    const run = card.querySelector('[data-run]');
    if (!run) return;
    run.onclick = async () => {
      run.disabled = true;
      try {
        await q(sb.from('commands').insert({ device_id: d.id, payload: { [RUN_KEY]: true } }));
        toast('Wysłano. Sterownik uruchomi przejście przy najbliższym połączeniu.', 'ok');
        tabDevices(el, inv);
      } catch (err) { run.disabled = false; fail(err); }
    };
  });
}

// ── Zakładki: wykresy i dane rzeczywiste (te same odczyty, inny widok) ──

// [klucz, etykieta, od ilu godzin wstecz, do ilu godzin wstecz]
const RANGES = [
  ['1h', 'Ostatnia godzina', 1, 0], ['prev1h', 'Poprzednia godzina', 2, 1],
  ['24h', 'Ostatnie 24 h', 24, 0], ['7d', 'Ostatnie 7 dni', 168, 0], ['30d', 'Ostatnie 30 dni', 720, 0],
  ['all', 'Wszystkie (maks. 1000)', null, 0],
];

async function tabReadings(el, inv, mode) {
  const devices = (await q(sb.from('devices').select('id, name, product_type').eq('investment_id', inv.id).order('created_at')))
    .filter((d) => typeOf(d.product_type).connected);
  if (!devices.length) { el.innerHTML = '<div class="empty glass">Brak urządzeń wysyłających dane. Dodaj sterownik w zakładce Urządzenia.</div>'; return; }

  el.innerHTML = `
    <div class="panel glass">
      <div class="toolbar">
        <label class="lbl">Urządzenie<select class="inp" id="r-dev">${devices.map((d) => `<option value="${d.id}">${esc(d.name || typeOf(d.product_type).name)} · ${esc(typeOf(d.product_type).name)}</option>`).join('')}</select></label>
        <label class="lbl">Zakres<select class="inp" id="r-range">${RANGES.map(([k, l]) => `<option value="${k}"${k === '24h' ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
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
    const [, , fromH, toH] = RANGES.find(([k]) => k === rangeSel.value);
    let query = sb.from('readings').select('created_at, data').eq('device_id', d.id).order('created_at', { ascending: false }).limit(1000);
    if (fromH) query = query.gte('created_at', new Date(Date.now() - fromH * 3600000).toISOString());
    if (toH) query = query.lt('created_at', new Date(Date.now() - toH * 3600000).toISOString());
    try { current = (await q(query)).reverse(); } catch (e) { fail(e); return; }
    const ms = metricsOf(d.product_type);
    const keys = [...new Set(current.flatMap((r) => Object.keys(r.data || {})))];
    const cols = [...ms.filter((m) => keys.includes(m.key)), ...keys.filter((k) => !ms.some((m) => m.key === k)).map((k) => ({ key: k, label: k, value_type: 'text' }))];
    if (!current.length) { body.innerHTML = '<div class="empty">Brak odczytów w wybranym zakresie.</div>'; return; }
    const numeric = cols.filter((m) => m.value_type === 'number' || m.value_type === 'integer');

    if (mode === 'table') {
      body.innerHTML = `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>Czas</th>${cols.map((m) => `<th>${esc(m.label)}${m.unit ? ` [${esc(m.unit)}]` : ''}</th>`).join('')}</tr></thead>
          <tbody>${[...current].reverse().map((r) => `<tr><td>${esc(fmtDate(r.created_at))}</td>${cols.map((m) => `<td>${esc(fmtValue(m, r.data?.[m.key]))}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>
        <p class="hint" style="margin-top:10px">${current.length} odczytów${current.length >= 1000 ? ' (pokazano 1000 najnowszych, zawęź zakres)' : ''}.</p>`;
      return;
    }
    if (!numeric.length) { body.innerHTML = '<div class="empty">To urządzenie nie wysyła danych liczbowych. Zobacz zakładkę Dane rzeczywiste.</div>'; return; }
    body.innerHTML = `<div class="charts">${numeric.map((m) => `<div class="chart-box glass"><h4>${esc(m.label)}${m.unit ? ` [${esc(m.unit)}]` : ''}</h4><div class="cv"><canvas data-chart="${esc(m.key)}"></canvas></div></div>`).join('')}</div>`;

    numeric.forEach((m) => {
      const pts = current.filter((r) => typeof r.data?.[m.key] === 'number');
      const ctx = body.querySelector(`[data-chart="${CSS.escape(m.key)}"]`);
      // Na osi same godziny; przy zakresie dłuższym niż doba dodajemy dzień, żeby godziny się nie myliły.
      const multiDay = pts.length > 1 && new Date(pts.at(-1).created_at) - new Date(pts[0].created_at) > 86400000;
      const tick = (iso) => new Date(iso).toLocaleString('pl-PL', multiDay
        ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
        : { hour: '2-digit', minute: '2-digit' });
      charts.push(new Chart(ctx, {
        type: 'bar',
        data: {
          labels: pts.map((r) => tick(r.created_at)),
          datasets: [{
            // Najpierw słupki na dole osi; prawdziwe wartości wstawiamy, gdy układ strony się ustali (niżej).
            label: m.label, data: pts.map(() => null),
            backgroundColor: 'rgba(0,255,255,0.55)', hoverBackgroundColor: '#00ffff',
            borderColor: '#00ffff', borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
            borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom',
            categoryPercentage: 0.9, barPercentage: 0.85,
          }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          // Słupki rosną od zera do wartości przez 3 sekundy po wejściu na wykresy.
          animation: { duration: 3000, easing: 'easeOutCubic' },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title: (items) => fmtDate(pts[items[0].dataIndex].created_at),
              label: (c) => `${fmtValue(m, c.parsed.y)}${m.unit ? ` ${m.unit}` : ''}`,
            } },
          },
          scales: {
            x: { ticks: { maxTicksLimit: 8, maxRotation: 0, color: '#8a8f99' }, grid: { display: false } },
            y: { ticks: { color: '#8a8f99' }, grid: { color: 'rgba(255,255,255,0.07)' }, beginAtZero: m.value_type === 'integer' },
          },
        },
      }));
      const chart = charts.at(-1);
      // Wzrost słupków od zera do wartości przez 3 s. Startujemy po ustaleniu układu,
      // bo zmiana rozmiaru wykresu w trakcie przerwałaby animację.
      setTimeout(() => {
        if (!chart.canvas?.isConnected) return;
        chart.data.datasets[0].data = pts.map((r) => r.data[m.key]);
        chart.update();
      }, 150);
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
  clearInterval(el.galleryTimer);
  const photos = await q(sb.from('investment_photos').select('*').eq('investment_id', inv.id).order('sort_order').order('created_at'));
  const urls = {};
  if (photos.length) {
    const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(photos.map((p) => p.storage_path), 3600);
    (data || []).forEach((u) => { urls[u.path] = u.signedUrl; });
  }
  const n = photos.length;
  const free = MAX_PHOTOS - n;
  const title = (p, i) => p.caption || `${inv.name} · zdjęcie ${i + 1}`;
  const fileInput = '<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden>';

  el.innerHTML = `
    <div class="panel glass">
      <div class="gal-head">
        <div class="grow"><h2>Galeria</h2>
          <p class="hint" style="margin:0">${n} z ${MAX_PHOTOS} zdjęć. Duże zdjęcia są automatycznie zmniejszane przed wysłaniem.</p></div>
        ${n && free > 0 ? `<label class="btn primary sm upload-btn">${icon('upload', 15)} <span>Dodaj zdjęcia</span>${fileInput}</label>` : ''}
      </div>
      ${n ? `
      <div class="carousel" tabindex="0" aria-roledescription="karuzela" aria-label="Zdjęcia inwestycji">
        <div class="car-stage">
          ${photos.map((p, i) => `
          <figure class="car-card" data-i="${i}">
            <div class="img"><img src="${esc(urls[p.storage_path] || '')}" alt="${esc(title(p, i))}" draggable="false"></div>
            <div class="car-tools">
              <button class="car-pill" type="button" data-expand>${icon('expand', 13)} Powiększ</button>
              <button class="car-pill round" type="button" data-more aria-label="Więcej opcji">${icon('more', 16)}</button>
            </div>
            <figcaption>
              <div class="t"><b>${esc(title(p, i))}</b><span class="n">${i + 1} / ${n}</span></div>
              <div class="d">${icon('calendar', 13)} Dodano ${esc(fmtDate(p.created_at))}</div>
            </figcaption>
            <div class="veil"></div>
          </figure>`).join('')}
        </div>
        <div class="car-bar glass">
          <button class="btn icon ghost" type="button" data-prev aria-label="Poprzednie">${icon('chevronLeft', 18)}</button>
          <button class="btn icon ghost" type="button" data-play aria-label="Odtwarzaj">${icon('play', 16)}</button>
          <div class="car-now"><img alt=""><div><b></b><span></span></div></div>
          <button class="btn icon ghost" type="button" data-next aria-label="Następne">${icon('chevronRight', 18)}</button>
        </div>
        <div class="car-dots">${photos.map((_, i) => `<button type="button" data-dot="${i}" aria-label="Zdjęcie ${i + 1}"></button>`).join('')}</div>
      </div>` : `
      <label class="upload">${icon('upload', 30)}<b>Dodaj pierwsze zdjęcia</b>
        <span style="font-size:12px">JPEG, PNG lub WebP · maksymalnie ${MAX_PHOTOS}</span>${fileInput}</label>`}
    </div>`;

  if (n) setupCarousel(el, inv, photos, urls, title);

  const input = el.querySelector('input[type=file]');
  if (input) input.onchange = async () => {
    const files = [...input.files].slice(0, free);
    if (input.files.length > files.length) toast(`Dodam tylko ${files.length}, limit to ${MAX_PHOTOS} zdjęć.`, 'err');
    const label = input.closest('label').querySelector('b, span');
    for (const [i, file] of files.entries()) {
      label.textContent = `Wysyłanie ${i + 1} z ${files.length}…`;
      try {
        const blob = await shrinkImage(file);
        const path = `${inv.id}/${crypto.randomUUID()}.${blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type });
        if (error) throw error;
        const { error: e2 } = await sb.from('investment_photos').insert({ investment_id: inv.id, storage_path: path, sort_order: n + i });
        if (e2) { await sb.storage.from(PHOTO_BUCKET).remove([path]); throw e2; }
      } catch (e) { fail(e); break; }
    }
    el.galleryStart = n; // po dodaniu pokaż pierwsze nowe zdjęcie
    tabGallery(el, inv);
  };
}

// Karuzela 3D: środkowe zdjęcie na wierzchu, sąsiednie obrócone w perspektywie.
function setupCarousel(el, inv, photos, urls, title) {
  const n = photos.length;
  const root = el.querySelector('.carousel');
  const cards = [...root.querySelectorAll('.car-card')];
  const playBtn = root.querySelector('[data-play]');
  let cur = Math.min(el.galleryStart ?? 0, n - 1);
  el.galleryStart = 0;
  let playing = false;

  // Najkrótsza odległość po okręgu, żeby karuzela się zapętlała.
  const offset = (i) => {
    let d = i - cur;
    if (d > n / 2) d -= n;
    if (d < -n / 2) d += n;
    return d;
  };

  const render = () => {
    const narrow = root.clientWidth < 640;
    const step = narrow ? 0.55 : 0.62;
    cards.forEach((c, i) => {
      const d = offset(i);
      const a = Math.abs(d);
      const w = c.offsetWidth;
      c.classList.toggle('active', d === 0);
      c.style.transform = `translate(-50%, -50%) translateX(${d * w * step}px) translateZ(${-a * 160}px) rotateY(${-Math.sign(d) * Math.min(a, 2) * 24}deg) scale(${1 - Math.min(a, 2) * 0.06})`;
      c.style.opacity = a > 2 ? '0' : String(1 - a * 0.18);
      c.style.zIndex = String(10 - a);
      c.style.pointerEvents = a > 2 ? 'none' : '';
      c.setAttribute('aria-hidden', d === 0 ? 'false' : 'true');
    });
    const p = photos[cur];
    root.querySelector('.car-now img').src = urls[p.storage_path] || '';
    root.querySelector('.car-now b').textContent = title(p, cur);
    root.querySelector('.car-now span').textContent = `${cur + 1} z ${n} · ${fmtDate(p.created_at)}`;
    root.querySelectorAll('[data-dot]').forEach((b, i) => b.classList.toggle('on', i === cur));
    closeMenu();
  };
  const go = (i) => { cur = ((i % n) + n) % n; render(); };

  const setPlaying = (on) => {
    playing = on && n > 1;
    clearInterval(el.galleryTimer);
    if (playing) el.galleryTimer = setInterval(() => go(cur + 1), 4500);
    playBtn.innerHTML = icon(playing ? 'pause' : 'play', 16);
    playBtn.setAttribute('aria-label', playing ? 'Zatrzymaj' : 'Odtwarzaj');
  };
  addCleanup(() => clearInterval(el.galleryTimer));

  // Podgląd na całym ekranie: zdjęcie w 120% rozmiaru dopasowanego do ekranu.
  // Jeśli wychodzi poza ekran, można je przesuwać (kółkiem, palcem lub przeciągając).
  const openLightbox = (i) => {
    const p = photos[i];
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${esc(urls[p.storage_path])}" alt="${esc(title(p, i))}" draggable="false">
      <button class="btn icon lb-close" type="button" aria-label="Zamknij">${icon('x', 20)}</button>
      <div class="lb-cap">${esc(title(p, i))}</div>`;
    const img = lb.querySelector('img');
    const close = () => { lb.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const size = () => {
      if (!img.naturalWidth) return;
      const fit = Math.min((innerWidth - 48) / img.naturalWidth, (innerHeight * 0.9) / img.naturalHeight, 1);
      img.style.width = `${Math.round(img.naturalWidth * fit * 1.2)}px`;
      img.style.height = `${Math.round(img.naturalHeight * fit * 1.2)}px`;
      lb.scrollLeft = (lb.scrollWidth - lb.clientWidth) / 2;
      lb.scrollTop = (lb.scrollHeight - lb.clientHeight) / 2;
      img.classList.add('in');
    };
    img.onload = size;
    if (img.complete) size();
    // Przeciąganie myszą, gdy zdjęcie jest większe od ekranu.
    let drag = null;
    lb.onpointerdown = (e) => { if (e.pointerType === 'mouse' && e.target === img) drag = { x: e.clientX, y: e.clientY, l: lb.scrollLeft, t: lb.scrollTop, moved: false }; };
    lb.onpointermove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      lb.scrollLeft = drag.l - dx; lb.scrollTop = drag.t - dy;
    };
    lb.onpointerup = () => { setTimeout(() => { drag = null; }, 0); };
    lb.onclick = (e) => { if (drag?.moved) return; if (e.target === img || e.target === lb || e.target.closest('.lb-close')) close(); };
    document.addEventListener('keydown', onKey);
    document.body.append(lb);
  };

  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  const openMenu = (card) => {
    closeMenu();
    const p = photos[cur];
    menu = document.createElement('div');
    menu.className = 'car-menu';
    menu.innerHTML = `<button type="button" data-admin data-caption>${icon('edit', 15)} Zmień podpis</button>
      <button type="button" data-download>${icon('download', 15)} Pobierz</button>
      <button type="button" class="danger" data-admin data-delete>${icon('trash', 15)} Usuń zdjęcie</button>`;
    card.append(menu);
    menu.onclick = (e) => e.stopPropagation();
    menu.querySelector('[data-caption]').onclick = async () => {
      closeMenu();
      const res = await dialog({ title: 'Podpis zdjęcia', body: `<label class="lbl">Podpis<input class="inp" name="caption" maxlength="300" value="${esc(p.caption || '')}" placeholder="np. Przejście przy szkole – widok od północy"></label>` });
      if (!res) return;
      try {
        await q(sb.from('investment_photos').update({ caption: res.caption.trim() || null }).eq('id', p.id));
        el.galleryStart = cur; tabGallery(el, inv);
      } catch (e) { fail(e); }
    };
    menu.querySelector('[data-download]').onclick = () => { closeMenu(); window.open(urls[p.storage_path], '_blank', 'noopener'); };
    menu.querySelector('[data-delete]').onclick = async () => {
      closeMenu();
      if (!await confirmDialog('Usunąć zdjęcie?', 'Zdjęcie zostanie trwale usunięte.')) return;
      try {
        await q(sb.from('investment_photos').delete().eq('id', p.id));
        await sb.storage.from(PHOTO_BUCKET).remove([p.storage_path]);
        el.galleryStart = Math.max(0, cur - 1); tabGallery(el, inv);
      } catch (e) { fail(e); }
    };
  };

  cards.forEach((c, i) => {
    c.onclick = (e) => {
      if (moved) return;
      if (e.target.closest('[data-more]')) { e.stopPropagation(); menu ? closeMenu() : openMenu(c); return; }
      if (e.target.closest('[data-expand]')) { setPlaying(false); openLightbox(i); return; }
      if (offset(i) !== 0) { setPlaying(false); go(i); return; }
      openLightbox(i);
    };
  });
  root.querySelector('[data-prev]').onclick = () => { setPlaying(false); go(cur - 1); };
  root.querySelector('[data-next]').onclick = () => { setPlaying(false); go(cur + 1); };
  playBtn.onclick = () => setPlaying(!playing);
  root.querySelectorAll('[data-dot]').forEach((b) => { b.onclick = () => { setPlaying(false); go(+b.dataset.dot); }; });
  root.onkeydown = (e) => {
    if (e.key === 'ArrowLeft') { setPlaying(false); go(cur - 1); }
    else if (e.key === 'ArrowRight') { setPlaying(false); go(cur + 1); }
    else if (e.key === 'Escape') closeMenu();
  };
  if (el.galleryCloser) document.removeEventListener('click', el.galleryCloser);
  el.galleryCloser = closeMenu;
  document.addEventListener('click', closeMenu);
  addCleanup(() => document.removeEventListener('click', closeMenu));

  // Przesuwanie palcem lub myszą.
  const stage = root.querySelector('.car-stage');
  let startX = null;
  let moved = false;
  stage.onpointerdown = (e) => { startX = e.clientX; moved = false; };
  stage.onpointermove = (e) => { if (startX !== null && Math.abs(e.clientX - startX) > 8) moved = true; };
  stage.onpointerup = (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) { setPlaying(false); go(cur + (dx < 0 ? 1 : -1)); }
    setTimeout(() => { moved = false; }, 0);
  };
  stage.onpointercancel = () => { startX = null; };

  const ro = new ResizeObserver(render);
  ro.observe(root);
  addCleanup(() => ro.disconnect());
  render();
}

// ── Zakładka: serwis ──

const fmtMoney = (v) => `${Number(v || 0).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
// Kwota wpisana z przecinkiem lub kropką; pusta = brak kosztu.
const parseMoney = (v) => {
  const t = String(v ?? '').replace(/\s|zł/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN;
};

async function tabService(el, inv) {
  const entries = await q(sb.from('service_entries').select('*').eq('investment_id', inv.id)
    .order('entry_date', { ascending: false }).order('created_at', { ascending: false }));
  const today = new Date().toLocaleDateString('sv-SE');
  const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('pl-PL', { day: 'numeric', month: 'long', year: 'numeric' });

  el.innerHTML = `
    <div class="panel glass" style="margin-bottom:16px">
      <h2>Nowy wpis serwisowy</h2>
      <p class="hint">Opisz naprawę, przegląd albo wymianę części. Wpisy tworzą historię serwisu tej inwestycji.</p>
      <form id="svc-new" class="svc-form">
        <label class="lbl">Data<input class="inp" type="date" name="entry_date" value="${today}" max="${today}" required></label>
        <label class="lbl svc-body">Opis prac
          <textarea class="inp" name="body" maxlength="5000" required placeholder="np. Wymiana akumulatora 12 V w AllinOne przy szkole, sprawdzono ładowanie z panelu."></textarea></label>
        <label class="lbl svc-cost">Koszt (zł)<input class="inp" name="cost" inputmode="decimal" placeholder="np. 450,00" autocomplete="off"></label>
        <div class="svc-actions"><span class="counter" data-count>0 / 5000</span><button class="btn primary" type="submit">${icon('plus', 16)} Zapisz wpis</button></div>
      </form>
    </div>
    <div class="panel glass">
      <h2 class="svc-title">Historia serwisu <span class="svc-total" title="Suma kosztów wszystkich wpisów">Łączny koszt: <b>${fmtMoney(entries.reduce((a, e) => a + Number(e.cost || 0), 0))}</b></span></h2>
      <p class="hint">${entries.length ? `${entries.length} ${entries.length === 1 ? 'wpis' : entries.length < 5 ? 'wpisy' : 'wpisów'}, od najnowszego.` : 'Brak wpisów.'}</p>
      ${entries.length ? `<ol class="timeline">${entries.map((e) => `
        <li data-entry="${e.id}">
          <div class="tl-dot"></div>
          <div class="tl-card">
            <div class="tl-head"><b>${esc(fmtDay(e.entry_date))}</b>
              <span class="sub">${esc(e.author || '')}${e.updated_at ? ' · edytowano' : ''}</span>
              ${e.cost != null ? `<span class="tl-cost">${fmtMoney(e.cost)}</span>` : ''}
              <span class="tl-tools" ${isAdmin() || e.author_id === state.session.user.id ? '' : 'hidden'}>
                <button class="btn icon ghost sm" type="button" data-edit title="Edytuj">${icon('edit', 15)}</button>
                <button class="btn icon ghost sm" type="button" data-del title="Usuń">${icon('trash', 15)}</button>
              </span>
            </div>
            <div class="tl-body">${esc(e.body)}</div>
          </div>
        </li>`).join('')}</ol>` : '<div class="empty">Historia napraw pojawi się tutaj po dodaniu pierwszego wpisu.</div>'}
    </div>`;

  const form = el.querySelector('#svc-new');
  const count = form.querySelector('[data-count]');
  form.body.oninput = () => { count.textContent = `${form.body.value.length} / 5000`; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.body.value.trim()) { toast('Wpisz opis prac.', 'err'); return; }
    const cost = parseMoney(form.cost.value);
    if (Number.isNaN(cost)) { toast('Koszt wpisz jako kwotę, np. 450 albo 450,50.', 'err'); return; }
    try {
      await q(sb.from('service_entries').insert({ investment_id: inv.id, entry_date: form.entry_date.value, body: form.body.value.trim(), cost }));
      toast('Wpis zapisany.', 'ok');
      tabService(el, inv);
    } catch (err) { fail(err); }
  };
  el.querySelectorAll('[data-entry]').forEach((li) => {
    const entry = entries.find((x) => x.id === li.dataset.entry);
    li.querySelector('[data-edit]').onclick = async () => {
      const res = await dialog({
        title: 'Edytuj wpis serwisowy',
        body: `<div class="list">
          <label class="lbl">Data<input class="inp" type="date" name="entry_date" value="${esc(entry.entry_date)}" max="${today}" required></label>
          <label class="lbl">Opis prac<textarea class="inp" name="body" maxlength="5000" required style="min-height:160px">${esc(entry.body)}</textarea></label>
          <label class="lbl">Koszt (zł)<input class="inp" name="cost" inputmode="decimal" value="${entry.cost != null ? esc(String(entry.cost).replace('.', ',')) : ''}" placeholder="puste = brak kosztu"></label></div>`,
      });
      if (!res) return;
      const cost = parseMoney(res.cost);
      if (Number.isNaN(cost)) { toast('Koszt wpisz jako kwotę, np. 450 albo 450,50.', 'err'); return; }
      try { await q(sb.from('service_entries').update({ entry_date: res.entry_date, body: res.body.trim(), cost }).eq('id', entry.id)); tabService(el, inv); } catch (err) { fail(err); }
    };
    li.querySelector('[data-del]').onclick = async () => {
      if (!await confirmDialog('Usunąć wpis?', `Wpis z dnia ${fmtDay(entry.entry_date)} zostanie usunięty.`)) return;
      try { await q(sb.from('service_entries').delete().eq('id', entry.id)); tabService(el, inv); } catch (err) { fail(err); }
    };
  });
}

// ── Zakładka: dokumentacja ──

function fmtSize(b) {
  if (b == null) return '';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} kB`;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} GB`;
  return `${(b / 1024 / 1024).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} MB`;
}

async function tabDocuments(el, inv) {
  const docs = await q(sb.from('investment_documents').select('*').eq('investment_id', inv.id).order('created_at', { ascending: false }));
  const fileInput = '<input type="file" accept="application/pdf,.pdf" multiple hidden>';
  el.innerHTML = `
    <div class="panel glass">
      <div class="gal-head">
        <div class="grow"><h2>Dokumentacja</h2>
          <p class="hint" style="margin:0">Pliki PDF: schematy, instrukcje, protokoły odbioru. Maksymalnie ${fmtSize(MAX_DOC_BYTES)} na plik.</p></div>
        ${docs.length ? `<label class="btn primary sm">${icon('upload', 15)} <span>Dodaj PDF</span>${fileInput}</label>` : ''}
      </div>
      ${docs.length ? `<div class="docs">${docs.map((d) => `
        <div class="doc" data-doc="${d.id}">
          <div class="doc-icon">${icon('file', 22)}<span>PDF</span></div>
          <div class="grow" style="min-width:0">
            <div class="title">${esc(d.file_name)}</div>
            <div class="sub">${esc(fmtSize(d.size_bytes))} · dodano ${esc(fmtDate(d.created_at))}</div>
          </div>
          <button class="btn sm" type="button" data-open>${icon('eye', 15)} Otwórz</button>
          <button class="btn icon ghost sm" type="button" data-download title="Pobierz">${icon('download', 15)}</button>
          <button class="btn icon ghost sm" type="button" data-admin data-rename title="Zmień nazwę">${icon('edit', 15)}</button>
          <button class="btn icon ghost sm" type="button" data-admin data-del title="Usuń">${icon('trash', 15)}</button>
        </div>`).join('')}</div>` : `
      <label class="upload" style="margin-top:12px">${icon('file', 30)}<b>Dodaj pierwsze dokumenty PDF</b>
        <span style="font-size:12px">Możesz wybrać kilka plików naraz</span>${fileInput}</label>`}
    </div>`;

  const signed = async (d, download) => {
    const { data, error } = await sb.storage.from(DOC_BUCKET).createSignedUrl(d.storage_path, 600, download ? { download: d.file_name } : undefined);
    if (error) throw error;
    return data.signedUrl;
  };
  el.querySelectorAll('[data-doc]').forEach((row) => {
    const d = docs.find((x) => x.id === row.dataset.doc);
    row.querySelector('[data-open]').onclick = async () => {
      const w = window.open('', '_blank');
      try { const u = await signed(d, false); if (w) w.location = u; else location.href = u; } catch (e) { w?.close(); fail(e); }
    };
    row.querySelector('[data-download]').onclick = async () => {
      try { const a = document.createElement('a'); a.href = await signed(d, true); a.click(); } catch (e) { fail(e); }
    };
    row.querySelector('[data-rename]').onclick = async () => {
      const res = await dialog({ title: 'Nazwa dokumentu', body: `<label class="lbl">Nazwa<input class="inp" name="file_name" maxlength="200" required value="${esc(d.file_name)}"></label>` });
      if (!res) return;
      try { await q(sb.from('investment_documents').update({ file_name: res.file_name.trim() }).eq('id', d.id)); tabDocuments(el, inv); } catch (e) { fail(e); }
    };
    row.querySelector('[data-del]').onclick = async () => {
      if (!await confirmDialog('Usunąć dokument?', `„${d.file_name}” zostanie trwale usunięty.`)) return;
      try {
        await q(sb.from('investment_documents').delete().eq('id', d.id));
        await sb.storage.from(DOC_BUCKET).remove([d.storage_path]);
        tabDocuments(el, inv);
      } catch (e) { fail(e); }
    };
  });

  const input = el.querySelector('input[type=file]');
  if (input) input.onchange = async () => {
    const files = [...input.files];
    const label = input.closest('label').querySelector('b, span');
    for (const [i, file] of files.entries()) {
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast(`„${file.name}” to nie jest PDF, pomijam.`, 'err'); continue; }
      if (file.size > MAX_DOC_BYTES) { toast(`„${file.name}” jest za duży (maks. ${fmtSize(MAX_DOC_BYTES)}).`, 'err'); continue; }
      label.textContent = `Wysyłanie ${i + 1} z ${files.length}…`;
      try {
        const path = `${inv.id}/${crypto.randomUUID()}.pdf`;
        const { error } = await sb.storage.from(DOC_BUCKET).upload(path, file, { contentType: 'application/pdf' });
        if (error) throw error;
        const name = file.name.slice(0, 200);
        const { error: e2 } = await sb.from('investment_documents').insert({ investment_id: inv.id, storage_path: path, file_name: name, size_bytes: file.size });
        if (e2) { await sb.storage.from(DOC_BUCKET).remove([path]); throw e2; }
      } catch (e) { fail(e); break; }
    }
    tabDocuments(el, inv);
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
  const admin = isAdmin();
  el.innerHTML = `
    <div class="panel glass">
      <h2>Lokalizacja</h2>
      ${inv.address ? `<p class="addr">${icon('pin', 16)} ${esc(inv.address)}</p>` : ''}
      ${admin ? `
      <p class="hint">Wpisz dokładny adres i wybierz wynik, albo kliknij miejsce na mapie. Pinezkę można przeciągnąć. Na koniec kliknij Zapisz.</p>
      <form class="addr-search" id="addr">
        <label class="field-addr">${icon('search', 16)}
          <input class="inp" name="q" value="${esc(inv.address || '')}" placeholder="np. ul. Ełcka 12, Stare Juchy" autocomplete="street-address"></label>
        <button class="btn" type="submit">Szukaj adresu</button>
      </form>
      <div class="addr-results" id="addr-results" hidden></div>
      <form class="form-grid" id="loc" style="margin:14px 0 16px">
        <label class="lbl">Szerokość (N)<input class="inp" name="lat" inputmode="decimal" placeholder="np. 53,9131" value="${has ? esc(String(inv.latitude).replace('.', ',')) : ''}"></label>
        <label class="lbl">Długość (E)<input class="inp" name="lon" inputmode="decimal" placeholder="np. 22,1756" value="${has ? esc(String(inv.longitude).replace('.', ',')) : ''}"></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary" type="submit">Zapisz</button>
          <button class="btn" type="button" id="loc-gps" title="Użyj lokalizacji tego urządzenia">${icon('pin', 15)} Moja lokalizacja</button>
          ${has ? '<button class="btn ghost" type="button" id="loc-clear">Wyczyść</button>' : ''}
        </div>
      </form>` : `<p class="hint">${has ? `Współrzędne: ${esc(String(inv.latitude).replace('.', ','))}, ${esc(String(inv.longitude).replace('.', ','))}` : 'Lokalizacja nie została jeszcze ustawiona.'}</p>`}
      <div class="map" id="loc-map"></div>
      ${has ? `<p class="hint" style="margin:12px 0 0"><a href="https://www.google.com/maps?q=${inv.latitude},${inv.longitude}" target="_blank" rel="noopener">Otwórz w Google Maps →</a> · <a href="https://www.google.com/maps/dir/?api=1&destination=${inv.latitude},${inv.longitude}" target="_blank" rel="noopener">Wyznacz trasę →</a></p>` : ''}
    </div>`;

  const map = makeMap(el.querySelector('#loc-map'));
  let marker = null;
  if (!admin) {
    if (has) {
      marker = L.marker([inv.latitude, inv.longitude], { icon: pinIcon() }).addTo(map);
      map.setView([inv.latitude, inv.longitude], 14);
      setTimeout(() => map.setView([inv.latitude, inv.longitude], 14), 120);
    }
    return;
  }

  const form = el.querySelector('#loc');
  const search = el.querySelector('#addr');
  const results = el.querySelector('#addr-results');
  let address = inv.address || null;
  const setInputs = (lat, lon) => {
    form.lat.value = lat.toFixed(6).replace('.', ',');
    form.lon.value = lon.toFixed(6).replace('.', ',');
  };
  const place = (lat, lon, zoom) => {
    if (marker) marker.setLatLng([lat, lon]);
    else marker = L.marker([lat, lon], { icon: pinIcon(), draggable: true }).addTo(map)
      .on('dragend', () => { const p = marker.getLatLng(); setInputs(p.lat, p.lng); });
    if (zoom) map.setView([lat, lon], zoom);
  };
  // Widok całej miejscowości; centrujemy jeszcze raz, gdy mapa ma już docelowy rozmiar.
  if (has) { place(inv.latitude, inv.longitude, 14); setTimeout(() => map.setView([inv.latitude, inv.longitude], 14), 120); }
  map.on('click', (e) => { place(e.latlng.lat, e.latlng.lng); setInputs(e.latlng.lat, e.latlng.lng); });

  search.onsubmit = async (e) => {
    e.preventDefault();
    const text = search.q.value.trim();
    if (text.length < 3) { toast('Wpisz adres, np. ulicę z numerem i miejscowość.', 'err'); return; }
    const btn = search.querySelector('button');
    btn.disabled = true; btn.textContent = 'Szukam…';
    try {
      const hits = await geocode(text);
      results.hidden = false;
      results.innerHTML = hits.length
        ? hits.map((h, i) => `<button type="button" class="addr-hit" data-i="${i}">${icon('pin', 15)}<span>${esc(h.label)}</span></button>`).join('')
        : '<div class="sub" style="padding:8px 4px;color:var(--muted)">Nie znaleziono. Spróbuj dodać miejscowość albo kod pocztowy.</div>';
      results.querySelectorAll('[data-i]').forEach((b) => {
        b.onclick = () => {
          const h = hits[+b.dataset.i];
          place(h.lat, h.lon, 17); setInputs(h.lat, h.lon);
          address = text;
          results.hidden = true;
          toast('Pinezka ustawiona. Popraw ją w razie potrzeby i kliknij Zapisz.', 'ok');
        };
      });
      if (hits.length === 1) results.querySelector('[data-i]').click();
    } catch (err) { fail(err); } finally { btn.disabled = false; btn.textContent = 'Szukaj adresu'; }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const lat = parseCoord(form.lat.value);
    const lon = parseCoord(form.lon.value);
    if (lat === null || lon === null || Number.isNaN(lat) || Number.isNaN(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      toast('Wyszukaj adres albo podaj obie współrzędne, np. 53,9131 i 22,1756.', 'err'); return;
    }
    const typed = search.q.value.trim();
    if (typed && typed !== inv.address) address = typed;
    try {
      await q(sb.from('investments').update({ latitude: lat, longitude: lon, address }).eq('id', inv.id));
      toast('Lokalizacja zapisana.', 'ok');
      Object.assign(inv, { latitude: lat, longitude: lon, address });
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
      await q(sb.from('investments').update({ latitude: null, longitude: null, address: null }).eq('id', inv.id));
      Object.assign(inv, { latitude: null, longitude: null, address: null });
      runCleanups(); tabLocation(el, inv);
    } catch (err) { fail(err); }
  });
}

// ───────────────────────── Użytkownicy (tylko administrator) ─────────────────────────

async function usersApi(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* zostaje ogólny komunikat */ }
    throw new Error(msg);
  }
  return data;
}

async function pageUsers(root) {
  document.title = 'Użytkownicy · CloudEA';
  const users = await q(sb.from('profiles').select('*').order('role').order('created_at'));
  const me = state.session.user.id;
  const admins = users.filter((u) => u.role === 'admin').length;
  const group = (role, title, hint) => {
    const list = users.filter((u) => u.role === role);
    return `
      <section class="panel glass">
        <h2>${title} <span class="count">${list.length}</span></h2>
        <p class="hint">${hint}</p>
        ${list.length ? `<div class="users">${list.map((u) => `
          <div class="user" data-user="${u.user_id}">
            <div class="avatar ${u.role}">${esc((u.full_name || u.email).slice(0, 1).toUpperCase())}</div>
            <div class="grow" style="min-width:0">
              <div class="title">${esc(u.full_name || u.email)}${u.user_id === me ? ' <span class="pill done">to Ty</span>' : ''}</div>
              <div class="sub">${esc(u.email)} · od ${esc(new Date(u.created_at).toLocaleDateString('pl-PL'))}</div>
            </div>
            <select class="inp role-sel" data-role ${u.role === 'admin' && admins <= 1 ? 'disabled title="Musi zostać co najmniej jeden administrator"' : ''}>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option>
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>Użytkownik</option>
            </select>
            <button class="btn icon ghost sm" type="button" data-name title="Zmień nazwę">${icon('edit', 15)}</button>
            <button class="btn icon ghost sm" type="button" data-pass title="Ustaw nowe hasło">${icon('lock', 15)}</button>
            ${u.user_id === me ? '' : `<button class="btn icon ghost sm" type="button" data-del title="Usuń konto">${icon('trash', 15)}</button>`}
          </div>`).join('')}</div>` : '<div class="empty">Brak osób w tej grupie.</div>'}
      </section>`;
  };

  root.innerHTML = `
    ${topbar('Użytkownicy', `${users.length} ${users.length === 1 ? 'konto' : 'kont'} w bazie`, `<button class="btn primary" type="button" data-add>${icon('plus', 16)} Dodaj użytkownika</button>`)}
    ${group('admin', 'Administratorzy', 'Pełny dostęp: inwestycje, urządzenia, wysyłanie danych do ESP32, usuwanie, zarządzanie użytkownikami.')}
    ${group('user', 'Użytkownicy', 'Podgląd wszystkiego oraz dodawanie wpisów serwisowych, zdjęć i dokumentów. Bez edycji inwestycji, urządzeń i usuwania.')}`;
  bindTopbar(root);

  root.querySelector('[data-add]').onclick = async () => {
    const res = await dialog({
      title: 'Nowy użytkownik',
      ok: 'Utwórz konto',
      body: `<div class="list">
        <label class="lbl">Imię i nazwisko<input class="inp" name="full_name" maxlength="120" placeholder="np. Jan Kowalski"></label>
        <label class="lbl">E-mail (login)<input class="inp" type="email" name="email" required autocomplete="off"></label>
        <label class="lbl">Hasło startowe (min. 8 znaków)<input class="inp" type="text" name="password" minlength="8" required autocomplete="off"></label>
        <label class="lbl">Rola<select class="inp" name="role"><option value="user">Użytkownik</option><option value="admin">Administrator</option></select></label>
        <p class="hint" style="margin:0">Przekaż tej osobie e-mail i hasło. Hasło zmieni sama przez „Nie pamiętasz hasła?” na stronie logowania.</p></div>`,
    });
    if (!res) return;
    try { await usersApi({ action: 'create', ...res }); toast('Konto utworzone.', 'ok'); pageUsers(root); } catch (e) { fail(e); }
  };

  root.querySelectorAll('[data-user]').forEach((row) => {
    const u = users.find((x) => x.user_id === row.dataset.user);
    row.querySelector('[data-role]').onchange = async (e) => {
      const role = e.target.value;
      try {
        await q(sb.from('profiles').update({ role }).eq('user_id', u.user_id));
        toast(`${u.full_name || u.email}: ${ROLE_LABEL[role]}.`, 'ok');
        if (u.user_id === me) { state.profile.role = role; location.hash = '#/'; location.reload(); return; }
        pageUsers(root);
      } catch (err) { e.target.value = u.role; fail(err); }
    };
    row.querySelector('[data-name]').onclick = async () => {
      const res = await dialog({ title: 'Imię i nazwisko', body: `<label class="lbl">Imię i nazwisko<input class="inp" name="full_name" maxlength="120" value="${esc(u.full_name || '')}"></label>` });
      if (!res) return;
      try {
        await q(sb.from('profiles').update({ full_name: res.full_name.trim() || null }).eq('user_id', u.user_id));
        if (u.user_id === me) state.profile.full_name = res.full_name.trim() || null;
        pageUsers(root);
      } catch (err) { fail(err); }
    };
    row.querySelector('[data-pass]').onclick = async () => {
      const res = await dialog({ title: `Nowe hasło: ${u.email}`, body: `<label class="lbl">Nowe hasło (min. 8 znaków)<input class="inp" type="text" name="password" minlength="8" required autocomplete="off"></label>` });
      if (!res) return;
      try { await usersApi({ action: 'reset_password', user_id: u.user_id, password: res.password }); toast('Hasło zmienione.', 'ok'); } catch (err) { fail(err); }
    };
    row.querySelector('[data-del]')?.addEventListener('click', async () => {
      if (!await confirmDialog('Usunąć konto?', `${u.full_name || u.email} nie będzie mógł się zalogować. Wpisy serwisowe tej osoby zostaną.`)) return;
      try { await usersApi({ action: 'delete', user_id: u.user_id }); toast('Konto usunięte.', 'ok'); pageUsers(root); } catch (err) { fail(err); }
    });
  });
}

if (window.Chart) {
  Chart.defaults.color = '#a3a7b0';
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}

boot().catch(fail);
