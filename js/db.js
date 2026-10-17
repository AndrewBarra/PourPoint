// IndexedDB storage: bars, drinks and photos all live in the browser.

const DB_NAME = 'pourpoint';
const DB_VERSION = 2;

export const CATEGORIES = [
  { key: 'drinks', label: 'Drinks' },
  { key: 'location', label: 'Location' },
  { key: 'food', label: 'Food' },
  { key: 'ambiance', label: 'Ambiance' },
  { key: 'service', label: 'Service' },
];

export const SPIRITS = ['gin', 'whiskey', 'rum', 'tequila', 'mezcal', 'vodka', 'brandy', 'other'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const bars = db.objectStoreNames.contains('bars')
        ? req.transaction.objectStore('bars')
        : db.createObjectStore('bars', { keyPath: 'id' });
      if (!bars.indexNames.contains('osmId')) bars.createIndex('osmId', 'osmId', { unique: false });
      if (!bars.indexNames.contains('googlePlaceId')) bars.createIndex('googlePlaceId', 'googlePlaceId', { unique: false });
      if (!db.objectStoreNames.contains('drinks')) {
        const drinks = db.createObjectStore('drinks', { keyPath: 'id' });
        drinks.createIndex('barId', 'barId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Ask the browser not to evict our data. Returns true when granted. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}

/** Average of the rated categories, or null when nothing is rated. */
export function overallScore(bar) {
  const values = CATEGORIES.map((c) => bar.ratings?.[c.key]).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---- Bars ----

export async function getAllBars() {
  return promisify((await store('bars')).getAll());
}

export async function getBar(id) {
  return promisify((await store('bars')).get(id));
}

export async function findBarByOsmId(osmId) {
  if (!osmId) return null;
  const index = (await store('bars')).index('osmId');
  return (await promisify(index.get(osmId))) || null;
}

export async function findBarByGooglePlaceId(placeId) {
  if (!placeId) return null;
  const index = (await store('bars')).index('googlePlaceId');
  return (await promisify(index.get(placeId))) || null;
}

export async function saveBar(bar) {
  bar.updatedAt = new Date().toISOString();
  await promisify((await store('bars', 'readwrite')).put(bar));
  return bar;
}

/** Delete a bar together with its drinks and every photo they reference. */
export async function deleteBar(id) {
  const db = await open();
  const tx = db.transaction(['bars', 'drinks', 'photos'], 'readwrite');
  const bars = tx.objectStore('bars');
  const drinks = tx.objectStore('drinks');
  const photos = tx.objectStore('photos');
  const bar = await promisify(bars.get(id));
  const barDrinks = await promisify(drinks.index('barId').getAll(id));
  const photoIds = [...(bar?.photoIds || []), ...barDrinks.flatMap((d) => d.photoIds || [])];
  photoIds.forEach((pid) => photos.delete(pid));
  barDrinks.forEach((d) => drinks.delete(d.id));
  bars.delete(id);
  await done(tx);
  return photoIds;
}

// ---- Drinks ----

export async function getAllDrinks() {
  return promisify((await store('drinks')).getAll());
}

export async function getDrinksForBar(barId) {
  return promisify((await store('drinks')).index('barId').getAll(barId));
}

export async function saveDrink(drink) {
  drink.updatedAt = new Date().toISOString();
  await promisify((await store('drinks', 'readwrite')).put(drink));
  return drink;
}

export async function deleteDrink(id) {
  const db = await open();
  const tx = db.transaction(['drinks', 'photos'], 'readwrite');
  const drinks = tx.objectStore('drinks');
  const drink = await promisify(drinks.get(id));
  (drink?.photoIds || []).forEach((pid) => tx.objectStore('photos').delete(pid));
  drinks.delete(id);
  await done(tx);
  return drink?.photoIds || [];
}

// ---- Photos ----

export async function addPhoto(blob) {
  const photo = { id: newId(), blob, createdAt: new Date().toISOString() };
  await promisify((await store('photos', 'readwrite')).put(photo));
  return photo.id;
}

export async function getPhoto(id) {
  return promisify((await store('photos')).get(id));
}

export async function deletePhotos(ids) {
  if (!ids.length) return;
  const db = await open();
  const tx = db.transaction('photos', 'readwrite');
  ids.forEach((id) => tx.objectStore('photos').delete(id));
  await done(tx);
}

// ---- Backup ----

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Everything, photos included, as one JSON-serializable object. */
export async function exportAll() {
  const [bars, drinks, photos] = await Promise.all([
    getAllBars(),
    getAllDrinks(),
    promisify((await store('photos')).getAll()),
  ]);
  const encoded = [];
  for (const p of photos) {
    encoded.push({ id: p.id, createdAt: p.createdAt, data: await blobToDataUrl(p.blob) });
  }
  return {
    app: 'PourPoint',
    version: 1,
    exportedAt: new Date().toISOString(),
    bars,
    drinks,
    photos: encoded,
  };
}

/**
 * Merge a backup into the database. Records with the same id are replaced,
 * everything else already saved is kept. Returns counts of what was imported.
 */
export async function importAll(data) {
  if (!data || data.app !== 'PourPoint' || !Array.isArray(data.bars)) {
    throw new Error('This file is not a PourPoint backup.');
  }
  const drinks = Array.isArray(data.drinks) ? data.drinks : [];
  const photos = Array.isArray(data.photos) ? data.photos : [];
  for (const b of data.bars) {
    if (!b || typeof b.id !== 'string' || typeof b.name !== 'string' ||
        typeof b.lat !== 'number' || typeof b.lon !== 'number') {
      throw new Error('The backup contains a bar with missing or invalid fields.');
    }
  }
  for (const d of drinks) {
    if (!d || typeof d.id !== 'string' || typeof d.barId !== 'string') {
      throw new Error('The backup contains a drink with missing or invalid fields.');
    }
  }
  // Decode photos before opening the write transaction (IndexedDB transactions
  // close if we await unrelated work in the middle of them).
  const decoded = [];
  for (const p of photos) {
    if (!p || typeof p.id !== 'string' || typeof p.data !== 'string' || !p.data.startsWith('data:image/')) continue;
    decoded.push({ id: p.id, createdAt: p.createdAt || new Date().toISOString(), blob: await dataUrlToBlob(p.data) });
  }
  const db = await open();
  const tx = db.transaction(['bars', 'drinks', 'photos'], 'readwrite');
  data.bars.forEach((b) => tx.objectStore('bars').put(b));
  drinks.forEach((d) => tx.objectStore('drinks').put(d));
  decoded.forEach((p) => tx.objectStore('photos').put(p));
  await done(tx);
  return { bars: data.bars.length, drinks: drinks.length, photos: decoded.length };
}
