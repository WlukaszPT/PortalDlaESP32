# Portal dla ESP32

Strona www z bazą danych do dwukierunkowej komunikacji z mikrokontrolerem ESP32:

- **ESP32 → strona:** ESP32 wysyła odczyty do bazy danych, a strona je wyświetla.
- **Strona → ESP32:** strona zapisuje w bazie małe paczki danych (do kilku kB), które ESP32 cyklicznie odbiera.

Całość działa na darmowych usługach: **Supabase** (baza Postgres z API) i **GitHub Pages** (hosting strony).

## Struktura repozytorium

| Katalog | Zawartość |
|---|---|
| `web/` | Strona www (HTML/JS), publikowana na GitHub Pages |
| `firmware/portal_esp32/` | Program dla ESP32 (Arduino IDE / PlatformIO) |
| `supabase/migrations/` | Migracje SQL bazy Supabase (tabele, uprawnienia, funkcje), wgrywane automatycznie z gałęzi `main` |
| `docs/` | Dokumentacja i plan projektu |

## Plan

Pełny plan realizacji krok po kroku: [docs/plan-projektu.md](docs/plan-projektu.md).

## Dane dostępowe

Klucze i hasła nie trafiają do repozytorium:

- ESP32: skopiuj `firmware/portal_esp32/secrets.example.h` jako `secrets.h` i uzupełnij (plik `secrets.h` jest ignorowany przez git).
- Strona www używa wyłącznie publicznego klucza `anon` Supabase, chronionego regułami RLS w bazie. Klucza `service_role` nigdy nie umieszczamy w kodzie.
