// Valibot schemas and deterministic collider builders for per-map discoveries,
// hero monuments/props, custom billboards/decals, and boost pads.
// Everything placed into SimWorld colliders uses exact arithmetic (toMillimetre
// and yawAxis) so client and server produce identical worldHash across engines.

import * as v from 'valibot';
import type { ColliderInput } from '../world/colliders.js';
import { Finite, Id, NonNegative, Positive, schemaErrors, type ParseResult } from './roadSchema.js';
import { toMillimetre, yawAxis, type OBox } from './structures.js';

export const HERO_PROP_MODELS = [
    // Hero Monuments (12)
    'lmf_forge_arch',
    'lmf_red_knopf',
    'lmf_jet_loop_reactor',
    'lmf_arcanum_tower',
    'lmf_selantis_arch',
    'lmf_theater_facade',
    'lmf_melodai_arch',
    'lmf_codex_monolith',
    'lmf_festival_stage',
    'lmf_sailboat_ijsselmeer',
    'lmf_alpine_chalet',
    'lmf_ski_gondola_pylon',
    // Easter-Egg Props (12)
    'prop_fi_toaster_shrine',
    'prop_kniffel_die',
    'prop_sudsblaster',
    'prop_nether_portal',
    'prop_stadtpin_marker',
    'prop_embedding_cube',
    'prop_oilbert_icons',
    'prop_jp_whirlpool_tent',
    'prop_win98_frame',
    'prop_vertical_frame_916',
    'prop_billboard_gantry',
    'prop_roadside_billboard'
] as const;
export type HeroPropModelId = typeof HERO_PROP_MODELS[number];

export const BILLBOARD_TEXTURES = [
    // Signs & Posters (15)
    'sign_lmf_welcome',
    'sign_ppk_bulli',
    'sign_ppk_trio',
    'sign_kolpingtheater',
    'sign_oilbert_ad',
    'sign_win98_desktop',
    'sign_codex_widget',
    'sign_bands_marquee',
    'sign_reactor_safety',
    'sign_arcanum_note',
    'sign_voll_o_meter',
    'sign_selantis_poster',
    'sign_jp_poolparty',
    'sign_abseits_contact',
    'sign_werkzeugwand',
    // Ground Decals (5)
    'decal_saalplan_ag',
    'decal_bomberman_grid',
    'decal_sudoku_grid',
    'decal_geogames_map',
    'decal_kniffel_pips'
] as const;
export type BillboardTextureId = typeof BILLBOARD_TEXTURES[number];

export const DISCOVERY_ALLOYS = ['forge', 'web', 'games', 'ai', 'film', 'alpine', 'stunt', 'coastal'] as const;
export type DiscoveryAlloy = typeof DISCOVERY_ALLOYS[number];

export const REWARD_EFFECTS = ['sparks', 'confetti', 'bubbles', 'runes', 'music', 'laser', 'flash', 'shockwave'] as const;
export type RewardEffect = typeof REWARD_EFFECTS[number];

export const DiscoveryTriggerSchema = v.variant('kind', [
    v.strictObject({ kind: v.literal('proximity'), radius: Positive }),
    v.strictObject({ kind: v.literal('horn'), radius: Positive }),
    v.strictObject({
        kind: v.literal('park'),
        radius: Positive,
        holdSec: Positive,
        maxSpeed: v.optional(Positive)
    }),
    v.strictObject({
        kind: v.literal('airtime'),
        radius: Positive,
        minAirSec: Positive
    }),
    v.strictObject({
        kind: v.literal('speed'),
        radius: Positive,
        minSpeedKmh: Positive
    })
]);
export type DiscoveryTrigger = v.InferOutput<typeof DiscoveryTriggerSchema>;

export const DiscoveryDefSchema = v.strictObject({
    id: Id,
    title: v.pipe(v.string(), v.minLength(1)),
    subtitle: v.pipe(v.string(), v.minLength(1)),
    alloy: v.picklist(DISCOVERY_ALLOYS),
    projectRef: v.optional(v.string()),
    x: Finite,
    z: Finite,
    yOffset: v.optional(Finite),
    hint: v.pipe(v.string(), v.minLength(1)),
    codexEntry: v.pipe(v.string(), v.minLength(1)),
    toast: v.pipe(v.string(), v.minLength(1)),
    rewardEffect: v.picklist(REWARD_EFFECTS),
    trigger: DiscoveryTriggerSchema,
    heroPropId: v.optional(Id),
    secret: v.optional(v.boolean())
});
export type DiscoveryDef = v.InferOutput<typeof DiscoveryDefSchema>;

// JSON cannot encode Infinity, so top accepts a positive finite height or
// 'infinity' (omitted also defaults to Infinity when converting to ColliderInput).
const ColliderTopSchema = v.optional(v.union([Positive, v.literal('infinity')]));

export const HeroPropColliderSchema = v.variant('kind', [
    v.strictObject({
        kind: v.literal('circle'),
        r: Positive,
        top: ColliderTopSchema,
        dx: v.optional(Finite),
        dz: v.optional(Finite)
    }),
    v.strictObject({
        kind: v.literal('obox'),
        hw: Positive,
        hd: Positive,
        top: ColliderTopSchema,
        dx: v.optional(Finite),
        dz: v.optional(Finite)
    })
]);
export type HeroPropCollider = v.InferOutput<typeof HeroPropColliderSchema>;

export const HeroPropDefSchema = v.strictObject({
    id: Id,
    model: v.picklist(HERO_PROP_MODELS),
    x: Finite,
    z: Finite,
    yOffset: v.optional(Finite),
    yaw: Finite,
    scale: v.optional(Positive),
    collider: v.optional(HeroPropColliderSchema),
    colliders: v.optional(v.array(HeroPropColliderSchema)),
    discoveryId: v.optional(Id),
    // Footprint kept clear of procedural buildings & trees even when the prop is
    // drive-through (e.g. arches, portals, recessed pads)
    clearRadius: v.optional(Positive)
});
export type HeroPropDef = v.InferOutput<typeof HeroPropDefSchema>;

export const BillboardDefSchema = v.strictObject({
    id: Id,
    texture: v.picklist(BILLBOARD_TEXTURES),
    kind: v.picklist(['roadside', 'gantry', 'wall', 'decal']),
    x: Finite,
    z: Finite,
    yOffset: v.optional(Finite),
    yaw: Finite,
    width: Positive,
    height: Positive,
    emissive: v.optional(v.boolean()),
    discoveryId: v.optional(Id)
});
export type BillboardDef = v.InferOutput<typeof BillboardDefSchema>;

export const BoostPadDefSchema = v.strictObject({
    id: Id,
    x: Finite,
    z: Finite,
    yaw: Finite,
    width: Positive,
    length: Positive,
    impulseSpeed: Positive,
    boostFill: NonNegative,
    cooldownTicks: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)))
});
export type BoostPadDef = v.InferOutput<typeof BoostPadDefSchema>;

export const DiscoveriesFileSchema = v.strictObject({
    format: v.literal('bulli-discoveries'),
    version: v.literal(1),
    mapId: Id,
    discoveries: v.array(DiscoveryDefSchema),
    heroProps: v.array(HeroPropDefSchema),
    billboards: v.array(BillboardDefSchema),
    boostPads: v.array(BoostPadDefSchema)
});
export type DiscoveriesFile = v.InferOutput<typeof DiscoveriesFileSchema>;

function checkUnique(kind: string, ids: readonly string[], errors: string[]): Set<string> {
    const seen = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) errors.push(`${kind} ${id}: duplicate id`);
        seen.add(id);
    }
    return seen;
}

export function parseDiscoveriesFile(value: unknown): ParseResult<DiscoveriesFile> {
    const parsed = v.safeParse(DiscoveriesFileSchema, value);
    if (!parsed.success) return { ok: false, errors: schemaErrors(parsed.issues) };
    const file = parsed.output;
    const errors: string[] = [];
    const discoveryIds = checkUnique('discovery', file.discoveries.map(d => d.id), errors);
    const propIds = checkUnique('heroProp', file.heroProps.map(p => p.id), errors);
    checkUnique('billboard', file.billboards.map(b => b.id), errors);
    checkUnique('boostPad', file.boostPads.map(b => b.id), errors);

    for (const d of file.discoveries) {
        if (d.heroPropId && !propIds.has(d.heroPropId)) {
            errors.push(`discovery ${d.id}: unknown heroPropId ${d.heroPropId}`);
        }
    }
    for (const p of file.heroProps) {
        if (p.discoveryId && !discoveryIds.has(p.discoveryId)) {
            errors.push(`heroProp ${p.id}: unknown discoveryId ${p.discoveryId}`);
        }
    }
    for (const b of file.billboards) {
        if (b.discoveryId && !discoveryIds.has(b.discoveryId)) {
            errors.push(`billboard ${b.id}: unknown discoveryId ${b.discoveryId}`);
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, value: file };
}

function resolveTop(top: number | 'infinity' | undefined): number {
    return top === undefined || top === 'infinity' ? Infinity : top;
}

/** Deterministic world colliders for a HeroPropDef (supports local offsets for arch pillars). */
export function heroPropColliders(prop: HeroPropDef): ColliderInput[] {
    const shapes: HeroPropCollider[] = [];
    if (prop.collider) shapes.push(prop.collider);
    if (prop.colliders) shapes.push(...prop.colliders);
    if (!shapes.length) return [];

    const scale = prop.scale ?? 1;
    const [ux, uz] = yawAxis(prop.yaw);
    // Local +x is right-handed perpendicular (uz, -ux), matching structures.ts
    const out: ColliderInput[] = [];
    for (const shape of shapes) {
        const dx = (shape.dx ?? 0) * scale;
        const dz = (shape.dz ?? 0) * scale;
        const x = toMillimetre(prop.x + dx * uz + dz * ux);
        const z = toMillimetre(prop.z - dx * ux + dz * uz);
        const top = resolveTop(shape.top);
        if (shape.kind === 'circle') {
            out.push({
                kind: 'circle', x, z,
                r: toMillimetre(shape.r * scale),
                top: top === Infinity ? Infinity : toMillimetre(top * scale)
            });
        } else {
            out.push({
                kind: 'obox', x, z,
                hw: toMillimetre(shape.hw * scale),
                hd: toMillimetre(shape.hd * scale),
                ux, uz,
                top: top === Infinity ? Infinity : toMillimetre(top * scale)
            });
        }
    }
    return out;
}

/** Reserved keep-out boxes for a HeroPropDef so procedural buildings/trees never clip it. */
export function heroPropReservedBoxes(prop: HeroPropDef): OBox[] {
    const [ux, uz] = yawAxis(prop.yaw);
    const scale = prop.scale ?? 1;
    const boxes: OBox[] = [];
    if (prop.clearRadius !== undefined) {
        const r = toMillimetre(prop.clearRadius * scale);
        boxes.push({ x: toMillimetre(prop.x), z: toMillimetre(prop.z), hw: r, hd: r, ux, uz });
    }
    for (const c of heroPropColliders(prop)) {
        if (c.kind === 'circle') {
            boxes.push({ x: c.x, z: c.z, hw: c.r + 1, hd: c.r + 1, ux: 0, uz: 1 });
        } else if (c.kind === 'obox') {
            boxes.push({ x: c.x, z: c.z, hw: c.hw + 1, hd: c.hd + 1, ux: c.ux, uz: c.uz });
        }
    }
    return boxes;
}

/** Reserved keep-out box for a roadside/gantry billboard so trees do not block its face. */
export function billboardReservedBox(b: BillboardDef): OBox {
    const [ux, uz] = yawAxis(b.yaw);
    if (b.kind === 'decal') {
        return { x: toMillimetre(b.x), z: toMillimetre(b.z), hw: toMillimetre(b.width / 2), hd: toMillimetre(b.height / 2), ux, uz };
    }
    return { x: toMillimetre(b.x), z: toMillimetre(b.z), hw: toMillimetre(b.width / 2 + 1), hd: 2.5, ux, uz };
}

/** Reserved keep-out box for a boost pad so trees/buildings do not obstruct approach/exit. */
export function boostPadReservedBox(pad: BoostPadDef): OBox {
    const [ux, uz] = yawAxis(pad.yaw);
    return {
        x: toMillimetre(pad.x), z: toMillimetre(pad.z),
        hw: toMillimetre(pad.width / 2 + 2),
        hd: toMillimetre(pad.length / 2 + 4),
        ux, uz
    };
}
