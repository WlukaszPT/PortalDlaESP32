# Komunikacja ESP32 ↔ baza

ESP32 nie ma dostępu do tabel. Rozmawia z bazą tylko przez cztery funkcje, podając swój klucz `PL-123456789`.

Każde wywołanie to `POST {SUPABASE_URL}/rest/v1/rpc/<funkcja>` z nagłówkami:

```
apikey: <SUPABASE_ANON_KEY>
Content-Type: application/json
```

| Funkcja | Treść (JSON) | Odpowiedź |
|---|---|---|
| `device_get_config` | `{"p_key": "PL-123456789"}` | `{"metrics": [{"key": "battery_voltage", "type": "number", "allowed": null}, ...]}`: dane włączone na stronie |
| `device_push_reading` | `{"p_key": "...", "p_data": {"battery_voltage": 12.6, "activations": 15}}` | `{"accepted": [...], "rejected": [...]}` |
| `device_fetch_commands` | `{"p_key": "..."}` | `[{"id": 1, "payload": {...}, "created_at": "..."}]`: nowe polecenia, oznaczane jako odebrane |
| `device_ack_command` | `{"p_key": "...", "p_command_id": 1, "p_ok": true, "p_result": "ok"}` | pusta (204) |

Zasady:

- Każde wywołanie z poprawnym kluczem aktualizuje `last_seen` (status online na stronie).
- Odczyt: maks. 4 kB, najwyżej jeden na 10 sekund. Zapisywane są tylko dane włączone dla urządzenia i o poprawnym typie (`integer`, `number`, `text` do 200 znaków, `enum` z listy).
- Polecenia: maks. 10 na raz, w kolejności dodania. Po wykonaniu ESP32 potwierdza je przez `device_ack_command`.
- Zły klucz lub urządzenie informacyjne (Lite4, aktywne/pasywne doświetlenie) zwraca błąd 403.
