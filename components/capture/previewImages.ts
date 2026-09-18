export function previewImages(
  images: readonly { id: string; url: string }[],
  groups: readonly { label: string; imageIds: string[] }[],
) {
  return images.map((image, index) => ({
    id: image.id,
    url: image.url,
    label: `Foto ${index + 1} · ${groups.filter((group) => group.imageIds.includes(image.id)).map((group) => group.label).join(" / ") || "Ohne Gruppe"}`,
  }));
}
