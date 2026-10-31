// Pobieranie programu (.bin) przez ESP32 przy zdalnej aktualizacji (OTA).
// ESP32 wysyła POST {"key": "PL-123456789", "version": 3} – klucz urządzenia jest jedynym
// zabezpieczeniem, tak jak w funkcjach device_* w bazie. Plik leży w prywatnym koszyku
// device-firmware, więc czytamy go kluczem serwisowym, który jest tylko po stronie Supabase.
import { createClient } from 'npm:@supabase/supabase-js@2.117.2';

const BUCKET = 'device-firmware';

const reply = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, 'Dozwolona jest tylko metoda POST.');

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, 'Nieprawidłowe dane.'); }
  const key = String(body.key ?? '');
  const version = Number(body.version);
  if (!/^PL-[0-9]{9}$/.test(key) || !Number.isInteger(version) || version < 1) return reply(400, 'Podaj klucz urządzenia i wersję.');

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: file, error } = await admin.rpc('device_firmware_file', { p_key: key, p_version: version });
  if (error) return reply(error.code === '28000' ? 403 : 500, error.code === '28000' ? 'Nieznany klucz urządzenia.' : 'Błąd bazy danych.');
  if (!file?.path) return reply(404, 'Nie ma takiej wersji programu dla tego urządzenia.');

  const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(file.path);
  if (dlErr || !blob) return reply(500, 'Nie udało się odczytać pliku.');

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
      'X-Firmware-Version': String(file.version),
      'Cache-Control': 'no-store',
    },
  });
});
