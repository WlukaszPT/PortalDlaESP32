# Strona www

Statyczna strona (HTML, CSS, JavaScript bez kompilacji) korzystająca z Supabase przez `supabase-js`.

| Plik | Zawartość |
|---|---|
| `index.html` | szkielet strony, biblioteki z CDN (supabase-js, Leaflet, Chart.js) |
| `css/style.css` | wygląd: ciemny motyw „szklany”, pomarańczowy akcent |
| `js/config.js` | adres projektu Supabase i publiczny klucz `publishable` |
| `js/icons.js` | ikony SVG |
| `js/app.js` | cała logika: logowanie, menu, pulpit, inwestycje, urządzenia, odczyty, galeria, lokalizacja |

## Ekrany

- **Logowanie** – e-mail i hasło (rejestracja wyłączona, konta zakłada administrator w Supabase), reset hasła mailem.
- **Pulpit** – liczba inwestycji i urządzeń, ile jest online, odczyty z 24 h, mapa i ostatnie odczyty.
- **Inwestycje** – lista z wyszukiwaniem, dodawanie, edycja, usuwanie.
- **Inwestycja** – zakładki:
  - *Urządzenia*: dodawanie produktów, klucz `PL-…` do skopiowania, włączanie/wyłączanie danych, ostatnie wartości, wysyłanie danych JSON do ESP32 i historia,
  - *Odczyty*: wykresy, tabela, eksport CSV,
  - *Galeria*: do 5 zdjęć (prywatne, zmniejszane przed wysłaniem),
  - *Lokalizacja*: współrzędne i mapa z pinezką.
- **Mapa** – wszystkie inwestycje na mapie Polski.

## Uruchomienie lokalnie

```bash
npx http-server web -p 8080
```

i otwórz http://localhost:8080.

## Publikacja

Workflow `.github/workflows/pages.yml` publikuje folder `web/` na GitHub Pages po każdej zmianie na `main`.
Jednorazowo trzeba włączyć: **Settings → Pages → Source: GitHub Actions**.

W `config.js` jest tylko klucz publiczny. Klucza `secret` / `service_role` nigdy nie wpisujemy do strony.
