// Shrink photos before they go into IndexedDB.

const MAX_SIDE = 1600;
const QUALITY = 0.85;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read "${file.name || 'photo'}". Is it an image?`));
    };
    img.src = url;
  });
}

/** Resize to at most 1600px on the longest side and re-encode as JPEG. */
export async function resizePhoto(file) {
  const { img, url } = await loadImage(file);
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // JPEG has no transparency
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
    if (!blob) throw new Error('Couldn\'t process that photo.');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Resize a list of files, skipping (and reporting) any that fail. */
export async function resizePhotos(files) {
  const blobs = [];
  const errors = [];
  for (const file of files) {
    try {
      blobs.push(await resizePhoto(file));
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { blobs, errors };
}
