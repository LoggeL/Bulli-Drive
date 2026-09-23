import { describe, expect, it } from 'vitest';
import { MEGA_SCALE } from '../../../src/shared/constants.js';
import { applyModifiers } from '../../../src/shared/sim/modifiers.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import { createVehicleModifiers } from '../../../src/shared/sim/types.js';
import { createVehicleParams } from '../../../src/shared/sim/vehicleClasses.js';
import { drive, spawnCar } from './helpers.js';

// Powerup modifiers (docs/phase-1a-design.md, section 10)

describe('applyModifiers', () => {
    const base = createVehicleParams('bulli');
    const frozen = JSON.stringify(base);

    it('copies the base without modifiers and writes into the given object', () => {
        const out = createVehicleParams('pickup');
        expect(applyModifiers(base, createVehicleModifiers(), 1, out)).toBe(out);
        expect(out).toStrictEqual(base);
    });

    it('Turbo: top speed ×1.3, acceleration ×1.5, no extra grip', () => {
        const out = applyModifiers(base, { ...createVehicleModifiers(), turbo: true }, 1, createVehicleParams('bulli'));
        expect(out.topSpeed).toBeCloseTo(65, 12);
        expect(out.accel).toBeCloseTo(8.5 * 1.5, 12);
        expect(out.aeroGrip).toBe(base.aeroGrip);
        expect(out.gripFront).toBe(base.gripFront);
    });

    it('Mega: circles follow the scale, contact mass ×3, mass ratio cap 3.5', () => {
        const out = applyModifiers(base, { ...createVehicleModifiers(), mega: true }, MEGA_SCALE, createVehicleParams('bulli'));
        expect(out.colliderRadius).toBeCloseTo(1.3 * MEGA_SCALE, 12);
        expect(out.colliderOffset).toBeCloseTo(0.7 * MEGA_SCALE, 12);
        expect(out.contactMass).toBe(4500);
        expect(out.massRatioCap).toBe(3.5);
        // Driving behaviour stays the same
        expect(out.mass).toBe(1500);
        expect(out.yawRadius).toBe(base.yawRadius);
    });

    it('Super Jump sets the take-off speed to 20 m/s', () => {
        const out = applyModifiers(base, { ...createVehicleModifiers(), superJump: true }, 1, createVehicleParams('bulli'));
        expect(out.jumpSpeed).toBe(20);
    });

    it('Shield: no wall rebound and twice the contact mass', () => {
        const out = applyModifiers(base, { ...createVehicleModifiers(), shield: true }, 1, createVehicleParams('bulli'));
        expect(out.restitutionWall).toBe(0);
        expect(out.contactMass).toBe(3000);
    });

    it('never changes the base params', () => {
        applyModifiers(base, { turbo: true, mega: true, superJump: true, ghost: true, shield: true }, 2, createVehicleParams('bulli'));
        expect(JSON.stringify(base)).toBe(frozen);
    });
});

describe('Mega scale', () => {
    it('eases to MEGA_SCALE and back like the legacy look', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.mods.mega = true;
        drive(car, world, 30, {});
        // 1 - e^(-6·0.5) = 95 %
        expect(car.state.scale).toBeGreaterThan(1 + 1.5 * 0.94);
        drive(car, world, 150, {});
        expect(car.state.scale).toBe(MEGA_SCALE);
        expect(car.params.colliderRadius).toBeCloseTo(1.3 * MEGA_SCALE, 12);
        car.mods.mega = false;
        drive(car, world, 180, {});
        expect(car.state.scale).toBe(1);
        expect(car.params.colliderRadius).toBe(1.3);
    });
});
