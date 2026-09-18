export interface RectangleLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function overlayBounds(
  width: number,
  height: number,
  displayBounds: RectangleLike,
  workArea: RectangleLike,
  margin: number,
) {
  const displayBottom = displayBounds.y + displayBounds.height;
  const usableBottom = Math.min(displayBottom, workArea.y + workArea.height);
  return {
    width,
    height,
    x: displayBounds.x + Math.floor((displayBounds.width - width) / 2),
    y: usableBottom - height - margin,
  };
}
