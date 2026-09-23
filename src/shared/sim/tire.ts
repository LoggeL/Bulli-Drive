// Normalised tyre curve (docs/phase-1a-design.md, section 6.2): linear up to
// the peak slip angle, then a gentle fall-off to the sliding grip at twice
// the peak, constant beyond. Never drops to 0 and never changes sign.
export function tireCurve(alpha: number, peak: number, slide: number): number {
    const x = Math.abs(alpha) / peak;
    const f = x <= 1 ? x : 1 - (1 - slide) * Math.min(x - 1, 1);
    return alpha < 0 ? -f : alpha > 0 ? f : 0;
}
