// The light of a curated map (map.json `lighting`, world-look.md): the sun's
// compass azimuth (degrees from north, clockwise) and its elevation. The map
// convention is north = -z, east = +x (design E2).
//
// The client's look (src/client/render/look.ts) measures its sunAzimuth
// from +z towards +x: direction (sin a · cos e, sin e, cos a · cos e). A
// compass azimuth c points to (sin c, -cos c) in x-z, which is the look's
// azimuth 180° - c. Looks only; the sim never reads it.

export interface MapLighting { sunAzimuth: number; sunElevation: number }

// Compass azimuth → the azimuth of look.ts, in [0, 360)
export function lookAzimuth(compass: number): number {
    return ((180 - compass) % 360 + 360) % 360;
}

// Unit vector from the scene towards the sun (x, y, z)
export function sunDirection(light: MapLighting): [number, number, number] {
    const c = light.sunAzimuth * Math.PI / 180, e = light.sunElevation * Math.PI / 180;
    return [Math.sin(c) * Math.cos(e), Math.sin(e), -Math.cos(c) * Math.cos(e)];
}
