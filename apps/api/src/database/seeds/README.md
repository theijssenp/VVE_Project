# Seeds (F03, spec §7.2: `database/seeds`)

Deze map bevat de seed-kern voor de applicatie — referentie- en startdata
(e.g. modelreglementen, standaard-communicatiekanalen, demo-VvE's).

In F03 is de map **bewust leeg**: er is nog geen domein-data om te zaden,
want de tabellen `vve` en `persoon` alleen nog het kerndatamodel bevatten
(spec §6.3) en geen business-data. Seeds komen zodra een latere fase
werkelijke referentiedata nodig heeft.

De seed-uitvoering (indien/als er iets te zaden is) zou dezelfde
`DATABASE_URL`-conventie volgen als de migratierunner
(`src/database/run-migraties.ts`) — geen secret uit de source, alleen uit
de omgeving (spec §7.9).
