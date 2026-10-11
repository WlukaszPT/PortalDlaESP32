# Strona www

Statyczna strona (HTML, CSS, JavaScript bez kompilacji) korzystająca z Supabase przez `supabase-js`.

| Plik | Zawartość |
|---|---|
| `index.html` | szkielet strony, biblioteki z CDN (supabase-js, Leaflet, Chart.js) |
| `css/style.css` | wygląd: ciemny motyw „szklany”, akcent w kolorze #00FFFF, tło ze zdjęciem drogi |
| `js/config.js` | adres projektu Supabase i publiczny klucz `publishable` |
| `js/icons.js` | ikony SVG |
| `js/app.js` | cała logika: logowanie, menu, pulpit, inwestycje, urządzenia, odczyty, galeria, lokalizacja |

## Ekrany

- **Logowanie** – e-mail i hasło (rejestracja wyłączona, konta zakłada administrator w Supabase), reset hasła mailem.
- **Pulpit** – liczba inwestycji i urządzeń, ile jest online, odczyty z 24 h, mapa i ostatnie odczyty.
- **Inwestycje** – lista z wyszukiwaniem, dodawanie, edycja, usuwanie.
- **Inwestycja** – zakładki:
  - *Urządzenia*: dodawanie produktów, klucz `PL-…` do skopiowania, włączanie/wyłączanie danych, ostatnie wartości, przycisk „Uruchom przejście” (wysyła do ESP32 polecenie `{"turn on": true}`, które sterownik odbiera przez `device_fetch_commands`) ze statusem ostatniego uruchomienia,
  - *Wykresy*: wykresy danych liczbowych, zakres od 20 ostatnich odczytów (domyślnie) i ostatniej godziny do 30 dni, eksport CSV, typ wykresu rzeczywisty lub godzinowy (średnia z godziny, a dla liczników przyrost w godzinie),
  - *Dane rzeczywiste*: tabela wszystkich odczytów w wybranym zakresie, eksport CSV,
  - *Galeria*: karuzela do 5 zdjęć (prywatne, zmniejszane przed wysłaniem),
  - *Lokalizacja*: współrzędne i mapa z pinezką,
  - *Serwis*: historia napraw (data, opis, kto wpisał),
  - *Dokumentacja*: pliki PDF (prywatne, do 20 MB każdy).
- **Mapa** – wszystkie inwestycje na mapie Polski.
- **Hurtownia danych** – ile miejsca zajmuje baza (limit 500 MB) i pliki (limit 1 GB) w darmowym planie, % wolnego miejsca, co zajmuje najwięcej i na jak długo wystarczy miejsca przy obecnym tempie odczytów. Dane z funkcji `storage_stats()`.
- **Rejestracja** – link „Zarejestruj się” w panelu logowania; nowe konto widzi tylko ekran „Konto czeka na zatwierdzenie”.
- **Użytkownicy** (tylko administrator) – lista kont z podziałem na oczekujące (przycisk Zatwierdź), administratorów i użytkowników, zmiana roli, dodawanie, reset hasła, usuwanie.

## Role

| | Administrator | Użytkownik |
|---|---|---|
| Podgląd wszystkiego | ✓ | ✓ |
| Wpisy serwisowe | dodaje, zmienia i usuwa wszystkie | dodaje, zmienia i usuwa własne |
| Zdjęcia i dokumenty | dodaje, zmienia, usuwa | dodaje |
| Inwestycje, lokalizacja, urządzenia, wybór danych | ✓ | – |
| Uruchom przejście (polecenie dla ESP32) | ✓ | – |
| Zarządzanie użytkownikami | ✓ | – |

Uprawnienia pilnuje baza (reguły RLS), strona tylko ukrywa niedostępne przyciski.
Konta zakłada funkcja `supabase/functions/admin-users` (potrzebuje klucza serwisowego, więc działa w Supabase, nie w przeglądarce).
Wyszukiwanie adresu korzysta z bezpłatnej wyszukiwarki OpenStreetMap (Nominatim).

## Uruchomienie lokalnie

```bash
npx http-server web -p 8080
```

i otwórz http://localhost:8080.

## Publikacja

Workflow `.github/workflows/pages.yml` publikuje folder `web/` na GitHub Pages po każdej zmianie na `main`.
Jednorazowo trzeba włączyć: **Settings → Pages → Source: GitHub Actions**.

W `config.js` jest tylko klucz publiczny. Klucza `secret` / `service_role` nigdy nie wpisujemy do strony.
