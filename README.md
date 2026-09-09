# Omikro Website

Die Website ist das erste Projekt unter `~/Work/websites`. Weitere Websites
koennen spaeter jeweils als eigener Ordner daneben angelegt werden:

```text
~/Work/
└── websites/
    ├── omikro/
    └── weiteres-projekt/
```

## Lokal starten

Im Projektordner ausfuehren:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Danach ist die Website unter <http://127.0.0.1:8080> erreichbar. Der Server
wird mit `Ctrl+C` beendet.

## Routen

- `/` — Startseite mit Omikro-Schriftzug
- `/pond.html` — interaktive Pond-Experience (Wellen per Zeiger, Wogen per Klick)
