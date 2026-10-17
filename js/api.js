// Bar search (Photon) and address lookup (Nominatim). Both are free
// OpenStreetMap services and need no API key.

const PHOTON_URL = 'https://photon.komoot.io/api/';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const BAR_TAGS = ['amenity:bar', 'amenity:pub'];

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
 * Geocode a manually entered address. Called once, when the form is saved.
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
