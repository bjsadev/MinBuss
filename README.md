# MinBuss

Enkel og oversiktlig app for dine faste reiser med buss, bybane/trikk, tog, T-bane og båt i hele Norge.
Den kjører som nettside og kan installeres på iPhone som app (PWA). All data kommer fra
[Enturs åpne API-er](https://developer.entur.no/apis/open).

## Funksjoner

- **Avganger** – ett kort per favorittholdeplass med neste avganger i sanntid
  - Gruppert per linje og retning (neste avgang stort, de to neste små) eller som kronologisk liste
  - Sanntidsindikator, forsinkelse (rutetid gjennomstreket), innstilte avganger, avvik, plattform/spor og belegg
  - Oppdateres hvert 30. sekund, og nedtellingen går lokalt mellom hver henting
- **Sanntidskart** – viser hvor kjøretøyene på favorittlinjene dine er akkurat nå
  - Merker i linjefargen med linjenummer og en pil som viser kjøreretningen, og myk animasjon mellom posisjoner
  - Linjetraséene tegnes inn, og favorittholdeplassene vises på kartet
  - Linjefilter-chips med antall kjøretøy, «min posisjon» og «vis alle»
  - Mørkt kart i mørk modus
- **Favoritter**
  - Søk etter holdeplasser/stasjoner/kaier, eller finn holdeplasser **nær meg**
  - Søk etter linjer på nummer eller navn, eller trykk på en avgang for å legge linjen til direkte
  - Filtrer en holdeplass til utvalgte linjer eller kun favorittlinjer
  - Endre rekkefølge, skjul linjer i kartet og fjern
- Lys/mørk modus, safe-area-støtte for iPhone og offline-skall via service worker
- Ingen innlogging: favorittene lagres lokalt på enheten (localStorage)

## Kom i gang

Appen er ren HTML/CSS/JS uten byggesteg.

```bash
python3 -m http.server 8080
# åpne http://localhost:8080
```

### Publisering

`.github/workflows/pages.yml` publiserer appen til GitHub Pages ved push til `main`
(slå på *Settings → Pages → Source: GitHub Actions* i repoet).

### Installer på iPhone

1. Åpne nettadressen i Safari.
2. Trykk Del-knappen → **Legg til på Hjem-skjerm**.
3. Appen starter da i fullskjerm med eget ikon, akkurat som en vanlig app.

> Vil du ha en ekte App Store-app, kan den samme koden pakkes med
> [Capacitor](https://capacitorjs.com/) (`npx cap add ios`). Da trengs ingen omskriving.

## Arkitektur

```
index.html            App-skall, tabbar og bottom sheet
styles.css            Design (lys/mørk, iOS-vennlig)
js/api.js             Entur-klient (GraphQL + REST)
js/store.js           Favoritter i localStorage
js/ui.js              Felles visning: transportmidler, linjemerker, tid
js/map.js             Sanntidskart (Leaflet)
js/app.js             Visninger, søk og interaksjon
sw.js                 Service worker (cacher app-skallet, aldri sanntidsdata)
manifest.webmanifest  PWA-manifest
```

### Entur-API-er som brukes

| Formål | API | Endepunkt |
| --- | --- | --- |
| Søk etter holdeplass / nær meg | Geocoder v1 | `api.entur.io/geocoder/v1/autocomplete`, `/reverse` |
| Avganger (sanntid), linjer på holdeplass, linjesøk, traséer | Journey Planner v3 (GraphQL) | `api.entur.io/journey-planner/v3/graphql` |
| Kjøretøyposisjoner (GPS) | Vehicles v2 (GraphQL) | `api.entur.io/realtime/v2/vehicles/graphql` (spørring)<br>`wss://api.entur.io/realtime/v2/vehicles/subscriptions` (abonnement) |

- Alle kall sender `ET-Client-Name: minbuss-web`, slik Entur krever. Sett ditt eget navn i
  `js/api.js` (`CLIENT_NAME`) hvis du publiserer appen.
- Avganger for alle holdeplasser hentes i én GraphQL-spørring (med alias). Linjefiltre sendes som
  `whiteListed: { lines: [...] }`.
- Kjøretøyposisjoner strømmes live via GraphQL-abonnement (`graphql-transport-ws`) mens kartet er synlig.
  En vanlig spørring henter hele bildet hvert 30. sekund og fjerner kjøretøy som er borte. Hvis strømmen
  ikke kommer i gang, hentes posisjonene hvert 10. sekund i stedet.
- Kjøretøyposisjoner finnes bare for operatører som deler dem med Entur (blant annet Skyss, Ruter,
  AtB og Kolumbus). Linjer uten slike data får en melding i kartet.
- Entur-MCP-serverne (Journey Planner og transitdata) er brukt under utviklingen for å kontrollere
  datamodeller og ID-er. Selve appen snakker direkte med de åpne API-ene, så den trenger ingen
  server eller nøkkel.

## Lisens og kreditering

Data © Entur, lisensiert under [NLOD](https://data.norge.no/nlod/no/2.0). Kart © OpenStreetMap-bidragsytere, © CARTO.
