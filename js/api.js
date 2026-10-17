// Bar search (Google Places when you add a key, otherwise Photon) and
// address lookup (Nominatim). Photon and Nominatim are free OpenStreetMap
// services and need no API key.

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const BAR_TAGS = ['amenity:bar', 'amenity:pub'];
const GOOGLE_AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_PLACE_URL = 'https://places.googleapis.com/v1/places/';
// At most five types are allowed. Restaurants are included because many
// cocktail bars are listed as restaurants.
const GOOGLE_TYPES = ['bar', 'cocktail_bar', 'pub', 'night_club', 'restaurant'];

export class LookupError extends Error {}

function joinStreet(p) {
  if (!p.street) return '';
  return p.housenumber ? `${p.housenumber} ${p.street}` : p.street;
}

/**
 * Search bars and pubs by name, biased toward a point (usually the map center).
 * Pass an AbortSignal so a newer keystroke can cancel this request.
 */
export async function searchBars(query, { lat, lon, signal, limit = 8 } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit), lang: 'en' });
  BAR_TAGS.forEach((t) => params.append('osm_tag', t));
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    params.set('lat', lat.toFixed(5));
    params.set('lon', lon.toFixed(5));
  }
  let res;
  try {
    res = await fetch(`${PHOTON_URL}?${params}`, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new LookupError('Search is unavailable right now. Check your connection and try again.');
  }
  if (!res.ok) throw new LookupError(`Search failed (error ${res.status}). Please try again in a moment.`);
  const data = await res.json();
  return (data.features || [])
    .filter((f) => {
      const p = f.properties || {};
      return p.name && BAR_TAGS.includes(`${p.osm_key}:${p.osm_value}`) && f.geometry?.coordinates?.length === 2;
    })
    .map((f) => {
      const p = f.properties;
      const [lon2, lat2] = f.geometry.coordinates;
      return {
        osmId: `${p.osm_type || ''}${p.osm_id}`,
        name: p.name,
        street: joinStreet(p),
        city: p.city || p.town || p.village || p.district || p.county || '',
        state: p.state || '',
        postcode: p.postcode || '',
        lat: lat2,
        lon: lon2,
      };
    });
}

// ---- Google Places (New) ----

let googleTypesRejected = false;

async function googleError(res) {
  let message = '';
  try {
    message = (await res.json())?.error?.message || '';
  } catch { /* not JSON */ }
  if (res.status === 400 && /api key/i.test(message)) {
    return new LookupError('Google rejected the API key. Check it in Settings.');
  }
  if (res.status === 403) {
    return new LookupError(`Google refused the request: ${message || 'check that Places API (New) is enabled and the key allows this site'}.`);
  }
  if (res.status === 429) {
    return new LookupError('Google search limit reached for now. Try again later.');
  }
  return new LookupError(`Google search failed (error ${res.status})${message ? `: ${message}` : ''}.`);
}

/**
 * Autocomplete establishments by name with Google Places (New), biased toward
 * a point. Results carry the place ID and display text only; coordinates are
 * never taken from Google (see geocodeAddress).
 */
export async function searchGooglePlaces(query, { key, lat, lon, sessionToken, signal } = {}) {
  const body = {
    input: query,
    includedRegionCodes: ['us'],
    ...(sessionToken && { sessionToken }),
    ...(!googleTypesRejected && { includedPrimaryTypes: GOOGLE_TYPES }),
  };
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 50000 } };
  }
  let res;
  try {
    res = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new LookupError('Google search is unavailable right now. Check your connection and try again.');
  }
  // If Google ever stops accepting one of the type names, search without the
  // type filter rather than failing every search.
  if (res.status === 400 && body.includedPrimaryTypes) {
    const err = await googleError(res.clone());
    if (!/api key/i.test(err.message)) {
      googleTypesRejected = true;
      return searchGooglePlaces(query, { key, lat, lon, sessionToken, signal });
    }
  }
  if (!res.ok) throw await googleError(res);
  const data = await res.json();
  return (data.suggestions || [])
    .map((s) => s.placePrediction)
    .filter((p) => p?.placeId)
    .map((p) => ({
      source: 'google',
      placeId: p.placeId,
      name: p.structuredFormat?.mainText?.text || p.text?.text || '',
      address: (p.structuredFormat?.secondaryText?.text || '').replace(/, USA$/, ''),
    }))
    .filter((r) => r.name);
}

function component(components, ...types) {
  for (const type of types) {
    const c = components.find((x) => x.types?.includes(type));
    if (c) return c;
  }
  return null;
}

/**
 * Fetch the address of a Google place. Asks only for address fields (the
 * cheapest "Essentials" tier) and ends the autocomplete session.
 */
export async function googlePlaceAddress(placeId, { key, sessionToken } = {}) {
  const params = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : '';
  let res;
  try {
    res = await fetch(`${GOOGLE_PLACE_URL}${encodeURIComponent(placeId)}${params}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,addressComponents,formattedAddress' },
    });
  } catch {
    throw new LookupError('Couldn\'t reach Google to get the address. Check your connection and try again.');
  }
  if (!res.ok) throw await googleError(res);
  const place = await res.json();
  const parts = place.addressComponents || [];
  const number = component(parts, 'street_number')?.longText || '';
  const route = component(parts, 'route')?.longText || '';
  return {
    street: [number, route].filter(Boolean).join(' '),
    city: component(parts, 'locality', 'postal_town', 'sublocality_level_1', 'sublocality', 'administrative_area_level_3')?.longText || '',
    state: component(parts, 'administrative_area_level_1')?.shortText || '',
    postcode: component(parts, 'postal_code')?.longText || '',
    formatted: place.formattedAddress || '',
  };
}

// ---- Nominatim ----

async function nominatim(params) {
  const search = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'us', ...params });
  let res;
  try {
    res = await fetch(`${NOMINATIM_URL}?${search}`, { headers: { Accept: 'application/json' } });
  } catch {
    throw new LookupError('Address lookup is unavailable right now. Check your connection and try again.');
  }
  if (!res.ok) throw new LookupError(`Address lookup failed (error ${res.status}). Please try again in a moment.`);
  const list = await res.json();
  if (!list.length) return null;
  return { lat: parseFloat(list[0].lat), lon: parseFloat(list[0].lon) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Geocode an address (typed in by hand, or picked from Google search). Called
 * once, when the bar is saved.
 * Tries the exact address first; if that finds nothing, falls back to the
 * center of the city (a second request, sent at least a second later to stay
 * within Nominatim's one-request-per-second limit).
 * Returns { lat, lon, approximate } or null when even the city is unknown.
 */
export async function geocodeAddress({ street, city, state, postcode }) {
  if (street) {
    const exact = await nominatim({
      street,
      ...(city && { city }),
      ...(state && { state }),
      ...(postcode && { postalcode: postcode }),
    });
    if (exact) return { ...exact, approximate: false };
    if (!city) return null;
    await wait(1100);
  }
  if (!city) return null;
  const center = await nominatim({ city, ...(state && { state }) });
  return center ? { ...center, approximate: true } : null;
}
