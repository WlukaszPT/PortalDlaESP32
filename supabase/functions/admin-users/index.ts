// Zakładanie i usuwanie kont użytkowników portalu.
// Wymaga klucza serwisowego, dlatego działa po stronie Supabase, a nie w przeglądarce.
// Wywołać może tylko zalogowany administrator (sprawdzane w tabeli profiles).
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, { error: 'Dozwolona jest tylko metoda POST.' });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Kto wywołuje?
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return reply(401, { error: 'Zaloguj się ponownie.' });
  const { data: me } = await admin.from('profiles').select('role').eq('user_id', who.user.id).maybeSingle();
  if (me?.role !== 'admin') return reply(403, { error: 'Tylko administrator może zarządzać użytkownikami.' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'Nieprawidłowe dane.' }); }

  if (body.action === 'create') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const fullName = String(body.full_name ?? '').trim().slice(0, 120);
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: 'Podaj poprawny adres e-mail.' });
    if (password.length < 8) return reply(400, { error: 'Hasło musi mieć co najmniej 8 znaków.' });

    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: fullName },
    });
    if (error) {
      const exists = /already|registered|exists/i.test(error.message);
      return reply(400, { error: exists ? 'Konto z tym adresem e-mail już istnieje.' : error.message });
    }
    // Profil tworzy wyzwalacz w bazie; tu ustawiamy rolę i nazwę.
    const { error: pErr } = await admin.from('profiles')
      .upsert({ user_id: data.user.id, email, full_name: fullName || null, role });
    if (pErr) return reply(500, { error: pErr.message });
    return reply(200, { ok: true, user_id: data.user.id });
  }

  if (body.action === 'delete') {
    const userId = String(body.user_id ?? '');
    if (userId === who.user.id) return reply(400, { error: 'Nie możesz usunąć własnego konta.' });
    const { data: target } = await admin.from('profiles').select('role').eq('user_id', userId).maybeSingle();
    if (!target) return reply(404, { error: 'Nie ma takiego użytkownika.' });
    if (target.role === 'admin') {
      const { count } = await admin.from('profiles').select('user_id', { count: 'exact', head: true }).eq('role', 'admin');
      if ((count ?? 0) <= 1) return reply(400, { error: 'Musi zostać co najmniej jeden administrator.' });
    }
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) return reply(500, { error: error.message });
    return reply(200, { ok: true });
  }

  if (body.action === 'reset_password') {
    const userId = String(body.user_id ?? '');
    const password = String(body.password ?? '');
    if (password.length < 8) return reply(400, { error: 'Hasło musi mieć co najmniej 8 znaków.' });
    const { error } = await admin.auth.admin.updateUserById(userId, { password });
    if (error) return reply(400, { error: error.message });
    return reply(200, { ok: true });
  }

  return reply(400, { error: 'Nieznana operacja.' });
});
