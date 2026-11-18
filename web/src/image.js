// Downscale in the browser before upload: smaller uploads, faster analysis, and
// re-encoding through a canvas strips EXIF metadata such as GPS location.
const MAX_SIDE = 1600;

export async function prepareImage(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Please choose a JPEG, PNG or WebP image.");
  }
  if (file.size > 25 * 1024 * 1024) throw new Error("That file is over 25 MB.");

  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("Could not process that image.");
  return blob;
}
