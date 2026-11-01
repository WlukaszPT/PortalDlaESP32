import {
  SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET, DOC_BUCKET, MAX_DOC_BYTES, FW_BUCKET, MAX_FW_BYTES, MAX_PHOTOS, ONLINE_MINUTES, DB_LIMIT_BYTES, FILES_LIMIT_BYTES,
} from './config.js';
import { icon } from './icons.js';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const app = document.getElementById('app');

const state = {
  session: null,
  productTypes: [],
  productMetrics: [],
  profile: null, // { role: 'admin' | 'user', full_name, email }
  isOwner: false, // właściciel portalu: jako jedyny widzi historię wejść
  visitLogged: null, // dla kogo zapisano już wejście w tej karcie przeglądarki
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
  if (/Email not confirmed/i.test(m)) return 'Konto nie zostało potwierdzone. Kliknij link z e-maila.';
  if (/Signups not allowed|signup.*disabled/i.test(m)) return 'Rejestracja jest wyłączona. Poproś administratora o konto.';
  if (/User already registered/i.test(m)) return 'Konto z tym adresem już istnieje. Zaloguj się.';
  if (/Password should be at least/i.test(m)) return 'Hasło jest za krótkie (min. 8 znaków).';
  if (/rate limit/i.test(m)) return 'Zbyt wiele prób. Spróbuj ponownie za kilka minut.';
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
const ROLE_LABEL = { admin: 'Administrator', user: 'Użytkownik', pending: 'Oczekuje na zatwierdzenie' };

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
          <p class="switch-auth">Nie masz konta? <a href="#" id="to-register">Zarejestruj się</a></p>
        </form>
        <form class="login-form" id="register" novalidate hidden>
          <div class="brand-mark"><span class="logo">${icon('road', 20)}</span> CloudEA</div>
          <h1>Rejestracja</h1>
          <p class="sub">Załóż konto. Dostęp do danych włączy administrator.</p>
          <label class="field">${icon('user')}
            <input type="text" name="full_name" placeholder="Imię i nazwisko" autocomplete="name" maxlength="120" required>
          </label>
          <label class="field">${icon('mail')}
            <input type="email" name="email" placeholder="Adres e-mail" autocomplete="email" required>
          </label>
          <label class="field">${icon('lock')}
            <input type="password" name="password" placeholder="Hasło (min. 8 znaków)" autocomplete="new-password" minlength="8" required>
          </label>
          <label class="field">${icon('lock')}
            <input type="password" name="password2" placeholder="Powtórz hasło" autocomplete="new-password" required>
          </label>
          <div class="form-error" id="register-error"></div>
          <button class="btn block" type="submit">Zarejestruj</button>
          <p class="switch-auth">Masz już konto? <a href="#" id="to-login">Zaloguj się</a></p>
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
  const reg = app.querySelector('#register');
  const regErr = app.querySelector('#register-error');
  const show = (which) => {
    form.hidden = which !== 'login'; reg.hidden = which !== 'register';
    err.textContent = ''; regErr.textContent = '';
    document.title = `${which === 'login' ? 'Logowanie' : 'Rejestracja'} · CloudEA`;
    (which === 'login' ? form.email : reg.full_name).focus();
  };
  app.querySelector('#to-register').onclick = (e) => { e.preventDefault(); show('register'); };
  app.querySelector('#to-login').onclick = (e) => { e.preventDefault(); show('login'); };
  reg.onsubmit = async (e) => {
    e.preventDefault();
    regErr.textContent = '';
    const fullName = reg.full_name.value.trim();
    const email = reg.email.value.trim();
    if (!fullName || !email || !reg.password.value) { regErr.textContent = 'Uzupełnij wszystkie pola.'; return; }
    if (!reg.email.checkValidity()) { regErr.textContent = 'Podaj poprawny adres e-mail.'; return; }
    if (reg.password.value.length < 8) { regErr.textContent = 'Hasło musi mieć co najmniej 8 znaków.'; return; }
    if (reg.password.value !== reg.password2.value) { regErr.textContent = 'Hasła nie są takie same.'; return; }
    const btn = reg.querySelector('[type=submit]');
    btn.disabled = true; btn.textContent = 'Rejestracja…';
    const { data, error } = await sb.auth.signUp({
      email, password: reg.password.value,
      options: { data: { full_name: fullName }, emailRedirectTo: location.origin + location.pathname },
    });
    btn.disabled = false; btn.textContent = 'Zarejestruj';
    if (error) { regErr.textContent = translateError(error); return; }
    if (data.session) { location.hash = '#/'; return; }
    // Bez sesji: Supabase wymaga potwierdzenia adresu e-mail.
    show('login');
    form.email.value = email;
    toast('Konto założone. Potwierdź adres e-mail linkiem z wiadomości, potem zaloguj się.', 'ok');
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

// Konto po rejestracji, którego administrator jeszcze nie zatwierdził.
function renderPending() {
  runCleanups();
  document.title = 'Oczekuje na zatwierdzenie · CloudEA';
  const email = state.session.user.email || '';
  app.innerHTML = `
    <div class="login-wrap">
      <div class="panel glass fade-in pending-card">
        <div class="brand-mark"><span class="logo">${icon('road', 20)}</span> CloudEA</div>
        <h1>Konto czeka na zatwierdzenie</h1>
        <p class="sub">Zarejestrowano: <b>${esc(state.profile.full_name || email)}</b> (${esc(email)}).<br>
          Administrator musi włączyć Twoje konto. Potem zobaczysz inwestycje i odczyty.</p>
        <div class="pending-actions">
          <button class="btn primary" type="button" id="pending-check">${icon('refresh', 15)} Sprawdź ponownie</button>
          <button class="btn" type="button" id="pending-logout">${icon('logout', 15)} Wyloguj</button>
        </div>
      </div>
    </div>`;
  app.querySelector('#pending-check').onclick = () => { state.profile = null; route(); };
  app.querySelector('#pending-logout').onclick = async () => { await sb.auth.signOut(); location.hash = '#/login'; };
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

// Jedno wejście na stronę = jeden wpis w historii (odświeżenie strony to nowe wejście).
function logVisit() {
  const uid = state.session.user.id;
  if (state.visitLogged === uid) return;
  state.visitLogged = uid;
  sb.rpc('log_visit', { p_device: deviceName() }).then(() => {}, () => {});
}

// Krótki opis przeglądarki i systemu, np. „Chrome · Windows”.
function deviceName() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Przeglądarka';
  const os = /Android/.test(ua) ? 'Android' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
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
    // Brak profilu traktujemy jak konto niezatwierdzone (baza i tak nie pokaże mu danych).
    state.profile ||= { role: 'pending', email: state.session.user.email };
    state.isOwner = await sb.rpc('is_owner').then(({ data }) => data === true, () => false);
  }
  logVisit();
  if (state.profile.role === 'pending') { renderPending(); return; }
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
    else if (page === 'uzytkownicy' && id === 'historia' && state.isOwner) await pageVisits(content);
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
          ${isAdmin() ? `<a class="sb-link" data-nav="uzytkownicy" href="#/uzytkownicy" title="Użytkownicy"><span class="bubble">${icon('users', 16)}</span><span class="hide-collapsed">Użytkownicy</span><span class="badge hide-collapsed" id="pending-badge" hidden title="Konta czekające na zatwierdzenie"></span></a>` : ''}
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
  refreshPendingBadge();
}

async function refreshPendingBadge() {
  const b = app.querySelector('#pending-badge');
  if (!b) return;
  try {
    const { count } = await sb.from('profiles').select('user_id', { count: 'exact', head: true }).eq('role', 'pending');
    b.textContent = count || 0; b.hidden = !count;
  } catch { /* nieistotne */ }
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
      <p class="hint" style="margin-top:10px">Pozostałe ${fmtSize(Math.max(0, st.db_bytes - tables.reduce((a, t) => a + t.bytes, 0)))} to tabele systemowe Supabase (logowanie, pliki, indeksy wewnętrzne).${rd.first ? ` Najstarszy odczyt: ${esc(fmtDate(rd.first))}.` : ''} Odczyty starsze niż 180 dni baza usuwa sama co noc.</p>
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
  ['firmware', 'Firmware', 'cpu'],
];

async function pageInvestment(root, id, tab) {
  const inv = await q(sb.from('investments').select('*').eq('id', id).maybeSingle());
  if (!inv) { root.innerHTML = `<div class="panel glass"><h2>Nie znaleziono inwestycji</h2><a class="btn" href="#/inwestycje">Wróć do listy</a></div>`; return; }
  document.title = `${inv.name} · CloudEA`;
  // Zakładkę „Firmware” widzi tylko administrator.
  const tabs = TABS.filter(([k]) => k !== 'firmware' || isAdmin());
  if (!tabs.some(([k]) => k === tab)) tab = 'urzadzenia';

  root.innerHTML = `
    ${topbar(esc(inv.name), `<a href="#/inwestycje" style="color:var(--muted);text-decoration:none">${icon('arrowLeft', 12).replace('class="ic"', 'class="ic" style="display:inline;vertical-align:-1px"')} Inwestycje</a>${inv.notes ? ` · ${esc(inv.notes)}` : ''}${inv.address ? ` · ${esc(inv.address)}` : ''}`,
      `<button class="btn sm" type="button" data-admin data-edit>${icon('edit', 15)} Edytuj</button>
       <button class="btn sm danger" type="button" data-admin data-del>${icon('trash', 15)}</button>`)}
    <nav class="tabs glass" style="border-radius:999px">
      ${tabs.map(([k, label, ic]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/inwestycja/${id}/${k}">${icon(ic, 16)} ${label}</a>`).join('')}
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
  else if (tab === 'firmware') await tabFirmware(el, inv);
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
    const devs = await q(sb.from('devices').select('id').eq('investment_id', inv.id));
    await removeFirmwareFiles(devs.map((d) => d.id));
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

// Polecenia „Uruchom przejście” {"turn on": true} i „Wyłącz przejście” {"turn off": true}.
// ESP32 trzyma stałe połączenie (Supabase Realtime) i dostaje je od razu; po 1 minucie
// bez „Wyłącz” sam gasi przejście (zabezpieczenie w programie ESP32).
const RUN_KEY = 'turn on';
const STOP_KEY = 'turn off';
const isPassageCmd = (c) => c.payload?.[RUN_KEY] === true || c.payload?.[STOP_KEY] === true;
function runLastHtml(c) {
  if (!c) return 'Jeszcze nie uruchamiano ze strony.';
  const what = c.payload?.[STOP_KEY] === true ? 'Wyłączono' : 'Uruchomiono';
  return `${what}: ${esc(fmtDate(c.created_at))} · <span class="pill ${c.status}" title="${esc(c.result || '')}">${CMD_STATUS[c.status]}</span>`;
}
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
  const lastRun = commands.find((c) => c.device_id === d.id && isPassageCmd(c));
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
      <button class="btn primary" type="button" data-admin data-run="${RUN_KEY}">${icon('play', 16)} Uruchom przejście</button>
      <button class="btn danger" type="button" data-admin data-run="${STOP_KEY}">${icon('pause', 16)} Wyłącz przejście</button>
      <span class="run-last" data-run-last>${runLastHtml(lastRun)}</span>
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
      try { await removeFirmwareFiles([d.id]); await q(sb.from('devices').delete().eq('id', d.id)); toast('Usunięto.', 'ok'); refreshOfflineBadge(); tabDevices(el, inv); } catch (e) { fail(e); }
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
    const runBtns = [...card.querySelectorAll('[data-run]')];
    const last = card.querySelector('[data-run-last]');
    runBtns.forEach((btn) => {
      btn.onclick = async () => {
        const key = btn.dataset.run;
        runBtns.forEach((b) => { b.disabled = true; });
        try {
          const [cmd] = await q(sb.from('commands').insert({ device_id: d.id, payload: { [key]: true } }).select());
          last.innerHTML = runLastHtml(cmd);
          toast(key === STOP_KEY ? 'Wysłano „Wyłącz przejście”.' : 'Wysłano „Uruchom przejście”. Bez wyłączenia zgaśnie samo po 1 minucie.', 'ok');
          watchCommand(cmd, last);
        } catch (err) { fail(err); }
        runBtns.forEach((b) => { b.disabled = false; });
      };
    });
  });
}

// Śledzi przez ok. 15 s, czy sterownik odebrał i wykonał polecenie, i odświeża napis pod przyciskami.
async function watchCommand(cmd, node) {
  for (let i = 0; i < 15 && document.body.contains(node); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const { data } = await sb.from('commands').select('*').eq('id', cmd.id).maybeSingle();
    if (!data || !document.body.contains(node)) return;
    node.innerHTML = runLastHtml(data);
    if (data.status === 'done' || data.status === 'failed') return;
  }
}

// ── Zakładki: wykresy i dane rzeczywiste (te same odczyty, inny widok) ──

// [klucz, etykieta, od ilu godzin wstecz, do ilu godzin wstecz, ile ostatnich odczytów]
const RANGES = [
  ['last20', 'Ostatnie 20 odczytów', null, 0, 20],
  ['1h', 'Ostatnia godzina', 1, 0], ['prev1h', 'Poprzednia godzina', 2, 1],
  ['8h', 'Ostatnie 8 h', 8, 0], ['24h', 'Ostatnie 24 h', 24, 0], ['7d', 'Ostatnie 7 dni', 168, 0], ['30d', 'Ostatnie 30 dni', 720, 0],
  ['all', 'Wszystkie (maks. 1000)', null, 0],
];

// Liczniki narastające w sterowniku (zerowane o północy lub po restarcie).
// W widoku godzinowym pokazujemy ich przyrost w każdej godzinie, a pozostałe dane jako średnią.
const COUNTER_KEYS = ['activations', 'pedestrians'];

// Znaczniki osi czasu w pełnych godzinach (lokalnych), co 1–24 h albo co dobę, maks. ok. 8 znaczników.
function hourTicks(from, to) {
  const hours = (to - from) / 3600000;
  const step = [1, 2, 3, 6, 12, 24, 48, 168].find((h) => hours / h <= 8) ?? 168;
  const t = new Date(from); t.setMinutes(0, 0, 0);
  if (t < from) t.setHours(t.getHours() + 1);
  while (step < 24 ? t.getHours() % step : t.getHours()) t.setHours(t.getHours() + 1);
  const out = [];
  for (; t <= to; t.setHours(t.getHours() + step)) out.push(+t);
  return out;
}

// Odczyty jednej wielkości zebrane w godziny: [{ start: Date, value }].
// Pokazujemy każdą godzinę zakresu, także bez odczytów (licznik 0, średnia pusta).
function hourlySeries(pts, key, from, to) {
  const buckets = new Map();
  let prev = null;
  for (const r of pts) {
    const v = r.data[key];
    const start = new Date(r.created_at); start.setMinutes(0, 0, 0);
    const b = buckets.get(+start) || { start, sum: 0, n: 0, inc: 0 };
    buckets.set(+start, b);
    b.sum += v; b.n += 1;
    // Spadek licznika oznacza wyzerowanie, więc nowa wartość to uruchomienia od zera.
    if (prev !== null) b.inc += v >= prev ? v - prev : v;
    prev = v;
  }
  const counter = COUNTER_KEYS.includes(key);
  const hour = (t) => { const d = new Date(t); d.setMinutes(0, 0, 0); return d; };
  const first = hour(from ?? pts[0]?.created_at ?? Date.now());
  const last = hour(to ?? pts.at(-1)?.created_at ?? Date.now());
  // Przy bardzo długim zakresie (powyżej ok. miesiąca) pomijamy puste godziny, żeby wykres był czytelny.
  if (last - first <= 744 * 3600000) {
    for (let t = new Date(first); t <= last; t.setHours(t.getHours() + 1)) {
      if (!buckets.has(+t)) buckets.set(+t, { start: new Date(t), sum: 0, n: 0, inc: 0 });
    }
  }
  return [...buckets.values()].sort((a, b) => a.start - b.start)
    .map((b) => ({ start: b.start, n: b.n, value: counter ? b.inc : b.n ? Math.round((b.sum / b.n) * 100) / 100 : null }));
}

const GAP_COLOR = 'rgba(205,210,218,0.32)';
const fmtSpan = (ms) => {
  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} d`, h && `${h} h`, (m || (!d && !h)) && `${m} min`].filter(Boolean).join(' ');
};

// Przerwy w danych: odstęp między odczytami dłuższy niż 3 typowe odstępy (i co najmniej 2 minuty).
function findGaps(times) {
  const steps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
  const typical = steps[Math.floor(steps.length / 2)] || 0;
  const limit = Math.max(3 * typical, 120000);
  return { limit, gaps: times.slice(1).map((t, i) => [times[i], t]).filter(([a, b]) => b - a > limit) };
}

async function tabReadings(el, inv, mode) {
  const devices = (await q(sb.from('devices').select('id, name, product_type').eq('investment_id', inv.id).order('created_at')))
    .filter((d) => typeOf(d.product_type).connected);
  if (!devices.length) { el.innerHTML = '<div class="empty glass">Brak urządzeń wysyłających dane. Dodaj sterownik w zakładce Urządzenia.</div>'; return; }

  el.innerHTML = `
    <div class="panel glass">
      <div class="toolbar">
        <label class="lbl">Urządzenie<select class="inp" id="r-dev">${devices.map((d) => `<option value="${d.id}">${esc(d.name || typeOf(d.product_type).name)} · ${esc(typeOf(d.product_type).name)}</option>`).join('')}</select></label>
        <label class="lbl">Zakres<select class="inp" id="r-range">${RANGES.map(([k, l]) => `<option value="${k}"${k === (mode === 'table' ? '8h' : 'last20') ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        ${mode === 'table' ? '' : `<label class="lbl">Typ wykresu<select class="inp" id="r-type"><option value="real">Rzeczywisty</option><option value="hourly">Godzinowy</option></select></label>`}
        <span style="flex:1"></span>
        <button class="btn sm" type="button" id="r-refresh">${icon('refresh', 15)} Odśwież</button>
        <button class="btn sm" type="button" id="r-csv">Pobierz CSV</button>
      </div>
      <div id="r-body"></div>
    </div>`;
  const devSel = el.querySelector('#r-dev');
  const rangeSel = el.querySelector('#r-range');
  const typeSel = el.querySelector('#r-type');
  let current = [];
  let charts = [];
  addCleanup(() => charts.forEach((c) => c.destroy()));

  const load = async () => {
    const body = el.querySelector('#r-body');
    body.innerHTML = '<p class="hint">Ładowanie…</p>';
    charts.forEach((c) => c.destroy()); charts = [];
    const d = devices.find((x) => x.id === devSel.value);
    const [, , fromH, toH, lim] = RANGES.find(([k]) => k === rangeSel.value);
    const from = fromH ? new Date(Date.now() - fromH * 3600000).toISOString() : null;
    const to = toH ? new Date(Date.now() - toH * 3600000).toISOString() : null;
    let total = 0;
    try {
      if (mode !== 'table' && !lim) {
        // Wykresy: odczyty z całego okresu (przy dużej liczbie co n-ty), a nie tylko 1000 najnowszych.
        // Supabase oddaje najwyżej 1000 wierszy, dlatego prosimy o 900 punktów (plus zawsze ostatni odczyt).
        // Kolejność od najnowszego: gdyby limit coś obciął, odpadną najstarsze odczyty, nie najświeższe.
        current = (await q(sb.rpc('readings_sample', { p_device_id: d.id, p_from: from, p_to: to, p_max: 900 })
          .order('created_at', { ascending: false }))).reverse();
        total = current[0]?.total || 0;
      } else {
        let query = sb.from('readings').select('created_at, data').eq('device_id', d.id).order('created_at', { ascending: false }).limit(lim || 1000);
        if (from) query = query.gte('created_at', from);
        if (to) query = query.lt('created_at', to);
        current = (await q(query)).reverse();
      }
    } catch (e) { fail(e); return; }
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
    const hourly = typeSel?.value === 'hourly';
    const suffix = (m) => (!hourly ? '' : COUNTER_KEYS.includes(m.key) ? ' · na godzinę' : ' · średnia godzinowa');
    body.innerHTML = `<div class="charts">${numeric.map((m) => `<div class="chart-box glass"><h4>${esc(m.label)}${m.unit ? ` [${esc(m.unit)}]` : ''}${suffix(m)}</h4><div class="cv"><canvas data-chart="${esc(m.key)}"></canvas></div></div>`).join('')}</div>
      ${total > current.length ? `<p class="hint" style="margin-top:10px">W tym okresie jest ${total} odczytów. Wykres pokazuje ${current.length} z nich, równo rozłożonych w czasie.</p>` : ''}`;

    let anyGap = false;
    numeric.forEach((m) => {
      const raw = current.filter((r) => typeof r.data?.[m.key] === 'number');
      // Wspólna postać dla obu typów: czas słupka, wartość i opis w dymku.
      const pts = hourly
        ? hourlySeries(raw, m.key, fromH ? Date.now() - fromH * 3600000 : null, Date.now() - toH * 3600000 - (toH ? 1 : 0)).map((h) => {
          const end = new Date(+h.start + 3600000);
          const hm = (t) => t.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
          return { at: h.start, value: h.value, gap: !h.n, title: `${h.start.toLocaleDateString('pl-PL')} ${hm(h.start)}–${hm(end)}` };
        })
        : raw.map((r) => ({ at: new Date(r.created_at), value: r.data[m.key], title: fmtDate(r.created_at) }));
      // Przerwy w danych pokazujemy jasnoszarymi słupkami (na osi czasu: szarym polem).
      const gapInfo = hourly ? null : findGaps(pts.map((p) => +p.at));
      if (lim && gapInfo.gaps.length) {
        for (const [a, b] of [...gapInfo.gaps].reverse()) {
          const i = pts.findIndex((p) => +p.at === b);
          pts.splice(i, 0, { at: new Date(a), gap: true, value: null, title: `Brak danych: ${fmtDate(a)} – ${fmtDate(b)} (${fmtSpan(b - a)})` });
        }
      }
      const ctx = body.querySelector(`[data-chart="${CSS.escape(m.key)}"]`);
      // Wykres rzeczywisty ma prawdziwą oś czasu: pełne godziny zakresu, a przerwy w danych zostają puste.
      const xMin = fromH ? Date.now() - fromH * 3600000 : +(pts[0]?.at ?? Date.now());
      const xMax = Date.now() - toH * 3600000;
      // Na osi same godziny; przy zakresie dłuższym niż doba dodajemy dzień, żeby godziny się nie myliły.
      // Przy „ostatnich N odczytach” słupki stoją obok siebie (oś kategorii), bo mogą dzielić je sekundy albo dni.
      const cat = hourly || !!lim;
      // Pola bez danych na osi czasu, także przed pierwszym i po ostatnim odczycie w zakresie.
      const gapAreas = cat ? [] : [
        ...(pts.length && pts[0].at - xMin > gapInfo.limit ? [[xMin, +pts[0].at]] : []),
        ...gapInfo.gaps,
        ...(pts.length && xMax - pts.at(-1).at > gapInfo.limit ? [[+pts.at(-1).at, xMax]] : []),
      ];
      anyGap ||= gapAreas.length > 0 || pts.some((p) => p.gap);
      // Szary słupek ma wysokość najniższego słupka z danymi (pomijamy zera, bo byłby niewidoczny).
      const shown = pts.filter((p) => !p.gap && p.value != null && p.value > 0).map((p) => p.value);
      const gapTop = shown.length ? Math.min(...shown) : 1;
      const span = pts.length > 1 ? pts.at(-1).at - pts[0].at : 0;
      const multiDay = cat ? span > 86400000 : xMax - xMin > 86400000 + 60000;
      const tick = (t) => t.toLocaleString('pl-PL', multiDay
        ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
        : !hourly && span < 3600000 ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
      charts.push(new Chart(ctx, {
        type: 'bar',
        data: {
          labels: cat ? pts.map((p) => (p.gap && !hourly ? 'brak' : tick(p.at))) : undefined,
          datasets: [{
            // Najpierw słupki na dole osi; prawdziwe wartości wstawiamy, gdy układ strony się ustali (niżej).
            label: m.label, data: cat ? pts.map(() => null) : pts.map((p) => ({ x: +p.at, y: null })),
            backgroundColor: 'rgba(0,255,255,0.55)', hoverBackgroundColor: '#00ffff',
            borderColor: '#00ffff', borderWidth: { top: 2, left: 0, right: 0, bottom: 0 },
            borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom',
            categoryPercentage: 0.9, barPercentage: 0.85, grouped: false, order: 1,
          }, ...(cat ? [{
            label: 'Brak danych', data: pts.map(() => null), backgroundColor: GAP_COLOR, hoverBackgroundColor: 'rgba(205,210,218,0.5)',
            borderRadius: { topLeft: 3, topRight: 3 }, borderSkipped: 'bottom',
            categoryPercentage: 0.9, barPercentage: 0.85, grouped: false, order: 2,
          }] : [])],
        },
        plugins: [{
          id: 'gapAreas',
          beforeDatasetsDraw: (c) => {
            if (!gapAreas.length) return;
            const { ctx: g, chartArea: area, scales: { x } } = c;
            g.save(); g.fillStyle = GAP_COLOR;
            for (const [a, b] of gapAreas) {
              const l = Math.max(area.left, x.getPixelForValue(a)), r = Math.min(area.right, x.getPixelForValue(b));
              const top = Math.max(area.top, Math.min(area.bottom, c.scales.y.getPixelForValue(gapTop)));
              if (r > l) g.fillRect(l, top, r - l, area.bottom - top);
            }
            g.restore();
          },
        }],
        options: {
          responsive: true, maintainAspectRatio: false,
          // Słupki rosną od zera do wartości przez 3 sekundy po wejściu na wykresy.
          animation: { duration: 3000, easing: 'easeOutCubic' },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: {
              title: (items) => pts[items[0].dataIndex].title,
              label: (c) => (c.datasetIndex === 1 ? 'Brak danych' : `${fmtValue(m, c.parsed.y)}${m.unit ? ` ${m.unit}` : ''}`),
            } },
          },
          scales: {
            x: cat
              ? { ticks: { maxTicksLimit: 8, maxRotation: 0, color: '#8a8f99' }, grid: { display: false } }
              : {
                type: 'linear', min: xMin, max: xMax, offset: false,
                afterBuildTicks: (sc) => { sc.ticks = hourTicks(xMin, xMax).map((value) => ({ value })); },
                ticks: {
                  autoSkip: false, maxRotation: 0, color: '#8a8f99',
                  // Przy kilku dniach północ podpisujemy datą, pozostałe znaczniki samą godziną.
                  callback: (v) => { const t = new Date(v); return multiDay && !t.getHours() ? t.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' }) : t.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }); },
                },
                grid: { color: 'rgba(255,255,255,0.04)' },
              },
            y: {
              ticks: { color: '#8a8f99' }, grid: { color: 'rgba(255,255,255,0.07)' },
              beginAtZero: m.value_type === 'integer' || (hourly && COUNTER_KEYS.includes(m.key)),
              // Napięcie zawsze w tej samej skali, żeby wykresy dało się porównywać.
              ...(m.key === 'battery_voltage' ? { min: 10, max: 15 } : {}),
            },
          },
        },
      }));
      const chart = charts.at(-1);
      // Wzrost słupków od zera do wartości przez 3 s. Startujemy po ustaleniu układu,
      // bo zmiana rozmiaru wykresu w trakcie przerwałaby animację.
      setTimeout(() => {
        if (!chart.canvas?.isConnected) return;
        const ds = chart.data.datasets[0];
        if (cat) {
          ds.data = pts.map((p) => (p.gap && !hourly ? null : p.value));
          chart.data.datasets[1].data = pts.map((p) => (p.gap ? gapTop : null));
        }
        else {
          ds.data = pts.map((p) => ({ x: +p.at, y: p.value }));
          // Szerokość słupka z typowego odstępu między odczytami, żeby gęste dane nie zlewały się w jedną plamę.
          const gaps = pts.slice(1).map((p, i) => p.at - pts[i].at).sort((a, b) => a - b);
          const gap = gaps[Math.floor(gaps.length / 2)] || 3600000;
          const width = chart.chartArea.right - chart.chartArea.left;
          ds.barThickness = Math.max(1, Math.min(16, Math.floor((width * gap) / (xMax - xMin) * 0.8)));
        }
        chart.update();
      }, 150);
    });
    if (anyGap) body.querySelector('.charts').insertAdjacentHTML('afterend', `<p class="hint" style="margin-top:10px"><span class="gap-swatch"></span> Jasnoszare słupki i pola oznaczają brak danych z urządzenia w tym czasie.</p>`);
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
  if (typeSel) typeSel.onchange = load;
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
  // Strzałki działają od razu po wejściu w galerię, bez klikania w zdjęcie.
  const onKey = (e) => {
    if (!root.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (document.querySelector('.lightbox, .modal-bg')) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setPlaying(false); go(cur - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setPlaying(false); go(cur + 1); }
    else if (e.key === 'Escape') closeMenu();
  };
  document.addEventListener('keydown', onKey);
  addCleanup(() => document.removeEventListener('keydown', onKey));
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

// ── Zakładka: firmware (zdalna aktualizacja ESP32) ──

// Program ESP32 zapisuje w sobie datę kompilacji jako „CLOUDEA_FW_BUILD=Oct 31 2026 18:38:12”;
// numer wersji to z niej RRMMDDGGMM (2610311838), liczony tak samo w portal_esp32.ino.
// Starsze programy miały wpisany numer ręcznie: „CLOUDEA_FW_VERSION=2”.
const FW_BUILD = /CLOUDEA_FW_BUILD=([A-Z][a-z]{2}) +(\d{1,2}) \d\d(\d\d) (\d\d):(\d\d)/;
const FW_MARKER = /CLOUDEA_FW_VERSION=(\d{1,7})/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 2610311838 → „31.10.2026, 18:38”; małe numery (1, 2) zostają jak są.
function fmtFwVersion(v) {
  const s = String(v ?? '');
  if (!/^\d{10}$/.test(s)) return s;
  return `${s.slice(4, 6)}.${s.slice(2, 4)}.20${s.slice(0, 2)}, ${s.slice(6, 8)}:${s.slice(8, 10)}`;
}

async function removeFirmwareFiles(deviceIds) {
  if (!deviceIds.length) return;
  const rows = await q(sb.from('firmware_releases').select('storage_path, source_path').in('device_id', deviceIds));
  const paths = rows.flatMap((r) => [r.storage_path, r.source_path]).filter(Boolean);
  if (paths.length) await sb.storage.from(FW_BUCKET).remove(paths);
}

// Sprawdza wybrany plik .bin: czy to program ESP32, jaką ma wersję i czy zawiera klucz urządzenia.
async function inspectFirmware(file, deviceKey) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] !== 0xE9) return { error: 'To nie jest skompilowany program ESP32. Wgraj plik .bin (Arduino IDE: Szkic → Eksportuj skompilowany plik binarny), a nie .ino.' };
  const text = new TextDecoder('latin1').decode(buf);
  const b = text.match(FW_BUILD);
  const m = text.match(FW_MARKER);
  const pad = (n) => String(n).padStart(2, '0');
  let version = null;
  if (b && MONTHS.includes(b[1])) version = Number(`${b[3]}${pad(MONTHS.indexOf(b[1]) + 1)}${pad(b[2])}${b[4]}${b[5]}`);
  else if (m) version = Number(m[1]);
  return { version, hasKey: !!deviceKey && text.includes(deviceKey) };
}

async function tabFirmware(el, inv) {
  const devices = (await q(sb.from('devices').select('*').eq('investment_id', inv.id).order('created_at')))
    .filter((d) => typeOf(d.product_type).connected);
  if (!devices.length) {
    el.innerHTML = '<div class="empty glass">Ta inwestycja nie ma urządzeń łączących się ze stroną.</div>';
    return;
  }
  if (!devices.some((d) => d.id === el.fwDevice)) el.fwDevice = devices[0].id;
  const d = devices.find((x) => x.id === el.fwDevice);
  const rels = await q(sb.from('firmware_releases').select('*').eq('device_id', d.id).order('version', { ascending: false }));
  const latest = rels[0];
  const onDev = d.firmware_version;

  let status;
  if (onDev == null) status = '<span class="pill failed">nieznana</span> Urządzenie jeszcze nie zgłosiło wersji. Pierwszy program z aktualizacją zdalną trzeba wgrać przez kabel USB.';
  else if (latest && latest.version > onDev) status = `<span class="pill new">czeka na pobranie</span> Na urządzeniu jest wersja ${fmtFwVersion(onDev)}, na stronie ${fmtFwVersion(latest.version)}. ESP32 pobierze ją przy najbliższym sprawdzeniu (co minutę).`;
  else status = `<span class="pill done">aktualne</span> Na urządzeniu jest wersja ${fmtFwVersion(onDev)}.`;

  el.innerHTML = `
    <div class="panel glass" style="margin-bottom:16px">
      <div class="gal-head">
        <div class="grow"><h2>Firmware</h2>
          <p class="hint" style="margin:0">Zdalna aktualizacja programu ESP32. Wgraj skompilowany plik <b>.bin</b> (Arduino IDE: Szkic → Eksportuj skompilowany plik binarny). Urządzenie co minutę sprawdza, czy jest nowsza wersja, samo ją pobiera i uruchamia się ponownie.</p></div>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <label class="lbl">Urządzenie
          <select class="inp" id="fw-dev">${devices.map((x) => `<option value="${x.id}"${x.id === d.id ? ' selected' : ''}>${esc(x.name || typeOf(x.product_type).name)} · ${esc(x.device_key)}</option>`).join('')}</select></label>
      </div>
      <p class="run-last" style="margin:12px 0 0">${status}${d.firmware_checked_at ? ` <span class="sub">Ostatnie sprawdzenie: ${esc(fmtDate(d.firmware_checked_at))}.</span>` : ''}</p>
    </div>

    <div class="panel glass" style="margin-bottom:16px">
      <h2>Wgraj nową wersję</h2>
      <form id="fw-form" class="list">
        <div class="form-grid">
          <label class="lbl">Program .bin (wymagany)<input class="inp" type="file" name="bin" accept=".bin,application/octet-stream" required></label>
          <label class="lbl">Kopia źródła .ino (opcjonalnie)<input class="inp" type="file" name="ino" accept=".ino,.txt,text/plain"></label>
          <label class="lbl">Numer wersji (z daty kompilacji)<input class="inp" type="number" name="version" min="1" max="9999999999" step="1" required readonly placeholder="odczytam z pliku .bin"></label>
        </div>
        <label class="lbl">Opis zmian (opcjonalnie)<input class="inp" name="notes" maxlength="500" placeholder="np. miganie diody co 1 s"></label>
        <p class="hint" id="fw-check" style="margin:0">Numer wersji odczytam z pliku .bin: to data i godzina kompilacji, np. 2610311838 = 31.10.2026, 18:38.</p>
        <div class="svc-actions"><button class="btn primary" type="submit">${icon('upload', 16)} Wgraj na stronę</button></div>
      </form>
    </div>

    <div class="panel glass">
      <h2>Wersje na stronie</h2>
      ${rels.length ? `<div class="docs">${rels.map((r) => `
        <div class="doc" data-rel="${r.id}">
          <div class="doc-icon">${icon('cpu', 22)}<span>BIN</span></div>
          <div class="grow" style="min-width:0">
            <div class="title">Wersja ${esc(fmtFwVersion(r.version))}${r.version > 99999 ? ` <span class="sub">(${r.version})</span>` : ''}${r === latest ? ' · najnowsza' : ''}${onDev === r.version ? ' · na urządzeniu' : ''}</div>
            <div class="sub">${esc(r.file_name)} · ${esc(fmtSize(r.size_bytes))} · dodano ${esc(fmtDate(r.created_at))}${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
          </div>
          <button class="btn icon ghost sm" type="button" data-get="bin" title="Pobierz .bin">${icon('download', 15)}</button>
          ${r.source_path ? `<button class="btn sm" type="button" data-get="ino" title="Pobierz kopię źródła">${icon('file', 15)} .ino</button>` : ''}
          <button class="btn icon ghost sm" type="button" data-del title="Usuń">${icon('trash', 15)}</button>
        </div>`).join('')}</div>` : '<p class="hint">Nie wgrano jeszcze żadnej wersji dla tego urządzenia.</p>'}
    </div>`;

  el.querySelector('#fw-dev').onchange = (e) => { el.fwDevice = e.target.value; tabFirmware(el, inv); };

  el.querySelectorAll('[data-rel]').forEach((row) => {
    const r = rels.find((x) => x.id === row.dataset.rel);
    row.querySelectorAll('[data-get]').forEach((b) => {
      b.onclick = async () => {
        const ino = b.dataset.get === 'ino';
        const { data, error } = await sb.storage.from(FW_BUCKET).createSignedUrl(ino ? r.source_path : r.storage_path, 600, { download: ino ? r.source_name : r.file_name });
        if (error) return fail(error);
        const a = document.createElement('a'); a.href = data.signedUrl; a.click();
      };
    });
    row.querySelector('[data-del]').onclick = async () => {
      if (!await confirmDialog('Usunąć wersję?', `Wersja ${fmtFwVersion(r.version)} zostanie usunięta ze strony. Urządzenie, które już ją ma, nie zmieni programu.`)) return;
      try {
        await q(sb.from('firmware_releases').delete().eq('id', r.id));
        await sb.storage.from(FW_BUCKET).remove([r.storage_path, r.source_path].filter(Boolean));
        tabFirmware(el, inv);
      } catch (e) { fail(e); }
    };
  });

  const form = el.querySelector('#fw-form');
  const check = el.querySelector('#fw-check');
  let info = null;
  form.bin.onchange = async () => {
    info = null;
    const file = form.bin.files[0];
    if (!file) return;
    info = await inspectFirmware(file, d.device_key);
    if (info.error) { check.textContent = info.error; check.style.color = '#fecaca'; return; }
    check.style.color = '';
    form.version.readOnly = !!info.version;
    form.version.value = info.version || '';
    check.textContent = [
      info.version ? `W pliku jest wersja ${info.version} (${fmtFwVersion(info.version)}).` : 'Nie znalazłem w pliku numeru wersji (stary program?). Wpisz go ręcznie, taki sam jak w programie.',
      info.hasKey ? `Plik zawiera klucz ${d.device_key}.` : `Uwaga: w pliku nie ma klucza ${d.device_key}, to chyba program innego urządzenia.`,
    ].join(' ');
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const bin = form.bin.files[0];
    const ino = form.ino.files[0];
    const version = Number(form.version.value);
    if (!info) info = await inspectFirmware(bin, d.device_key);
    if (info.error) return toast(info.error, 'err');
    if (bin.size > MAX_FW_BYTES) return toast(`Plik jest za duży (maks. ${fmtSize(MAX_FW_BYTES)}).`, 'err');
    if (ino && ino.size > 1024 * 1024) return toast('Plik .ino jest za duży (maks. 1 MB).', 'err');
    if (rels.some((r) => r.version === version)) return toast(`Ta wersja (${fmtFwVersion(version)}) już jest na stronie. Wyeksportuj program jeszcze raz.`, 'err');
    if (onDev != null && version <= onDev) return toast(`Na urządzeniu jest już wersja ${fmtFwVersion(onDev)}. Nowa musi być nowsza, inaczej ESP32 jej nie pobierze.`, 'err');
    if (info.version && info.version !== version) {
      if (!await confirmDialog('Inny numer wersji', `W pliku jest wersja ${info.version}, a wpisano ${version}. ESP32 po aktualizacji zgłosi ${info.version} i może pobierać plik w kółko. Wgrać mimo to?`, 'Wgraj mimo to')) return;
    }
    if (!info.hasKey) {
      if (!await confirmDialog('Inny klucz urządzenia', `W pliku nie ma klucza ${d.device_key}. Jeśli to program innej płytki, po aktualizacji urządzenie zacznie wysyłać dane jako tamta płytka. Wgrać mimo to?`, 'Wgraj mimo to')) return;
    }

    const btn = form.querySelector('[type=submit]');
    btn.disabled = true; btn.lastChild.textContent = ' Wysyłanie…';
    const base = `${d.id}/${crypto.randomUUID()}`;
    const paths = [];
    try {
      const { error } = await sb.storage.from(FW_BUCKET).upload(`${base}.bin`, bin, { contentType: 'application/octet-stream' });
      if (error) throw error;
      paths.push(`${base}.bin`);
      if (ino) {
        const { error: e2 } = await sb.storage.from(FW_BUCKET).upload(`${base}.ino`, ino, { contentType: 'text/plain' });
        if (e2) throw e2;
        paths.push(`${base}.ino`);
      }
      await q(sb.from('firmware_releases').insert({
        device_id: d.id, version, storage_path: `${base}.bin`, file_name: bin.name.slice(0, 200), size_bytes: bin.size,
        source_path: ino ? `${base}.ino` : null, source_name: ino ? ino.name.slice(0, 200) : null, notes: form.notes.value.trim() || null,
      }));
      toast(`Wersja ${fmtFwVersion(version)} wgrana. ESP32 pobierze ją w ciągu minuty.`, 'ok');
      tabFirmware(el, inv);
    } catch (err) {
      if (paths.length) await sb.storage.from(FW_BUCKET).remove(paths);
      btn.disabled = false; btn.lastChild.textContent = ' Wgraj na stronę';
      fail(err);
    }
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
            ${u.role === 'pending' ? `<button class="btn sm primary" type="button" data-approve>${icon('check', 15)} Zatwierdź</button>` : `<select class="inp role-sel" data-role ${u.role === 'admin' && admins <= 1 ? 'disabled title="Musi zostać co najmniej jeden administrator"' : ''}>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrator</option>
              <option value="user" ${u.role === 'user' ? 'selected' : ''}>Użytkownik</option>
            </select>`}
            <button class="btn icon ghost sm" type="button" data-name title="Zmień nazwę">${icon('edit', 15)}</button>
            <button class="btn icon ghost sm" type="button" data-pass title="Ustaw nowe hasło">${icon('lock', 15)}</button>
            ${u.user_id === me ? '' : `<button class="btn icon ghost sm" type="button" data-del title="Usuń konto">${icon('trash', 15)}</button>`}
          </div>`).join('')}</div>` : '<div class="empty">Brak osób w tej grupie.</div>'}
      </section>`;
  };

  root.innerHTML = `
    ${topbar('Użytkownicy', `${users.length} ${users.length === 1 ? 'konto' : 'kont'} w bazie`, `<button class="btn primary" type="button" data-add>${icon('plus', 16)} Dodaj użytkownika</button>`)}
    ${usersTabs('konta')}
    ${users.some((u) => u.role === 'pending') ? group('pending', 'Oczekujące na zatwierdzenie', 'Osoby, które same założyły konto. Do czasu zatwierdzenia nie widzą żadnych danych. Zatwierdź (rola Użytkownik) albo usuń konto.') : ''}
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
    row.querySelector('[data-approve]')?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        await q(sb.from('profiles').update({ role: 'user' }).eq('user_id', u.user_id));
        toast(`${u.full_name || u.email}: konto zatwierdzone.`, 'ok');
        refreshPendingBadge();
        pageUsers(root);
      } catch (err) { e.currentTarget.disabled = false; fail(err); }
    });
    if (row.querySelector('[data-role]')) row.querySelector('[data-role]').onchange = async (e) => {
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
      try { await usersApi({ action: 'delete', user_id: u.user_id }); toast('Konto usunięte.', 'ok'); refreshPendingBadge(); pageUsers(root); } catch (err) { fail(err); }
    });
  });
}

// Zakładki strony Użytkownicy. Historię wejść widzi tylko właściciel portalu.
function usersTabs(active) {
  if (!state.isOwner) return '';
  return `<nav class="tabs glass" style="border-radius:999px">
    <a class="tab ${active === 'konta' ? 'active' : ''}" href="#/uzytkownicy">${icon('users', 16)} Konta</a>
    <a class="tab ${active === 'historia' ? 'active' : ''}" href="#/uzytkownicy/historia">${icon('clock', 16)} Historia wejść</a>
  </nav>`;
}

async function pageVisits(root) {
  document.title = 'Historia wejść · CloudEA';
  const visits = await q(sb.rpc('visit_log', { p_limit: 1000 }));
  const people = [...new Map(visits.map((v) => [v.user_id, v.full_name || v.email || 'Usunięte konto'])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'pl'));
  const day = (d) => { const t = new Date(d).toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return t[0].toUpperCase() + t.slice(1); };
  const time = (d) => new Date(d).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  root.innerHTML = `
    ${topbar('Użytkownicy', 'Historia wejść na stronę, widoczna tylko dla Ciebie')}
    ${usersTabs('historia')}
    <section class="panel glass">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:12px">
        <label class="lbl" style="min-width:240px">Osoba<select class="inp" id="v-user">
          <option value="">Wszyscy</option>
          ${people.map(([uid, name]) => `<option value="${esc(uid)}">${esc(name)}</option>`).join('')}
        </select></label>
      </div>
      <div id="v-body"></div>
      <p class="hint" style="margin-top:10px">Każde otwarcie lub odświeżenie strony przez zalogowaną osobę to jeden wpis. Pokazano do 1000 najnowszych, wpisy starsze niż rok są usuwane.</p>
    </section>`;
  bindTopbar(root);

  const body = root.querySelector('#v-body');
  const draw = () => {
    const uid = root.querySelector('#v-user').value;
    const list = uid ? visits.filter((v) => v.user_id === uid) : visits;
    if (!list.length) { body.innerHTML = '<div class="empty">Brak wejść.</div>'; return; }
    let last = '';
    body.innerHTML = `<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Godzina</th><th>Osoba</th><th>Urządzenie</th></tr></thead>
      <tbody>${list.map((v) => {
        const d = day(v.visited_at);
        const head = d !== last ? `<tr class="day-row"><td colspan="3">${esc(d)}</td></tr>` : '';
        last = d;
        return `${head}<tr><td>${esc(time(v.visited_at))}</td><td>${esc(v.full_name || v.email || 'Usunięte konto')}${v.full_name && v.email ? ` <span style="color:var(--muted)">· ${esc(v.email)}</span>` : ''}</td><td>${esc(v.device || '')}</td></tr>`;
      }).join('')}</tbody>
    </table></div>`;
  };
  root.querySelector('#v-user').onchange = draw;
  draw();
}

if (window.Chart) {
  Chart.defaults.color = '#a3a7b0';
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
}

boot().catch(fail);
