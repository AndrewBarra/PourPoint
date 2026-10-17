# PourPoint

Log and rate cocktail bars, pinned on a map. PourPoint is a static web app: plain HTML, CSS and JavaScript modules, with no framework, no build step, no backend and no API keys. It works on phones and desktops and can be installed to your home screen.

## Features

- **Map of your bars.** OpenStreetMap tiles via Leaflet 1.9.4 (bundled in `vendor/leaflet/`). The map starts on the whole US, and the **US** button zooms back out to it. Each saved bar gets a pin colored by its overall score: gold 9–10, green 7–8.9, orange 5–6.9, red under 5, gray when not rated. Clicking a pin opens a popup with the name, the score and a button to the bar's page.
- **Search as you type.** By default, results come from [Photon](https://photon.komoot.io/), limited to OpenStreetMap places tagged `amenity=bar` or `amenity=pub` and biased toward the current map center. If you add a Google Places API key in **Settings**, searches use Google instead, which lists many more bars (see [Google Places search](#google-places-search-optional)). The search waits 300 ms after you stop typing and cancels any request still in flight. Picking a result saves the bar. If you already saved it, its page opens instead, so you don't get duplicates.
- **Add a bar yourself.** The last row of the dropdown, "Can't find it? Add it yourself", opens a form for name, street, city, state and ZIP. When you save, the address is looked up with [Nominatim](https://nominatim.openstreetmap.org/). If the exact address isn't found, the pin goes at the center of the city and the bar's page says so. **Move pin** lets you drag any pin to the right spot.
- **10-star ratings** in five categories: Drinks, Location, Food, Ambiance, Service. Any category can be left as "not rated". The overall score is the average of the rated categories, shown to one decimal place (for example, 8.4/10).
- **Bar details:** date visited, notes (saved as you type) and any number of photos.
- **Drinks:** name, 1–10 star rating, notes, optional price, optional base spirit and photos. You can add, edit and delete drinks. A bar's page lists its drinks from highest to lowest rating.
- **Photos** come from the camera or the photo library. Each one is shrunk to at most 1600 px on its longest side (JPEG, quality 0.85) before it's stored. Tap a thumbnail to open the full-screen viewer (arrow keys or swipe to move between photos).
- **My bars:** filter by name and sort by overall score, name or most recent. Tap a bar to fly the map to it.
- **Top drinks** across all bars, sorted by rating.
- **Stats:** number of bars, number of drinks, average overall score and best category.
- **Backup** (in Settings): export everything, photos included, to a single JSON file, and import it on another device.

## Where your data lives

Everything is stored in **your browser's IndexedDB**, on your device, in three stores: `bars`, `drinks` and `photos` (photos are kept as JPEG blobs). Nothing is uploaded anywhere. The only network requests are map tiles, searches (Photon, or Google if you've added a key) and Nominatim lookups. A Google key is kept in the browser's local storage on that device only; it isn't in the repo or in backups.

The app calls `navigator.storage.persist()` to ask the browser not to clear this data when space runs low. The Stats tab shows whether the browser agreed. Data is still tied to one browser on one device, and clearing site data deletes it. **Use Export backup regularly**, and use Import backup to move your data to another device or browser. An import merges with what's already there: bars, drinks and photos with the same ID are replaced, and everything else is kept.

## Google Places search (optional)

OpenStreetMap is missing some bars, and others are listed there as restaurants or nightclubs. Google's listings are much more complete. To use them you need your own API key, which you paste into the app; it never goes into this repo.

### Get a key

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (for example "PourPoint").
2. Set up billing for the project. Google requires a card even if you stay within the free monthly usage, which is plenty for personal use.
3. Go to **APIs & Services → Library**, search for **Places API (New)** and click **Enable**.
4. Go to **APIs & Services → Credentials → Create credentials → API key**.
5. Restrict the key (click its name):
   - **Application restrictions → Websites**: add `https://andrewbarra.github.io/*` (and `http://localhost:8000/*` if you run it locally).
   - **API restrictions → Restrict key**: tick only **Places API (New)**.
6. Cap usage so a leaked key can't run up a bill: **APIs & Services → Places API (New) → Quotas**, and set low per-day limits on the autocomplete and place details requests (for example 300 a day). A budget alert under **Billing → Budgets & alerts** is also a good idea; note that alerts warn you but don't stop charges.
7. In PourPoint, open **Settings**, paste the key and tap **Save key**. Do this on each device and browser you use.

### How it's used

- While you type, the app calls Places Autocomplete (debounced, with a session token so a whole search counts as one session) for bars, cocktail bars, pubs, nightclubs and restaurants near the map center. Results are credited "Google Maps" as Google's terms require.
- When you pick a result, the app asks Google for that place's **address only**. The pin's position is then looked up from the address with Nominatim, because Google's terms don't allow showing Google location data on a non-Google map. If Nominatim can't find the address, the pin goes at the city center (or you're offered the add-it-yourself form, prefilled) and you can drag it into place.
- If Google returns an error (a bad key, a blocked site or a used-up quota), the dropdown says so and shows OpenStreetMap results instead.

## Running locally

ES modules don't load from `file://`, so serve the folder over HTTP:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` publishes the site on every push to `main` (you can also run it by hand from the Actions tab).

One-time setup:

1. Push the repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **GitHub Actions**.
4. Push to `main`, or re-run the "Deploy to GitHub Pages" workflow. The site URL appears in the workflow run and on the Pages settings screen (usually `https://<user>.github.io/<repo>/`).

All paths in the app are relative, so it works from a project subpath.

## Project layout

```
index.html              App shell
manifest.webmanifest    Install-to-home-screen metadata
css/styles.css          Styles (light and dark)
js/app.js               UI: map, search, bar pages, drinks, lists, stats, backup
js/db.js                IndexedDB storage, scoring, export/import
js/api.js               Photon and Google Places search, Nominatim geocoding
js/photos.js            Photo resizing
icons/                  App icons (SVG source plus PNGs)
vendor/leaflet/         Leaflet 1.9.4 (BSD-2-Clause)
```

## Usage policies

- **Nominatim** is only called when you save a bar (a manually added one, or one picked from Google search), never while typing. That's one request, plus at most one more for the city-center fallback, sent at least a second later to respect the [one-request-per-second limit](https://operations.osmfoundation.org/policies/nominatim/).
- **Google Places** is only used with your own key. See [Google Places search](#google-places-search-optional) for what's requested and how to cap usage.
- **Photon** is a public demo server intended for autocomplete. Typing is debounced and earlier requests are cancelled, to keep the load light.
- **Map tiles** come from `tile.openstreetmap.org` under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Map data © OpenStreetMap contributors.
