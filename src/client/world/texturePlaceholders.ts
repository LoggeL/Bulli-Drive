// The texel a world texture shows until its KTX2 file has loaded, or for
// good when it failed (textures.ts): neutral for its kind, never black.

/** RGBA texel (0..255) and color space of the placeholder for the texture `name`. */
export function placeholderTexel(name: string, fallback?: number): { rgba: [number, number, number, number]; srgb: boolean } {
    // Normal maps: flat; ARM: no occlusion, rough, not metallic
    if (/_normal$/.test(name)) return { rgba: [128, 128, 255, 255], srgb: false };
    if (/_arm$/.test(name)) return { rgba: [255, 210, 0, 255], srgb: false };
    if (/world_noise$/.test(name)) return { rgba: [128, 128, 128, 128], srgb: false };
    if (/_emissive$/.test(name)) return { rgba: [0, 0, 0, 255], srgb: true };
    // Foliage cut-outs stay invisible rather than becoming solid cards
    if (/(fronds|tree_cards|shrubs)$/.test(name)) return { rgba: [96, 100, 70, 0], srgb: true };
    const hex = fallback ?? 0xbdb3a4;
    return { rgba: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255], srgb: true };
}
