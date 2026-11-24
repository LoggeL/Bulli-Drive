import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { loadTestMap } from './loadTestMap.js';
import {
    billboardUrl, createFallbackProp, parseBillboardsManifest, parsePropsManifest, propUrl,
    requiredBillboardTexturesForMap, requiredPropModelsForMap
} from '../../src/client/assets/HeroAssetLoader.js';
import {
    BOOST_PAD_BASE_LIFT, BOOST_PAD_DISTANCE_LIFT, DECAL_BASE_LIFT, DECAL_DISTANCE_LIFT,
    heroPropGroundY, HeroPropsLayer, matchPairedBillboards, SAILBOAT_DRAFT, surfaceLiftAtDistance
} from '../../src/client/world/heroProps.js';
import { makeHeightfield } from '../shared/map/fixtures.js';
import { AREA_LIFT, ROAD_LIFT } from '../../src/client/world/roadGeometry.js';
import { ROAD_DISTANCE_LIFT } from '../../src/client/world/roads.js';

const ROOT = path.resolve(__dirname, '../..');

describe('HeroAssetLoader manifest parsing & lazy per-map selection', () => {
    it('parses the shipped props and billboards manifests and rejects malformed payloads', () => {
        const rawProps = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/props/manifest.json'), 'utf8'));
        const props = parsePropsManifest(rawProps);
        expect(props.version).toBe(1);
        expect(Object.keys(props.props)).toHaveLength(24);
        expect(props.props.lmf_red_knopf.animNodes).toEqual(['knopf_cap']);
        expect(props.props.prop_roadside_billboard.billboardNode).toBe('billboard_face');

        const rawBillboards = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/textures/billboards/manifest.json'), 'utf8'));
        const billboards = parseBillboardsManifest(rawBillboards);
        expect(billboards.version).toBe(1);
        expect(billboards.flipY).toBe(true);
        expect(Object.keys(billboards.textures)).toHaveLength(20);

        expect(() => parsePropsManifest(null)).toThrow();
        expect(() => parsePropsManifest({ version: 1, props: { bad: { file: 'x.glb' } } })).toThrow();
        expect(() => parseBillboardsManifest({ version: '1', textures: {} })).toThrow();
        expect(() => parseBillboardsManifest({ version: 1, textures: { bad: { file: 'a.ktx2' } } })).toThrow();
    });

    it('builds content-hashed cache-busting URLs for props and billboards', () => {
        expect(propUrl({ file: 'lmf_red_knopf.glb', hash: 'f8327f004897' }, '/models/props/'))
            .toBe('/models/props/lmf_red_knopf.glb?v=f8327f004897');
        expect(billboardUrl({ file: 'sign_lmf_welcome.ktx2', hash: '4f10501c758fc7c6' }, '/textures/billboards/'))
            .toBe('/textures/billboards/sign_lmf_welcome.ktx2?v=4f10501c758fc7c6');
    });

    it('selects ONLY required models & textures per map so Bulli Bay stays lean', () => {
        const bulliBay = loadTestMap('bulli-bay');
        expect(requiredPropModelsForMap(bulliBay)).toEqual(['prop_roadside_billboard']);
        expect(requiredBillboardTexturesForMap(bulliBay)).toEqual([
            'sign_lmf_welcome', 'sign_oilbert_ad', 'sign_ppk_bulli', 'sign_werkzeugwand'
        ]);

        const loggeForge = loadTestMap('logge-forge');
        const forgeModels = requiredPropModelsForMap(loggeForge);
        expect(forgeModels).toContain('lmf_forge_arch');
        expect(forgeModels).toContain('lmf_red_knopf');
        expect(forgeModels).toContain('lmf_jet_loop_reactor');
        expect(forgeModels).toContain('lmf_melodai_arch');
        expect(forgeModels.length).toBeGreaterThanOrEqual(20);
        expect(requiredBillboardTexturesForMap(loggeForge)).toHaveLength(20);

        const alpen = loadTestMap('alpen-pass');
        const alpenModels = requiredPropModelsForMap(alpen);
        expect(alpenModels).toContain('lmf_alpine_chalet');
        expect(alpenModels).toContain('lmf_ski_gondola_pylon');
        expect(alpenModels).not.toContain('lmf_jet_loop_reactor');
    }, 20_000);

    it('pairs co-located billboards onto hero props carrying billboard_face and flags arch-mounted signs', () => {
        const loggeForge = loadTestMap('logge-forge');
        const { propToBillboard, pairedBillboardIds, mountedOnArchIds } = matchPairedBillboards(
            loggeForge.heroProps, loggeForge.billboards
        );

        // Co-located stand props bind their matching sign directly (no duplicate gantry/billboard stand)
        expect(propToBillboard.get('hp-ppk-gantry')?.id).toBe('bb-ppk-bulli');
        expect(propToBillboard.get('hp-voll-billboard')?.id).toBe('bb-voll-o-meter');
        expect(propToBillboard.get('hp-win98-frame')?.id).toBe('bb-win98-desktop');
        expect(pairedBillboardIds.has('bb-ppk-bulli')).toBe(true);
        expect(pairedBillboardIds.has('bb-voll-o-meter')).toBe(true);
        expect(pairedBillboardIds.has('bb-win98-desktop')).toBe(true);

        // Sign mounted atop lmf_forge_arch (yOffset: 8.2) renders as an arch-mounted sign, not a clipping gantry
        expect(mountedOnArchIds.has('bb-lmf-welcome')).toBe(true);
        // Standalone roadside billboards remain standalone
        expect(pairedBillboardIds.has('bb-werkzeugwand')).toBe(false);
        expect(mountedOnArchIds.has('bb-werkzeugwand')).toBe(false);
    });

    it('creates valid primitive fallbacks with a billboard_face node for billboard stands', () => {
        const stand = createFallbackProp('prop_roadside_billboard');
        const face = stand.getObjectByName('billboard_face');
        expect(face).toBeDefined();
        expect((face as THREE.Mesh).isMesh).toBe(true);

        const monument = createFallbackProp('lmf_red_knopf');
        let meshes = 0;
        monument.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes++; });
        expect(meshes).toBeGreaterThan(0);
    });

    it('lifts ground decals and boost pads strictly above roads/areas at all camera distances', () => {
        for (const dist of [0, 30, 60, 150, 350]) {
            const areaLift = surfaceLiftAtDistance(AREA_LIFT, ROAD_DISTANCE_LIFT, dist);
            const roadLift = surfaceLiftAtDistance(ROAD_LIFT, ROAD_DISTANCE_LIFT, dist);
            const decalLift = surfaceLiftAtDistance(DECAL_BASE_LIFT, DECAL_DISTANCE_LIFT, dist);
            const padLift = surfaceLiftAtDistance(BOOST_PAD_BASE_LIFT, BOOST_PAD_DISTANCE_LIFT, dist);
            expect(decalLift, `decal > road at ${dist}m`).toBeGreaterThan(roadLift);
            expect(padLift, `boostPad > decal at ${dist}m`).toBeGreaterThan(decalLift);
            expect(padLift, `boostPad > area at ${dist}m`).toBeGreaterThan(areaLift);
        }

        // Verify the actual boost pad ShaderMaterial vertex shader applies BOOST_PAD_DISTANCE_LIFT
        const stuntMap = loadTestMap('stunt-forge');
        const layer = new HeroPropsLayer(stuntMap, 'desktop', null);
        const padMesh = layer.boostPadsGroup.getObjectByName('boost-pads-merged') as THREE.Mesh;
        const padMat = padMesh.material as THREE.ShaderMaterial;
        expect(padMat.vertexShader).toContain(String(BOOST_PAD_DISTANCE_LIFT));
        expect(padMat.vertexShader).toContain('cameraPosition');
        layer.dispose();
    });

    it('grounds lmf_sailboat_ijsselmeer at Math.max(waterLevel - 0.35, groundY) and casts desktop shadows on all heroProps', async () => {
        // Deep harbor seabed (-3.5 m) with waterLevel 0 -> floats cleanly at -0.35 m
        const waterHf = makeHeightfield(() => -3.5);
        const boatDef = { id: 'hp-boat', model: 'lmf_sailboat_ijsselmeer' as const, x: 0, z: 0, yaw: 0 };
        expect(heroPropGroundY(boatDef, waterHf)).toBeCloseTo(waterHf.spec.waterLevel - SAILBOAT_DRAFT, 5);
        // Dry land (+4.0 m) -> sits on ground instead of sinking underground
        const dryHf = makeHeightfield(() => 4.0);
        expect(heroPropGroundY(boatDef, dryHf)).toBeCloseTo(4.0, 5);

        // Desktop tier casts shadows on prop_* heroProps (e.g. stunt-kniffel-die), mobile stays 0
        const stuntMap = loadTestMap('stunt-forge');
        const dieDef = stuntMap.heroProps.find(p => p.id === 'stunt-kniffel-die')!;
        const desktopLayer = new HeroPropsLayer(stuntMap, 'desktop', null);
        const mobileLayer = new HeroPropsLayer(stuntMap, 'mobile', null);
        await new Promise(resolve => setTimeout(resolve, 20));
        desktopLayer.update(1 / 60, 0, { x: dieDef.x, y: 0, z: dieDef.z });
        mobileLayer.update(1 / 60, 0, { x: dieDef.x, y: 0, z: dieDef.z });

        const desktopDie = desktopLayer.heroGroup.getObjectByName('hero-stunt-kniffel-die')!;
        const mobileDie = mobileLayer.heroGroup.getObjectByName('hero-stunt-kniffel-die')!;
        let desktopCasters = 0, mobileCasters = 0;
        desktopDie.traverse(o => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).castShadow) desktopCasters++; });
        mobileDie.traverse(o => { if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).castShadow) mobileCasters++; });
        expect(desktopCasters).toBeGreaterThan(0);
        expect(mobileCasters).toBe(0);

        desktopLayer.dispose();
        mobileLayer.dispose();
    });
});
