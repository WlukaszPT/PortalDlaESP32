-- Usunięcie funkcji „Wiadomość serwera” (Łukasz: nieprzydatna). ESP32 już jej nie pobiera,
-- a zakładka zniknęła ze strony. Usuwamy funkcję dla ESP32, strażnika zmian i kolumny.

drop trigger if exists investments_guard_message on public.investments;
drop function if exists public.investments_guard_message();
drop function if exists public.device_get_message(text);

alter table public.investments
    drop column if exists server_message,
    drop column if exists server_message_at;
