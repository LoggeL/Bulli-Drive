import { describe, expect, it } from 'vitest';
import { BTN_HANDBRAKE, BTN_JUMP, BTN_RESET, DT, SIM_TUNING } from '../../../src/shared/sim/constants.js';
import { createFlatWorld, FLAT_TERRAIN } from '../../../src/shared/sim/scenarios.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { createSimWorld, rampEdgeColliders, type RampDef } from '../../../src/shared/world/colliders.js';
import { TERRAIN_FLAT_AREA, getTerrainHeight } from '../../../src/shared/world/terrain.js';
import { DEFAULT_TERRAIN_CONFIG } from '../../../src/shared/constants.js';
import { DEG, drive, forwardSpeed, spawnCar, speedOf } from './helpers.js';

// Jump, flight, ramps, slopes and reset (docs/phase-1a-design.md, 6.4-6.7)

function jumpProfile(superJump: boolean) {
    const world = createFlatWorld();
    const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
    car.mods.superJump = superJump;
    let apex = 0, airTicks = 0, jumps = 0, flipMax = 0, landed = 0;
    // The jump key stays held the whole time: exactly one jump
    drive(car, world, 240, { buttons: BTN_JUMP }, () => {
        apex = Math.max(apex, car.state.y);
        if (!car.state.grounded) airTicks++;
        if (car.events.jumped) jumps++;
        if (car.events.landedImpact > 0) landed = car.events.landedImpact;
        flipMax = Math.max(flipMax, car.state.flipAngle);
    });
    return { apex, flight: airTicks * DT, jumps, flipMax, landed, car };
}

describe('v2 jump', () => {
    it('jumps once per key press to a 3 m apex with 1.1 s of flight, for every class', () => {
        const { apex, flight, jumps, flipMax, landed, car } = jumpProfile(false);
        expect(jumps).toBe(1);
        expect(apex).toBeGreaterThan(2.9);
        expect(apex).toBeLessThan(3.1);
        expect(flight).toBeGreaterThan(1.05);
        expect(flight).toBeLessThan(1.15);
        // One flip over the flight time, cleared on landing
        expect(flipMax).toBeGreaterThan(5.8);
        expect(car.state.flipAngle).toBe(0);
        expect(landed).toBeGreaterThan(10);
        expect(car.state.grounded).toBe(true);
        expect(car.state.y).toBe(0);
        for (const classId of CAR_CLASS_IDS) {
            expect(spawnCar(createFlatWorld(), 'a', classId, 0, 0, 0).base.jumpSpeed).toBe(11);
        }
    });

    it('Super Jump reaches about 10 m and 2 s of flight', () => {
        const { apex, flight, jumps } = jumpProfile(true);
        expect(jumps).toBe(1);
        expect(apex).toBeGreaterThan(9.8);
        expect(apex).toBeLessThan(10.2);
        expect(flight).toBeGreaterThan(1.95);
        expect(flight).toBeLessThan(2.05);
    });

    it('jumps again after releasing and pressing, but not during the cooldown in the air', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        const jumpTicks: number[] = [];
        // Tap every other tick: a new jump starts right after each landing
        drive(car, world, 200, tick => ({ buttons: tick % 2 === 0 ? BTN_JUMP : 0 }), tick => {
            if (car.events.jumped) jumpTicks.push(tick);
        });
        expect(jumpTicks.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < jumpTicks.length; i++) {
            // A jump lasts 66 ticks
            expect(jumpTicks[i] - jumpTicks[i - 1]).toBeGreaterThanOrEqual(64);
            expect(jumpTicks[i] - jumpTicks[i - 1]).toBeLessThanOrEqual(69);
        }
    });

    it('allows a jump within the coyote ticks after driving off an edge', () => {
        const ramp = { x: 0, z: 0, yaw: 0, width: 8, length: 16, height: 2 };
        const tryJumpAfter = (delay: number) => {
            const world = createFlatWorld([], [ramp]);
            const car = spawnCar(world, 'a', 'bulli', 0, -20, 0, 20);
            let leftTick = -1, jumped = false;
            drive(car, world, 90, tick => ({
                throttle: 255,
                buttons: leftTick >= 0 && tick === leftTick + delay ? BTN_JUMP : 0
            }), tick => {
                if (leftTick < 0 && !car.state.grounded) leftTick = tick + 1;
                jumped ||= car.events.jumped;
            });
            expect(leftTick).toBeGreaterThan(0);
            return jumped;
        };
        expect(tryJumpAfter(1)).toBe(true);
        expect(tryJumpAfter(SIM_TUNING.COYOTE_TICKS - 1)).toBe(true);
        expect(tryJumpAfter(SIM_TUNING.COYOTE_TICKS + 2)).toBe(false);
    });

    it('steers the yaw gently in the air', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        drive(car, world, 1, { buttons: BTN_JUMP });
        drive(car, world, 30, { steer: 127 });
        expect(car.state.grounded).toBe(false);
        expect(car.state.yawRate).toBeGreaterThan(1);
        expect(car.state.yawRate).toBeLessThanOrEqual(SIM_TUNING.AIR_YAW);
    });
});

describe('v2 ramps and terrain', () => {
    it('takes off at a ramp edge, flies and lands further on', () => {
        const ramp = { x: 0, z: -300, yaw: 0, width: 8, length: 16, height: 3 };
        const world = createFlatWorld([], [ramp]);
        expect(world.groundHeight(0, -308)).toBeCloseTo(0, 12);
        expect(world.groundHeight(0, -300)).toBeCloseTo(1.5, 12);
        expect(world.groundHeight(3.9, -292.01)).toBeCloseTo(3, 2);
        expect(world.groundHeight(4.1, -300)).toBe(0);
        const car = spawnCar(world, 'a', 'beetle', 0, -340, 0, 25);
        let takeOffZ = 0, landZ = 0, apex = 0;
        drive(car, world, 180, { throttle: 255 }, () => {
            if (!takeOffZ && !car.state.grounded) takeOffZ = car.state.z;
            if (takeOffZ && !landZ && car.state.grounded) landZ = car.state.z;
            apex = Math.max(apex, car.state.y);
        });
        expect(takeOffZ).toBeGreaterThan(-293);
        expect(takeOffZ).toBeLessThan(-290);
        expect(apex).toBeGreaterThan(3.5);
        expect(landZ - takeOffZ).toBeGreaterThan(15);
        expect(car.state.grounded).toBe(true);
    });

    it('follows the default terrain on the ground at speed', () => {
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
        const car = spawnCar(world, 'a', 'bulli', 250, -450, 0, 30);
        let groundedTicks = 0;
        drive(car, world, 600, { throttle: 180 }, () => {
            if (car.state.grounded) {
                groundedTicks++;
                expect(car.state.y).toBe(getTerrainHeight(DEFAULT_TERRAIN_CONFIG, car.state.x, car.state.z));
            }
        });
        expect(groundedTicks).toBeGreaterThan(560);
    });

    it('keeps rolling downhill on a steep slope without input and holds with the handbrake', () => {
        // h = 30·sin(0.01·x) + 30·cos(0.01·z), far from the flattened city
        const terrain = { ...FLAT_TERRAIN, size: 4000, frequency1: 0.01, amplitude1: 30 };
        const world = createSimWorld(terrain, [], []);
        // At x = 300π, z = 0 the slope is -0.3 along +x (downhill towards +x)
        const x = 300 * Math.PI;
        expect(world.groundHeight(x + 0.5, 0) - world.groundHeight(x - 0.5, 0)).toBeCloseTo(-0.3, 3);
        // A car standing still stays put (standstill snap), a rolling one
        // gains speed: 0.3·9.81 m/s² beat the 1.9 m/s² of rolling and engine drag
        const rolling = spawnCar(world, 'a', 'bulli', x, 0, Math.PI / 2, 2);
        drive(rolling, world, 60, {});
        expect(forwardSpeed(rolling.state)).toBeGreaterThan(2.8);
        const braking = spawnCar(world, 'a', 'bulli', x, 0, Math.PI / 2);
        // (The brake would start reversing after 8 ticks at a standstill)
        drive(braking, world, 60, { buttons: BTN_HANDBRAKE });
        expect(speedOf(braking)).toBeLessThan(0.1);
    });
});

describe('v2 ramp edges and terrain kinks', () => {
    // The 20° kicker of the sandbox, 8 m wide and 12 m long, with its walls
    const kicker: RampDef = { x: 0, z: 0, yaw: 0, width: 8, length: 12, height: 12 * Math.tan(20 * DEG) };
    const withWalls = () => createFlatWorld(rampEdgeColliders(kicker, 0).map(wall => ({ ...wall })), [kicker]);

    it('does not launch the car at the kink of the city blend ring, out of town or into it', () => {
        const world = createSimWorld(DEFAULT_TERRAIN_CONFIG, [], []);
        const { centerX, centerZ, flatRadius, blendRadius } = TERRAIN_FLAT_AREA;
        let worst = 0;
        for (let deg = 0; deg < 360; deg += 15) {
            const ux = Math.cos(deg * DEG), uz = Math.sin(deg * DEG);
            for (const dir of [1, -1]) {
                const d0 = dir === 1 ? flatRadius + 10 : flatRadius + blendRadius + 40;
                const car = spawnCar(world, 'a', 'bulli', centerX + ux * d0, centerZ + uz * d0, Math.atan2(ux * dir, uz * dir), 45);
                drive(car, world, 90, { throttle: 255 }, () => {
                    worst = Math.max(worst, car.state.y - world.groundHeight(car.state.x, car.state.z));
                });
            }
        }
        expect(worst).toBeLessThan(0.3);
    });

    it('reads the ramp slope, not the step at its edge: no push before take-off', () => {
        const world = createFlatWorld([], [kicker]);
        const car = spawnCar(world, 'a', 'beetle', 0, -20, 0, 20);
        let prevU = forwardSpeed(car.state), maxGain = -Infinity;
        drive(car, world, 90, {}, () => {
            if (car.state.grounded && car.state.z > -6) maxGain = Math.max(maxGain, forwardSpeed(car.state) - prevU);
            prevU = forwardSpeed(car.state);
        });
        // Coasting uphill only ever loses speed
        expect(maxGain).toBeLessThan(0);
    });

    it('lands beside or on the edge of a ramp with the impact of its vertical speed', () => {
        for (const x0 of [4.2, 4.6, 5.5]) {
            const world = createFlatWorld([], [kicker]);
            const car = spawnCar(world, 'a', 'beetle', x0, -3, -Math.PI / 2);
            const onRamp = x0 < 4;
            car.state.vx = -20;
            car.state.vy = -5;
            car.state.y = world.groundHeight(x0 - 0.5, -3) + 0.1;
            car.state.grounded = false;
            let impact = 0;
            drive(car, world, 30, {}, () => {
                if (!impact && car.events.landedImpact > 0) impact = car.events.landedImpact;
            });
            expect(impact, `x0 ${x0}${onRamp ? ' on the ramp' : ''}`).toBeGreaterThan(4);
            expect(impact, `x0 ${x0}`).toBeLessThan(7);
        }
    });

    it('the walls stop a car jumping at the front or side of the ramp below its top', () => {
        const runs = [
            { x: 0, z: 30, yaw: Math.PI },          // towards the high front face
            { x: 25, z: 3, yaw: -Math.PI / 2 },     // towards a side, high part
            { x: -25, z: 4, yaw: Math.PI / 2 }
        ];
        for (const run of runs) {
            for (let jumpTick = 0; jumpTick <= 30; jumpTick += 5) {
                const world = withWalls();
                const car = spawnCar(world, 'a', 'beetle', run.x, run.z, run.yaw, 15);
                let prevY = car.state.y, maxY = 0;
                drive(car, world, 120, tick => ({ throttle: 255, buttons: tick === jumpTick ? BTN_JUMP : 0 }), () => {
                    // The underside never pops up by more than the flight allows
                    expect(car.state.y - prevY, `${run.x}/${run.z} jump at ${jumpTick}`)
                        .toBeLessThanOrEqual(Math.max(0, car.state.vy) * DT + 0.2);
                    prevY = car.state.y;
                    maxY = Math.max(maxY, car.state.y);
                });
                // It never got onto the ramp: the jump alone reaches 3 m
                expect(maxY).toBeLessThan(3.1);
                expect(car.state.y).toBe(0);
            }
        }
    });

    it('rolls off a side of the ramp without a sideways jump', () => {
        for (const classId of CAR_CLASS_IDS) {
            for (const [speed, yawDeg] of [[8, 80], [20, 80], [8, 100], [20, 90]]) {
                const low: RampDef = { x: 0, z: 0, yaw: 0, width: 8, length: 16, height: 16 * Math.tan(10 * DEG) };
                const world = createFlatWorld(rampEdgeColliders(low, 0).map(wall => ({ ...wall })), [low]);
                const car = spawnCar(world, 'a', classId, 0, -6.5, yawDeg * DEG, speed);
                car.state.y = world.groundHeight(0, -6.5);
                let { x, z } = car.state;
                drive(car, world, 60, { throttle: 128 }, () => {
                    const moved = Math.hypot(car.state.x - x, car.state.z - z);
                    expect(moved, `${classId} ${speed} m/s ${yawDeg}°`).toBeLessThanOrEqual(speedOf(car) * DT + 0.05);
                    ({ x, z } = car.state);
                });
                expect(car.state.x).toBeGreaterThan(4 + 1);
            }
        }
    });
});

describe('v2 reset', () => {
    it('resets after holding R for 30 ticks: stops, stands on the ground and ghosts cars', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 5, hd: 5, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -8, 0, 0);
        // Wedged half into the building
        car.state.z = -5.5;
        car.state.vz = 3;
        let resets = 0, resetTick = -1;
        drive(car, world, 60, { buttons: BTN_RESET, throttle: 255 }, tick => {
            if (car.events.reset) { resets++; resetTick = tick; }
        });
        expect(resets).toBe(1);
        expect(resetTick).toBe(29);
        expect(car.state.ghostTicks).toBe(SIM_TUNING.RESET_GHOST_TICKS - 31);
        // Free of the building (front circle radius 1.3 at +0.7)
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(-5 + 1e-6);
    });

    it('does not reset on a short press', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 10);
        drive(car, world, 29, { buttons: BTN_RESET });
        drive(car, world, 5, {});
        expect(car.state.ghostTicks).toBe(0);
        expect(speedOf(car)).toBeGreaterThan(5);
    });
});
