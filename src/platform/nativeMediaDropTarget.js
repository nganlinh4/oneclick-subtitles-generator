export const isPhysicalPointInsideElement = (
  position,
  element,
  viewportWindow = window,
  viewportDocument = document
) => {
  if (!position || !element) return false;
  const scaleFactor = viewportWindow.devicePixelRatio;
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return false;
  const clientX = position.x / scaleFactor;
  const clientY = position.y / scaleFactor;
  if (!Number.isFinite(clientX)
      || !Number.isFinite(clientY)
      || clientX < 0
      || clientY < 0
      || clientX >= viewportWindow.innerWidth
      || clientY >= viewportWindow.innerHeight) {
    return false;
  }
  const target = viewportDocument.elementFromPoint(clientX, clientY);
  return Boolean(target && (target === element || element.contains(target)));
};
