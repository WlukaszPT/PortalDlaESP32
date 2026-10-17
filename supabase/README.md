# Baza danych (Supabase)

Skrypty SQL (tabele, reguły bezpieczeństwa RLS, funkcje dla ESP32) trzymamy jako migracje w `supabase/migrations/`. Powstaną w krokach 2 i 3 planu.

Projekt Supabase jest połączony z tym repozytorium (Integrations → GitHub, Working directory `.`, gałąź `main`), więc po scaleniu zmian do `main` Supabase sam wgrywa nowe migracje do bazy. Awaryjnie każdy plik można też uruchomić ręcznie w panelu: **SQL Editor → New query**.

## Funkcje (Edge Functions)

- `service_entries.cost` (migracja `20261011170000_serwis_koszt.sql`) – koszt prac przy wpisie serwisowym; suma pokazywana jako „Łączny koszt” w zakładce **Serwis**.
- Rejestracja (migracja `20261011200000_rejestracja.sql`) – nowe konto dostaje rolę `pending` i do zatwierdzenia przez administratora nie widzi żadnych danych (polityki RESTRICTIVE z `is_member()` na wszystkich tabelach i plikach). Wymaga włączenia „Allow new users to sign up” w ustawieniach Authentication.
- `log_visit()`, `visit_log()`, `is_owner()` (migracja `20261012200000_historia_wejsc.sql`) – historia wejść na stronę w tabeli `page_visits`. Zapis woła strona po każdym otwarciu, odczyt jest tylko dla właściciela portalu z tabeli `app_owner` (pierwsze konto w bazie). Obie tabele są niedostępne przez API wprost; wpisy starsze niż rok są usuwane.
- `readings_sample()` (migracja `20261012150000_probkowanie_odczytow.sql`) – odczyty do wykresów z całego okresu; przy ponad 2000 odczytów zwraca co n-ty (z pierwszym i ostatnim). Działa z uprawnieniami wywołującego (RLS).
- `cleanup_readings()` (migracja `20261017210000_czyszczenie_odczytow.sql`) – codziennie o 2:15 UTC (harmonogram `pg_cron`, zadanie `czyszczenie-odczytow`) usuwa odczyty starsze niż 180 dni i najstarsze ponad 1 mln, żeby baza nie przekroczyła 500 MB. Niedostępna przez API.
- `storage_stats()` (migracja `20261011150000_hurtownia_danych.sql`) – rozmiar bazy, tabel i plików dla zakładki **Hurtownia danych**; tylko dla zalogowanych.
- `functions/admin-users` – zakładanie, usuwanie kont i ustawianie nowego hasła z zakładki **Użytkownicy**. Używa klucza serwisowego dostępnego tylko po stronie Supabase; wywołać może wyłącznie zalogowany administrator (sprawdza tabelę `profiles`).
