export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const BROAD_SCALE_ENTER_ZOOM = 0.4;
export const BROAD_SCALE_EXIT_ZOOM = 0.48;

export function selectionAfterClick(current: readonly string[], id: string, additive: boolean): string[] {
  if (!additive) return [id];
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}

export function selectionAfterMarquee(current: readonly string[], hits: readonly string[], additive: boolean): string[] {
  if (!additive) return unique(hits);
  return unique([...current, ...hits]);
}

export function intersectsRect(first: ScreenRect, second: ScreenRect): boolean {
  return first.left <= second.right && first.right >= second.left && first.top <= second.bottom && first.bottom >= second.top;
}

export function dragRect(startX: number, startY: number, currentX: number, currentY: number): ScreenRect {
  return {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    right: Math.max(startX, currentX),
    bottom: Math.max(startY, currentY)
  };
}

export function isBroadScale(zoom: number, wasBroad: boolean): boolean {
  return wasBroad ? zoom < BROAD_SCALE_EXIT_ZOOM : zoom <= BROAD_SCALE_ENTER_ZOOM;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
