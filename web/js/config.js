// Publiczne dane projektu Supabase. Klucz "publishable" jest jawny z założenia:
// dostęp do danych chronią logowanie i reguły RLS w bazie.
// Klucza "secret"/"service_role" NIGDY tu nie wpisujemy.
export const SUPABASE_URL = 'https://fcpzfjvtrxczmmdezfpw.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_O2M3Y5q3lCnjwxJmRqvNIA_00tsGQiE';

export const PHOTO_BUCKET = 'investment-photos';
export const MAX_PHOTOS = 5;
export const DOC_BUCKET = 'investment-docs';
export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_COMMAND_BYTES = 8192;
// Urządzenie uznajemy za online, jeśli odezwało się w ciągu tylu minut.
export const ONLINE_MINUTES = 15;
