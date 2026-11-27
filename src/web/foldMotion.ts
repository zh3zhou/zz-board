import type { FloatingLinkGeometry, NodeRect } from './linkGeometry.js';

/** World-space motion: animate a center-origin wrapper, never its persisted position.
 * Reverse these same frames with WAAPI direction:'reverse' to unfold. */
export function foldMotionFrames(note: NodeRect, host: NodeRect, link: FloatingLinkGeometry, noteIsSource: boolean): Keyframe[] {
  const origin = { x: note.x + note.width / 2, y: note.y + note.height / 2 };
  const destination = { x: host.x + host.width / 2, y: host.y + host.height / 2 };
  const points = [origin];
  for (let index = 0; index <= 16; index += 1) {
    const t = noteIsSource ? index / 16 : 1 - index / 16;
    const u = 1 - t;
    points.push({
      x: u ** 3 * link.source.x + 3 * u ** 2 * t * link.control1.x + 3 * u * t ** 2 * link.control2.x + t ** 3 * link.target.x,
      y: u ** 3 * link.source.y + 3 * u ** 2 * t * link.control1.y + 3 * u * t ** 2 * link.control2.y + t ** 3 * link.target.y
    });
  }
  points.push(destination);
  // Arc-length offsets keep the center-to-boundary sections from consuming a
  // fixed share of the animation on unusually small, large or overlapping cards.
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(lengths[index - 1]! + Math.hypot(points[index]!.x - points[index - 1]!.x, points[index]!.y - points[index - 1]!.y));
  }
  const total = lengths.at(-1)!;
  return points.map((point, index) => {
    const progress = total > 1e-9 ? lengths[index]! / total : index / (points.length - 1);
    return {
      offset: progress,
      transform: `translate(${point.x - origin.x}px, ${point.y - origin.y}px) scale(${1 - 0.94 * progress})`,
      opacity: 1 - progress ** 2,
      transformOrigin: '50% 50%'
    };
  });
}
