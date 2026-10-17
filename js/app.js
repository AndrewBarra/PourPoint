// PourPoint UI: map, search, bar pages, drinks, lists, stats and backup.
import * as db from './db.js';
import { searchBars, searchGooglePlaces, googlePlaceAddress, geocodeAddress, LookupError } from './api.js';
import { resizePhotos } from './photos.js';

const { CATEGORIES, SPIRITS, overallScore } = db;
const US_BOUNDS = [[24.4, -125.0], [49.5, -66.9]];

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  bars: [],
  drinks: [],
  markers: new Map(), // barId -> Leaflet marker
  currentBarId: null,
};

// ---------- Helpers ----------

/** Escape text before it goes into HTML. Use for every user or API string. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function formatScore(score) {
  return score == null ? 'Not rated' : `${score.toFixed(1)}/10`;
}

function scoreTier(score) {
  if (score == null) return 'none';
  if (score >= 9) return 'gold';
  if (score >= 7) return 'green';
  if (score >= 5) return 'orange';
  return 'red';
}

function formatAddress(p) {
  const region = [p.state, p.postcode].filter(Boolean).join(' ');
  return [p.street, p.city, region].filter(Boolean).join(', ');
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatPrice(price) {
  return typeof price === 'number' ? `$${price.toFixed(2)}` : '';
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function emptyRatings() {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, null]));
}

let toastTimer;
function toast(message, { error = false } = {}) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6000 : 3000);
}

const isMobile = () => window.matchMedia('(max-width: 759px)').matches;

// ---------- Photos ----------

const photoUrls = new Map(); // photoId -> object URL

async function photoUrl(id) {
  if (photoUrls.has(id)) return photoUrls.get(id);
  const photo = await db.getPhoto(id);
  if (!photo) return null;
  const url = URL.createObjectURL(photo.blob);
  photoUrls.set(id, url);
  return url;
}

function forgetPhotos(ids) {
  ids.forEach((id) => {
    const url = photoUrls.get(id);
    if (url) URL.revokeObjectURL(url);
    photoUrls.delete(id);
  });
}

/**
 * Render thumbnails into `container`. Each item is { id } (saved photo) or
 * { url } (photo not saved yet). Tapping opens the viewer; with `onRemove`
 * each thumbnail also gets a remove button.
 */
async function renderThumbs(container, items, { onRemove } = {}) {
  const urls = await Promise.all(items.map((it) => it.url || photoUrl(it.id)));
  container.innerHTML = '';
  urls.forEach((url, i) => {
    if (!url) return;
    const wrap = document.createElement('div');
    wrap.className = 'thumb';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'thumb-open';
    btn.setAttribute('aria-label', `Open photo ${i + 1}`);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    btn.append(img);
    btn.addEventListener('click', () => openViewer(urls.filter(Boolean), urls.slice(0, i).filter(Boolean).length));
    wrap.append(btn);
    if (onRemove) {
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'thumb-remove';
      rm.setAttribute('aria-label', 'Remove photo');
      rm.textContent = '✕';
      rm.addEventListener('click', () => onRemove(items[i], i));
      wrap.append(rm);
    }
    container.append(wrap);
  });
}

// ---------- Photo viewer ----------

const viewer = { urls: [], index: 0, el: null };

function openViewer(urls, index) {
  if (!urls.length) return;
  viewer.urls = urls;
  viewer.index = index;
  if (!viewer.el.open) viewer.el.showModal();
  showViewerPhoto();
  $('.viewer-close', viewer.el).focus();
}

function showViewerPhoto() {
  const { el, urls, index } = viewer;
  $('img', el).src = urls[index];
  const multi = urls.length > 1;
  $('.viewer-prev', el).hidden = !multi;
  $('.viewer-next', el).hidden = !multi;
  $('.viewer-count', el).textContent = multi ? `${index + 1} / ${urls.length}` : '';
}

function stepViewer(delta) {
  viewer.index = (viewer.index + delta + viewer.urls.length) % viewer.urls.length;
  showViewerPhoto();
}

function closeViewer() {
  if (viewer.el.open) viewer.el.close();
}

function setupViewer() {
  viewer.el = $('#viewer');
  $('.viewer-close', viewer.el).addEventListener('click', closeViewer);
  $('.viewer-prev', viewer.el).addEventListener('click', () => stepViewer(-1));
  $('.viewer-next', viewer.el).addEventListener('click', () => stepViewer(1));
  viewer.el.addEventListener('click', (e) => { if (e.target === viewer.el) closeViewer(); });
  viewer.el.addEventListener('close', () => $('img', viewer.el).removeAttribute('src'));
  viewer.el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });
  let startX = null;
  viewer.el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  viewer.el.addEventListener('touchend', (e) => {
    if (startX == null || viewer.urls.length < 2) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
    startX = null;
  });
}

// ---------- Star input ----------

/**
 * 10 tappable stars plus the number and a "not rated" button.
 * Returns { get, set }. onChange(value) gets a number 1–10 or null.
 */
function createStarInput(container, { value = null, label = 'Rating', onChange } = {}) {
  let current = value;
  container.classList.add('star-input');
  container.innerHTML = `
    <div class="stars" role="radiogroup" aria-label="${esc(label)}">
      ${Array.from({ length: 10 }, (_, i) => `
        <button type="button" class="star" role="radio" data-value="${i + 1}"
                aria-label="${i + 1} out of 10">★</button>`).join('')}
    </div>
    <span class="star-value" aria-live="polite"></span>
    <button type="button" class="star-clear">Not rated</button>`;
  const stars = [...container.querySelectorAll('.star')];
  const valueEl = $('.star-value', container);
  const clearBtn = $('.star-clear', container);

  function paint() {
    stars.forEach((s, i) => {
      const on = current != null && i < current;
      s.classList.toggle('on', on);
      s.setAttribute('aria-checked', String(current === i + 1));
    });
    valueEl.textContent = current == null ? '—' : `${current}/10`;
    clearBtn.disabled = current == null;
  }
  function set(v, notify = false) {
    current = v;
    paint();
    if (notify && onChange) onChange(current);
  }
  stars.forEach((s) => s.addEventListener('click', () => set(Number(s.dataset.value), true)));
  clearBtn.addEventListener('click', () => set(null, true));
  container.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('star')) return;
    const delta = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const next = Math.min(10, Math.max(1, (current || 0) + delta));
    set(next, true);
    stars[next - 1].focus();
  });
  paint();
  return { get: () => current, set: (v) => set(v) };
}

// ---------- Map ----------

let map;

function setupMap() {
  map = L.map('map', { zoomControl: true, worldCopyJump: true });
  map.fitBounds(US_BOUNDS);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const UsControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'leaflet-bar map-us-btn');
      btn.type = 'button';
      btn.textContent = 'US';
      btn.title = 'Zoom out to the whole US';
      btn.setAttribute('aria-label', 'Zoom out to the whole US');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', () => map.flyToBounds(US_BOUNDS, { duration: 0.8 }));
      return btn;
    },
  });
  map.addControl(new UsControl());

  // "Open" buttons inside popups.
  map.getContainer().addEventListener('click', (e) => {
    const btn = e.target.closest('[data-open-bar]');
    if (btn) openBar(btn.dataset.openBar);
  });
}

function pinIcon(score) {
  const tier = scoreTier(score);
  const text = score == null ? '' : score >= 9.95 ? '10' : score.toFixed(1);
  return L.divIcon({
    className: `pin pin-${tier}`,
    html: `<svg viewBox="0 0 34 46" width="34" height="46" aria-hidden="true">
        <path d="M17 1C8.2 1 1 8 1 16.7 1 28.5 17 45 17 45s16-16.5 16-28.3C33 8 25.8 1 17 1z"/>
      </svg><span class="pin-text">${esc(text)}</span>`,
    iconSize: [34, 46],
    iconAnchor: [17, 45],
    popupAnchor: [0, -40],
  });
}

function popupHtml(bar) {
  const score = overallScore(bar);
  return `<div class="popup">
      <strong class="popup-name">${esc(bar.name)}</strong>
      <span class="score-badge tier-${scoreTier(score)}">${esc(formatScore(score))}</span>
      <button type="button" class="btn btn-primary btn-small" data-open-bar="${esc(bar.id)}">Open bar page</button>
    </div>`;
}

function syncMarkers() {
  const seen = new Set();
  for (const bar of state.bars) {
    seen.add(bar.id);
    const score = overallScore(bar);
    let marker = state.markers.get(bar.id);
    if (!marker) {
      marker = L.marker([bar.lat, bar.lon], { title: bar.name, riseOnHover: true }).addTo(map);
      marker.bindPopup('');
      state.markers.set(bar.id, marker);
    } else if (!marker.dragging?.enabled()) {
      marker.setLatLng([bar.lat, bar.lon]);
    }
    marker.setIcon(pinIcon(score));
    marker.setPopupContent(popupHtml(bar));
    marker.options.title = bar.name;
  }
  for (const [id, marker] of state.markers) {
    if (!seen.has(id)) {
      marker.remove();
      state.markers.delete(id);
    }
  }
}

function flyToBar(bar, { popup = true } = {}) {
  map.flyTo([bar.lat, bar.lon], Math.max(map.getZoom(), 16), { duration: 0.8 });
  const marker = state.markers.get(bar.id);
  if (popup && marker) map.once('moveend', () => marker.openPopup());
}

// ---------- Data refresh ----------

async function refresh() {
  const [bars, drinks] = await Promise.all([db.getAllBars(), db.getAllDrinks()]);
  state.bars = bars;
  state.drinks = drinks;
  syncMarkers();
  renderBarList();
  renderDrinkList();
  renderStats();
}

const barById = (id) => state.bars.find((b) => b.id === id);

// ---------- Settings ----------

const GOOGLE_KEY_STORAGE = 'pourpoint.googlePlacesKey';

function getGoogleKey() {
  try {
    return localStorage.getItem(GOOGLE_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

function setGoogleKey(key) {
  try {
    if (key) localStorage.setItem(GOOGLE_KEY_STORAGE, key);
    else localStorage.removeItem(GOOGLE_KEY_STORAGE);
    return true;
  } catch {
    return false;
  }
}

function renderSearchSource() {
  const key = getGoogleKey();
  $('#googleKeyInput').value = key;
  $('#googleKeyRemove').hidden = !key;
  $('#searchSourceNote').textContent = key
    ? 'Searching with Google Places. If Google fails, OpenStreetMap is used instead.'
    : 'Searching with OpenStreetMap.';
}

function setupSettings() {
  $('#googleKeyForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = $('#googleKeyInput').value.trim();
    if (!key) { toast('Paste a key first.', { error: true }); return; }
    if (!setGoogleKey(key)) { toast('Couldn\'t save the key. This browser is blocking storage.', { error: true }); return; }
    renderSearchSource();
    toast('Key saved. Searches now use Google.');
  });
  $('#googleKeyRemove').addEventListener('click', () => {
    setGoogleKey('');
    renderSearchSource();
    toast('Key removed. Searches use OpenStreetMap.');
  });
  renderSearchSource();
}

// ---------- Search ----------

const search = {
  timer: null,
  controller: null,
  results: [],
  active: -1,
  status: '',
  source: 'osm', // which service produced `results`
  notice: '', // e.g. "Google failed, showing OpenStreetMap results"
  sessionToken: null, // groups Google autocomplete calls for billing
  busy: false,
};

function resetSearchSession() {
  search.sessionToken = null;
}

function setupSearch() {
  const input = $('#searchInput');
  const list = $('#searchResults');

  input.addEventListener('input', () => {
    clearTimeout(search.timer);
    const q = input.value.trim();
    if (q.length < 2) {
      search.controller?.abort();
      search.results = [];
      search.status = '';
      search.notice = '';
      if (!q) { resetSearchSession(); closeDropdown(); return; }
      renderDropdown();
      return;
    }
    search.timer = setTimeout(() => runSearch(q), 300);
  });

  input.addEventListener('focus', () => { if (input.value.trim()) renderDropdown(); });

  input.addEventListener('keydown', (e) => {
    const options = [...list.querySelectorAll('[role="option"]')];
    if (list.hidden || !options.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      search.active = (search.active + delta + options.length) % options.length;
      options.forEach((o, i) => o.setAttribute('aria-selected', String(i === search.active)));
      options[search.active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (search.active >= 0) {
        e.preventDefault();
        options[search.active].click();
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  // Keep focus in the input while tapping a row, then act on click.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[role="option"]');
    if (!row) return;
    if (row.dataset.add !== undefined) {
      const name = input.value.trim();
      closeDropdown();
      openManualDialog(name);
    } else {
      pickResult(search.results[Number(row.dataset.index)]);
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#search')) closeDropdown();
  });
}

async function runSearch(q) {
  search.controller?.abort();
  const controller = new AbortController();
  search.controller = controller;
  search.status = 'loading';
  renderDropdown();
  const center = map.getCenter();
  const where = { lat: center.lat, lon: center.lng, signal: controller.signal };
  const key = getGoogleKey();
  search.notice = '';
  try {
    let results = null;
    let source = 'osm';
    if (key) {
      search.sessionToken ||= db.newId();
      try {
        results = await searchGooglePlaces(q, { ...where, key, sessionToken: search.sessionToken });
        source = 'google';
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        search.notice = `${err instanceof LookupError ? err.message : 'Google search failed.'} Showing OpenStreetMap results instead.`;
      }
    }
    if (!results) results = await searchBars(q, where);
    if (controller.signal.aborted) return;
    search.results = results;
    search.source = source;
    search.status = results.length ? '' : 'empty';
  } catch (err) {
    if (err.name === 'AbortError') return;
    search.results = [];
    search.status = err instanceof LookupError ? err.message : 'Something went wrong with the search. Please try again.';
  }
  renderDropdown();
}

function renderDropdown() {
  const input = $('#searchInput');
  const list = $('#searchResults');
  const saved = new Set(state.bars.flatMap((b) => [b.osmId, b.googlePlaceId]).filter(Boolean));
  let html = search.notice ? `<li class="search-status search-error">${esc(search.notice)}</li>` : '';
  if (search.status === 'loading') {
    html += '<li class="search-status">Searching…</li>';
  } else if (search.status === 'empty') {
    html += '<li class="search-status">No bars found with that name nearby.</li>';
  } else if (search.status) {
    html += `<li class="search-status search-error">${esc(search.status)}</li>`;
  } else if (input.value.trim().length < 2 && !search.results.length) {
    html += '<li class="search-status">Keep typing to search…</li>';
  }
  if (search.status !== 'loading') {
    search.results.forEach((r, i) => {
      const addr = r.source === 'google' ? r.address : [r.street, r.city, r.state].filter(Boolean).join(', ');
      const id = r.source === 'google' ? r.placeId : r.osmId;
      html += `<li role="option" class="search-row" data-index="${i}" aria-selected="false">
          <span class="search-name">${esc(r.name)}${saved.has(id) ? ' <span class="saved-tag">Saved</span>' : ''}</span>
          <span class="search-addr">${esc(addr || 'Address unknown')}</span>
        </li>`;
    });
  }
  html += `<li role="option" class="search-row search-add" data-add aria-selected="false">
      <span class="search-name">Can't find it? Add it yourself</span>
    </li>`;
  if (search.source === 'google' && search.results.length && search.status !== 'loading') {
    html += '<li class="search-attrib" aria-label="Results from Google Maps">Google Maps</li>';
  }
  list.innerHTML = html;
  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  search.active = -1;
}

function closeDropdown() {
  $('#searchResults').hidden = true;
  $('#searchInput').setAttribute('aria-expanded', 'false');
  search.active = -1;
}

async function pickResult(result) {
  if (!result || search.busy) return;
  closeDropdown();
  $('#searchInput').value = '';
  search.results = [];
  if (result.source === 'google') {
    await pickGoogleResult(result);
    return;
  }
  try {
    const existing = await db.findBarByOsmId(result.osmId);
    if (existing) {
      toast(`You already saved ${existing.name}.`);
      openBar(existing.id, { fly: true });
      return;
    }
    const bar = await db.saveBar({
      id: db.newId(),
      osmId: result.osmId,
      name: result.name,
      street: result.street,
      city: result.city,
      state: result.state,
      postcode: result.postcode,
      lat: result.lat,
      lon: result.lon,
      approximate: false,
      ratings: emptyRatings(),
      visited: '',
      notes: '',
      photoIds: [],
      createdAt: new Date().toISOString(),
    });
    await refresh();
    toast(`Saved ${bar.name}.`);
    openBar(bar.id, { fly: true });
  } catch (err) {
    console.error(err);
    toast('Couldn\'t save that bar. Please try again.', { error: true });
  }
}

/**
 * Save a Google result. Google supplies the name and address; the pin's
 * position comes from Nominatim, since Google's terms don't allow showing
 * Google location data on a non-Google map.
 */
async function pickGoogleResult(result) {
  const sessionToken = search.sessionToken;
  resetSearchSession();
  try {
    const existing = await db.findBarByGooglePlaceId(result.placeId);
    if (existing) {
      toast(`You already saved ${existing.name}.`);
      openBar(existing.id, { fly: true });
      return;
    }
  } catch (err) {
    console.error(err);
  }
  search.busy = true;
  toast(`Finding ${result.name} on the map…`);
  let address = null;
  try {
    address = await googlePlaceAddress(result.placeId, { key: getGoogleKey(), sessionToken });
    const fields = { name: result.name, street: address.street, city: address.city, state: address.state, postcode: address.postcode };
    const location = fields.city ? await geocodeAddress(fields) : null;
    if (!location) {
      openManualDialog(fields, {
        googlePlaceId: result.placeId,
        error: 'We couldn\'t find this address on OpenStreetMap. Check it, or save it at the map\'s center and drag the pin into place.',
      });
      return;
    }
    if (location.approximate) location.reason = 'city';
    await saveManualBar(fields, location, { googlePlaceId: result.placeId });
    toast(location.approximate ? 'Saved. Exact address not found, so the pin is at the city center.' : `Saved ${fields.name}.`);
  } catch (err) {
    if (!(err instanceof LookupError)) console.error(err);
    const message = err instanceof LookupError ? err.message : 'Something went wrong saving this bar.';
    if (address) {
      openManualDialog({ name: result.name, ...address }, { googlePlaceId: result.placeId, error: `${message} You can save it at the map's center instead.` });
    } else {
      toast(message, { error: true });
    }
  } finally {
    search.busy = false;
  }
}

// ---------- Add a bar manually ----------

let manualExtra = {}; // extra fields saved with a manual bar (e.g. googlePlaceId)

/** `prefill` is a name string, or an object with name/street/city/state/postcode. */
function openManualDialog(prefill = '', { googlePlaceId = null, error = '' } = {}) {
  const dialog = $('#manualDialog');
  const form = $('#manualForm');
  const fields = typeof prefill === 'string' ? { name: prefill } : prefill;
  form.reset();
  for (const name of ['name', 'street', 'city', 'state', 'postcode']) {
    form.elements[name].value = fields[name] || '';
  }
  manualExtra = googlePlaceId ? { googlePlaceId } : {};
  showFormError(form, error);
  $('[data-center]', form).hidden = !error;
  dialog.showModal();
  (fields.name ? form.elements.street : form.elements.name).focus();
}

function showFormError(form, message) {
  const el = $('.form-error', form);
  el.textContent = message;
  el.hidden = !message;
}

function readManualForm(form) {
  const v = (n) => form.elements[n].value.trim();
  return { name: v('name'), street: v('street'), city: v('city'), state: v('state'), postcode: v('postcode') };
}

async function saveManualBar(fields, location, extra = manualExtra) {
  const bar = await db.saveBar({
    id: db.newId(),
    osmId: null,
    googlePlaceId: null,
    ...extra,
    ...fields,
    lat: location.lat,
    lon: location.lon,
    approximate: location.approximate,
    approximateReason: location.reason || null,
    ratings: emptyRatings(),
    visited: '',
    notes: '',
    photoIds: [],
    createdAt: new Date().toISOString(),
  });
  $('#manualDialog').close();
  await refresh();
  openBar(bar.id, { fly: true });
  return bar;
}

function setupManualDialog() {
  const dialog = $('#manualDialog');
  const form = $('#manualForm');
  const submit = $('button[type="submit"]', form);
  const centerBtn = $('[data-center]', form);
  $('[data-close]', form).addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readManualForm(form);
    if (!fields.name) { showFormError(form, 'Please enter the bar\'s name.'); form.elements.name.focus(); return; }
    if (!fields.city) { showFormError(form, 'Please enter a city so we can place the pin.'); form.elements.city.focus(); return; }
    showFormError(form, '');
    centerBtn.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Looking up address…';
    try {
      const location = await geocodeAddress(fields);
      if (!location) {
        showFormError(form, `We couldn't find "${fields.city}${fields.state ? `, ${fields.state}` : ''}". Check the spelling, or save it at the map's center and drag the pin into place.`);
        centerBtn.hidden = false;
        return;
      }
      if (location.approximate) location.reason = 'city';
      await saveManualBar(fields, location);
      toast(location.approximate ? 'Saved. Exact address not found, so the pin is at the city center.' : `Saved ${fields.name}.`);
    } catch (err) {
      if (!(err instanceof LookupError)) console.error(err);
      showFormError(form, err instanceof LookupError ? err.message : 'Something went wrong saving this bar. Please try again.');
      if (err instanceof LookupError) centerBtn.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Save bar';
    }
  });

  centerBtn.addEventListener('click', async () => {
    const fields = readManualForm(form);
    if (!fields.name) { showFormError(form, 'Please enter the bar\'s name.'); return; }
    const c = map.getCenter();
    await saveManualBar(fields, { lat: c.lat, lon: c.lng, approximate: true, reason: 'map' });
    toast('Saved. Drag the pin to the right spot.');
  });
}

// ---------- Bar page ----------

let notesTimer;

async function openBar(id, { fly = false } = {}) {
  const bar = barById(id) || (await db.getBar(id));
  if (!bar) { toast('That bar no longer exists.', { error: true }); return; }
  state.currentBarId = id;
  map.closePopup();
  await renderBarView(bar);
  const view = $('#barView');
  view.hidden = false;
  view.scrollTop = 0;
  document.body.classList.add('bar-open');
  if (fly && !isMobile()) flyToBar(bar, { popup: false });
  else if (fly) map.setView([bar.lat, bar.lon], Math.max(map.getZoom(), 16));
}

function closeBar() {
  clearTimeout(notesTimer);
  state.currentBarId = null;
  $('#barView').hidden = true;
  document.body.classList.remove('bar-open');
}

function approximateNote(bar) {
  if (!bar.approximate) return '';
  const text = bar.approximateReason === 'map'
    ? 'The address couldn\'t be looked up, so the pin was placed at the map\'s center.'
    : `The exact address wasn't found, so the pin is at the center of ${bar.city || 'the city'}.`;
  return `<p class="notice">${esc(text)} Use <strong>Move pin</strong> to put it in the right spot.</p>`;
}

async function renderBarView(bar) {
  const view = $('#barView');
  const score = overallScore(bar);
  const drinks = state.drinks
    .filter((d) => d.barId === bar.id)
    .sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name));

  view.innerHTML = `
    <div class="bar-head">
      <button type="button" class="btn btn-ghost back-btn" data-action="close">← Back</button>
      <span class="score-badge score-big tier-${scoreTier(score)}" data-score>${esc(formatScore(score))}</span>
    </div>
    <h2 class="bar-name">${esc(bar.name)}</h2>
    <p class="muted">${esc(formatAddress(bar) || 'No address')}</p>
    ${approximateNote(bar)}
    <div class="button-row">
      <button type="button" class="btn btn-small" data-action="show">Show on map</button>
      <button type="button" class="btn btn-small" data-action="move">Move pin</button>
    </div>

    <h3 class="section-title">Ratings</h3>
    <div class="ratings">
      ${CATEGORIES.map((c) => `
        <div class="rating-row">
          <span class="rating-label">${esc(c.label)}</span>
          <div data-cat="${c.key}"></div>
        </div>`).join('')}
    </div>

    <label class="field">Date visited
      <input type="date" data-field="visited" value="${esc(bar.visited || '')}">
    </label>
    <label class="field">Notes <span class="save-status muted small" data-save-status></span>
      <textarea rows="4" maxlength="5000" data-field="notes" placeholder="What stood out?">${esc(bar.notes || '')}</textarea>
    </label>

    <div class="field">
      <span class="field-label">Photos</span>
      <div class="thumbs" data-bar-thumbs></div>
      <label class="btn btn-small">Add photos<input type="file" accept="image/*" multiple hidden data-bar-photos></label>
    </div>

    <div class="drinks-head">
      <h3 class="section-title">Drinks (${drinks.length})</h3>
      <button type="button" class="btn btn-primary btn-small" data-action="add-drink">+ Add drink</button>
    </div>
    <ul class="card-list drink-cards">
      ${drinks.length ? drinks.map(drinkCardHtml).join('') : '<li class="empty">No drinks logged yet.</li>'}
    </ul>

    <div class="danger-zone">
      <button type="button" class="btn btn-danger btn-small" data-action="delete">Delete this bar</button>
    </div>`;

  CATEGORIES.forEach((c) => {
    createStarInput($(`[data-cat="${c.key}"]`, view), {
      value: bar.ratings?.[c.key] ?? null,
      label: `${c.label} rating`,
      onChange: (v) => updateBar(bar.id, (b) => { b.ratings = { ...emptyRatings(), ...b.ratings, [c.key]: v }; }),
    });
  });

  renderThumbs($('[data-bar-thumbs]', view), (bar.photoIds || []).map((id) => ({ id })), {
    onRemove: (item) => removeBarPhoto(bar.id, item.id),
  });

  for (const d of drinks) {
    const el = view.querySelector(`[data-drink-thumbs="${CSS.escape(d.id)}"]`);
    if (el && d.photoIds?.length) renderThumbs(el, d.photoIds.map((id) => ({ id })));
  }
}

function drinkCardHtml(d) {
  const meta = [d.spirit && capitalize(d.spirit), formatPrice(d.price)].filter(Boolean).join(' · ');
  return `<li class="card drink-card">
      <div class="card-main">
        <div class="card-title-row">
          <strong>${esc(d.name)}</strong>
          <span class="score-badge tier-${scoreTier(d.rating ?? null)}">${d.rating ? `${d.rating}/10` : 'Not rated'}</span>
        </div>
        ${meta ? `<span class="muted small">${esc(meta)}</span>` : ''}
        ${d.notes ? `<p class="card-notes">${esc(d.notes)}</p>` : ''}
        <div class="thumbs thumbs-small" data-drink-thumbs="${esc(d.id)}"></div>
      </div>
      <button type="button" class="btn btn-small" data-action="edit-drink" data-id="${esc(d.id)}">Edit</button>
    </li>`;
}

/** Apply `mutate` to the stored bar, save it, and refresh map and lists. */
async function updateBar(id, mutate) {
  const bar = await db.getBar(id);
  if (!bar) return null;
  mutate(bar);
  await db.saveBar(bar);
  await refresh();
  if (state.currentBarId === id) {
    const badge = $('#barView [data-score]');
    const score = overallScore(bar);
    if (badge) {
      badge.textContent = formatScore(score);
      badge.className = `score-badge score-big tier-${scoreTier(score)}`;
    }
  }
  return bar;
}

async function addBarPhotos(barId, files) {
  const { blobs, errors } = await resizePhotos(files);
  if (errors.length) toast(errors.join(' '), { error: true });
  if (!blobs.length) return;
  try {
    const ids = [];
    for (const blob of blobs) ids.push(await db.addPhoto(blob));
    const bar = await updateBar(barId, (b) => { b.photoIds = [...(b.photoIds || []), ...ids]; });
    if (bar && state.currentBarId === barId) await renderBarView(bar);
  } catch (err) {
    console.error(err);
    toast('Couldn\'t save the photos. Your device may be out of storage.', { error: true });
  }
}

async function removeBarPhoto(barId, photoId) {
  if (!confirm('Remove this photo?')) return;
  const bar = await updateBar(barId, (b) => { b.photoIds = (b.photoIds || []).filter((p) => p !== photoId); });
  await db.deletePhotos([photoId]);
  forgetPhotos([photoId]);
  if (bar && state.currentBarId === barId) await renderBarView(bar);
}

function setupBarView() {
  const view = $('#barView');
  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const bar = barById(state.currentBarId);
    if (!bar) return;
    switch (btn.dataset.action) {
      case 'close': closeBar(); break;
      case 'show':
        if (isMobile()) closeBar();
        flyToBar(bar);
        break;
      case 'move': startMovePin(bar); break;
      case 'add-drink': openDrinkDialog(bar.id); break;
      case 'edit-drink': openDrinkDialog(bar.id, state.drinks.find((d) => d.id === btn.dataset.id)); break;
      case 'delete':
        if (!confirm(`Delete ${bar.name}, its drinks and photos? This can't be undone.`)) return;
        forgetPhotos(await db.deleteBar(bar.id));
        closeBar();
        await refresh();
        toast(`Deleted ${bar.name}.`);
        break;
    }
  });

  view.addEventListener('change', (e) => {
    const id = state.currentBarId;
    if (e.target.matches('[data-field="visited"]')) {
      const value = e.target.value;
      updateBar(id, (b) => { b.visited = value; });
    } else if (e.target.matches('[data-bar-photos]')) {
      const files = [...e.target.files];
      e.target.value = '';
      addBarPhotos(id, files);
    }
  });

  view.addEventListener('input', (e) => {
    if (!e.target.matches('[data-field="notes"]')) return;
    const id = state.currentBarId;
    const value = e.target.value;
    const status = $('[data-save-status]', view);
    status.textContent = '';
    clearTimeout(notesTimer);
    notesTimer = setTimeout(async () => {
      await updateBar(id, (b) => { b.notes = value; });
      if (state.currentBarId === id) status.textContent = 'Saved';
    }, 600);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !view.hidden && !document.querySelector('dialog[open]') && !moving) {
      closeBar();
    }
  });
}

// ---------- Move pin ----------

let moving = null; // { bar, marker, original }

function startMovePin(bar) {
  const marker = state.markers.get(bar.id);
  if (!marker) return;
  moving = { bar, marker, original: marker.getLatLng() };
  $('#barView').hidden = true;
  document.body.classList.remove('bar-open');
  map.closePopup();
  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 17));
  marker.dragging.enable();
  marker.getElement()?.classList.add('pin-moving');
  $('#moveBanner').hidden = false;
}

async function endMovePin(save) {
  if (!moving) return;
  const { bar, marker, original } = moving;
  moving = null;
  marker.dragging.disable();
  marker.getElement()?.classList.remove('pin-moving');
  $('#moveBanner').hidden = true;
  if (save) {
    const { lat, lng } = marker.getLatLng();
    await updateBar(bar.id, (b) => { b.lat = lat; b.lon = lng; b.approximate = false; b.approximateReason = null; });
    toast('Pin moved.');
  } else {
    marker.setLatLng(original);
  }
  openBar(bar.id);
}

// ---------- Drink dialog ----------

const drinkEdit = { barId: null, drink: null, photos: [], removed: [], rating: null };

function openDrinkDialog(barId, drink = null) {
  const dialog = $('#drinkDialog');
  const form = $('#drinkForm');
  form.reset();
  showFormError(form, '');
  drinkEdit.barId = barId;
  drinkEdit.drink = drink;
  drinkEdit.removed = [];
  drinkEdit.photos = (drink?.photoIds || []).map((id) => ({ id }));
  $('[data-title]', form).textContent = drink ? 'Edit drink' : 'Add a drink';
  $('[data-delete]', form).hidden = !drink;
  form.elements.name.value = drink?.name || '';
  form.elements.spirit.value = drink?.spirit || '';
  form.elements.price.value = typeof drink?.price === 'number' ? String(drink.price) : '';
  form.elements.notes.value = drink?.notes || '';
  drinkEdit.rating.set(drink?.rating ?? null);
  renderDrinkThumbs();
  dialog.showModal();
  if (!drink) form.elements.name.focus();
}

function renderDrinkThumbs() {
  renderThumbs($('#drinkForm [data-thumbs]'), drinkEdit.photos, {
    onRemove: (item) => {
      drinkEdit.photos = drinkEdit.photos.filter((p) => p !== item);
      if (item.id) drinkEdit.removed.push(item.id);
      if (item.url) URL.revokeObjectURL(item.url);
      renderDrinkThumbs();
    },
  });
}

function discardUnsavedDrinkPhotos() {
  drinkEdit.photos.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); });
  drinkEdit.photos = [];
}

function setupDrinkDialog() {
  const dialog = $('#drinkDialog');
  const form = $('#drinkForm');
  const spirit = form.elements.spirit;
  SPIRITS.forEach((s) => spirit.add(new Option(capitalize(s), s)));
  drinkEdit.rating = createStarInput($('[data-rating]', form), { label: 'Drink rating' });

  $('[data-close]', form).addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', discardUnsavedDrinkPhotos);

  $('[data-photo-input]', form).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const { blobs, errors } = await resizePhotos(files);
    if (errors.length) showFormError(form, errors.join(' '));
    blobs.forEach((blob) => drinkEdit.photos.push({ blob, url: URL.createObjectURL(blob) }));
    renderDrinkThumbs();
  });

  $('[data-delete]', form).addEventListener('click', async () => {
    const drink = drinkEdit.drink;
    if (!drink || !confirm(`Delete ${drink.name}?`)) return;
    forgetPhotos(await db.deleteDrink(drink.id));
    dialog.close();
    await refresh();
    const bar = barById(drinkEdit.barId);
    if (bar && state.currentBarId === bar.id) await renderBarView(bar);
    toast(`Deleted ${drink.name}.`);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.elements.name.value.trim();
    if (!name) { showFormError(form, 'Please give the drink a name.'); form.elements.name.focus(); return; }
    const priceText = form.elements.price.value.trim();
    const price = priceText === '' ? null : Number(priceText);
    if (price != null && (!Number.isFinite(price) || price < 0)) {
      showFormError(form, 'Price should be a number, like 14 or 14.50.');
      return;
    }
    try {
      const photoIds = [];
      for (const p of drinkEdit.photos) photoIds.push(p.id || (await db.addPhoto(p.blob)));
      const existing = drinkEdit.drink;
      await db.saveDrink({
        ...(existing || { id: db.newId(), barId: drinkEdit.barId, createdAt: new Date().toISOString() }),
        name,
        rating: drinkEdit.rating.get(),
        notes: form.elements.notes.value.trim(),
        price,
        spirit: spirit.value || null,
        photoIds,
      });
      await db.deletePhotos(drinkEdit.removed);
      forgetPhotos(drinkEdit.removed);
      dialog.close();
      await refresh();
      const bar = barById(drinkEdit.barId);
      if (bar && state.currentBarId === bar.id) await renderBarView(bar);
      toast(existing ? 'Drink updated.' : `Added ${name}.`);
    } catch (err) {
      console.error(err);
      showFormError(form, 'Couldn\'t save this drink. Your device may be out of storage.');
    }
  });
}

// ---------- Lists ----------

function renderBarList() {
  const list = $('#barList');
  const filter = $('#barFilter').value.trim().toLowerCase();
  const sort = $('#barSort').value;
  const drinkCounts = new Map();
  state.drinks.forEach((d) => drinkCounts.set(d.barId, (drinkCounts.get(d.barId) || 0) + 1));

  const bars = state.bars
    .filter((b) => b.name.toLowerCase().includes(filter))
    .map((b) => ({ bar: b, score: overallScore(b) }));
  const byName = (a, b) => a.bar.name.localeCompare(b.bar.name);
  if (sort === 'name') bars.sort(byName);
  else if (sort === 'recent') {
    bars.sort((a, b) => (b.bar.visited || '').localeCompare(a.bar.visited || '') ||
      (b.bar.createdAt || '').localeCompare(a.bar.createdAt || ''));
  } else bars.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byName(a, b));

  if (!state.bars.length) {
    list.innerHTML = '<li class="empty">No bars yet. Search above to add your first one.</li>';
    return;
  }
  if (!bars.length) {
    list.innerHTML = '<li class="empty">No bars match that filter.</li>';
    return;
  }
  list.innerHTML = bars.map(({ bar, score }) => {
    const count = drinkCounts.get(bar.id) || 0;
    const meta = [
      [bar.city, bar.state].filter(Boolean).join(', '),
      bar.visited && `Visited ${formatDate(bar.visited)}`,
      count && `${count} drink${count === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ');
    return `<li class="card bar-card">
        <button type="button" class="card-main card-button" data-fly="${esc(bar.id)}">
          <span class="card-title-row">
            <strong>${esc(bar.name)}</strong>
            <span class="score-badge tier-${scoreTier(score)}">${esc(formatScore(score))}</span>
          </span>
          <span class="muted small">${esc(meta)}</span>
        </button>
        <button type="button" class="btn btn-small" data-open="${esc(bar.id)}">Open</button>
      </li>`;
  }).join('');
}

function renderDrinkList() {
  const list = $('#drinkList');
  if (!state.drinks.length) {
    list.innerHTML = '<li class="empty">No drinks yet. Open a bar and tap "Add drink".</li>';
    return;
  }
  const drinks = [...state.drinks].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || a.name.localeCompare(b.name));
  list.innerHTML = drinks.map((d) => {
    const bar = barById(d.barId);
    const meta = [bar?.name, d.spirit && capitalize(d.spirit), formatPrice(d.price)].filter(Boolean).join(' · ');
    return `<li class="card">
        <button type="button" class="card-main card-button" data-open="${esc(d.barId)}">
          <span class="card-title-row">
            <strong>${esc(d.name)}</strong>
            <span class="score-badge tier-${scoreTier(d.rating ?? null)}">${d.rating ? `${d.rating}/10` : 'Not rated'}</span>
          </span>
          <span class="muted small">${esc(meta)}</span>
        </button>
      </li>`;
  }).join('');
}

function renderStats() {
  const scores = state.bars.map(overallScore).filter((s) => s != null);
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  let best = null;
  for (const c of CATEGORIES) {
    const vals = state.bars.map((b) => b.ratings?.[c.key]).filter((v) => typeof v === 'number');
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (!best || mean > best.mean) best = { label: c.label, mean };
  }
  const tiles = [
    ['Bars', String(state.bars.length)],
    ['Drinks', String(state.drinks.length)],
    ['Avg overall', avg == null ? '—' : `${avg.toFixed(1)}/10`],
    ['Best category', best ? best.label : '—', best ? `${best.mean.toFixed(1)}/10 avg` : ''],
  ];
  $('#stats').innerHTML = tiles.map(([label, value, sub]) => `
    <div class="stat-tile">
      <span class="stat-value">${esc(value)}</span>
      <span class="stat-label">${esc(label)}</span>
      ${sub ? `<span class="stat-sub">${esc(sub)}</span>` : ''}
    </div>`).join('');
}

function setupPanel() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  });
  $('#barFilter').addEventListener('input', renderBarList);
  $('#barSort').addEventListener('change', renderBarList);
  $('#panel').addEventListener('click', (e) => {
    const fly = e.target.closest('[data-fly]');
    const open = e.target.closest('[data-open]');
    if (fly) {
      const bar = barById(fly.dataset.fly);
      if (bar) flyToBar(bar);
    } else if (open) {
      openBar(open.dataset.open, { fly: true });
    }
  });
}

// ---------- Backup ----------

function setupBackup() {
  $('#exportBtn').addEventListener('click', async () => {
    try {
      const data = await db.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pourpoint-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast(`Exported ${data.bars.length} bars, ${data.drinks.length} drinks and ${data.photos.length} photos.`);
    } catch (err) {
      console.error(err);
      toast('Export failed. Please try again.', { error: true });
    }
  });

  $('#importInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('That file isn\'t valid JSON.');
      }
      if (!confirm(`Import ${data?.bars?.length ?? 0} bars from this backup? Bars already saved here are kept; matching ones are replaced by the backup's version.`)) return;
      const counts = await db.importAll(data);
      forgetPhotos([...photoUrls.keys()]);
      await refresh();
      if (state.currentBarId) {
        const bar = barById(state.currentBarId);
        if (bar) await renderBarView(bar);
      }
      if (state.bars.length) {
        map.fitBounds(L.latLngBounds(state.bars.map((b) => [b.lat, b.lon])).pad(0.2), { maxZoom: 15 });
      }
      toast(`Imported ${counts.bars} bars, ${counts.drinks} drinks and ${counts.photos} photos.`);
    } catch (err) {
      console.error(err);
      toast(`Import failed: ${err.message}`, { error: true });
    }
  });
}

// ---------- Start ----------

async function init() {
  setupMap();
  setupViewer();
  setupSearch();
  setupManualDialog();
  setupBarView();
  setupDrinkDialog();
  setupPanel();
  setupBackup();
  setupSettings();
  $('#moveDone').addEventListener('click', () => endMovePin(true));
  $('#moveCancel').addEventListener('click', () => endMovePin(false));

  try {
    await refresh();
  } catch (err) {
    console.error(err);
    toast('Couldn\'t open the local database. Private browsing can block storage.', { error: true });
  }

  const persisted = await db.requestPersistence();
  $('#persistNote').textContent = persisted
    ? 'Storage is marked persistent, so the browser won\'t clear it on its own.'
    : 'The browser may clear this data if the device runs low on space. Export a backup now and then.';
}

init();
