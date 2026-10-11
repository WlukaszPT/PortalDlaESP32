# Baza danych (Supabase)

Skrypty SQL (tabele, reguły bezpieczeństwa RLS, funkcje dla ESP32) trzymamy jako migracje w `supabase/migrations/`. Powstaną w krokach 2 i 3 planu.

Projekt Supabase jest połączony z tym repozytorium (Integrations → GitHub, Working directory `.`, gałąź `main`), więc po scaleniu zmian do `main` Supabase sam wgrywa nowe migracje do bazy. Awaryjnie każdy plik można też uruchomić ręcznie w panelu: **SQL Editor → New query**.

## Funkcje (Edge Functions)

- `functions/admin-users` – zakładanie, usuwanie kont i ustawianie nowego hasła z zakładki **Użytkownicy**. Używa klucza serwisowego dostępnego tylko po stronie Supabase; wywołać może wyłącznie zalogowany administrator (sprawdza tabelę `profiles`).
