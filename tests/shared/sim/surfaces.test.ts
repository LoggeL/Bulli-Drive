import { describe, expect, it } from 'vitest';
import { SURFACE } from '../../../src/shared/map/types.js';
import { BTN_BOOST, DT, SIM_TUNING as T } from '../../../src/shared/sim/constants.js';
import { VEHICLE_CLASSES } from '../../../src/shared/sim/vehicleClasses.js';
import { WATER_RESET_TICKS } from '../../../src/shared/sim/vehicle.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import { createSimWorld, type GroundModel, type SimWorld } from '../../../src/shared/world/colliders.js';
import { drive, spawnCar, speedOf } from './helpers.js';

// Surfaces, water and falling out of the map on a map's ground
// (docs/phase-3-design.md, 7, 8.1 and 8.3). The expectations come from
// table 8.1 and the drive law of phase 1a by hand, not from the sim's code.

interface GroundOptions {
    height?: (x: number, z: number) => number;
    surface?: (x: number, z: number) => number;
    waterLevel?: number;
    fallLimit?: number;
}

function groundWorld(options: GroundOptions = {}): SimWorld {
    const ground: GroundModel = {
        height: options.height ?? (() => 0),
        surface: options.surface ?? (() => SURFACE.asphalt),
        waterLevel: options.waterLevel ?? -Infinity,
        fallLimit: options.fallLimit ?? -Infinity,
        bound: 4000,
        grid: { origin: -4000, cellSize: 64, cells: 125 }
    };
    return createSimWorld(ground, []);
}

describe('surfaces', () => {
    it('takes the rolling resistance of sand off the drive: 8.5 - 1.6 · 0.8 m/s² for the Bulli', () => {
        // From rest at full throttle the drive covers the air and base drag
        // (phase 1a), so the first tick gains (accel - roll) · DT
        const firstTick = (surface: number) => {
            const world = groundWorld({ surface: () => surface });
            const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
            drive(car, world, 1, { throttle: 255 });
            return car.state.vz;
        };
        expect(firstTick(SURFACE.asphalt)).toBeCloseTo(8.5 * DT, 12);
        expect(firstTick(SURFACE.sand)).toBeCloseTo((8.5 - 1.6 * 0.8) * DT, 12);
        // Paved surfaces roll freely whatever their grip
        expect(firstTick(SURFACE.wood)).toBeCloseTo(8.5 * DT, 12);
        expect(firstTick(SURFACE.concrete)).toBeCloseTo(8.5 * DT, 12);
    });

    it('reads the surface under each axle: front on sand, rear on tarmac rolls with half the sand', () => {
        const c = VEHICLE_CLASSES.bulli.colliderOffset;
        // Sand for z > 0; the car's centre stands on tarmac at z = -0.3 c,
        // its front axle at +0.7 c on sand, its rear at -1.3 c on tarmac
        const world = groundWorld({ surface: (_x, z) => z > 0 ? SURFACE.sand : SURFACE.asphalt });
        const car = spawnCar(world, 'a', 'bulli', 0, -0.3 * c, 0);
        drive(car, world, 1, { throttle: 255 });
        expect(car.state.vz).toBeCloseTo((8.5 - 1.6 * 0.8 / 2) * DT, 12);
    });

    it('scales the tyre forces by the surface and, off paved roads, by the class', () => {
        // A slide at 20 m/s forward and 8 m/s sideways, no input: the
        // lateral change of the first tick is the tyre force alone, which
        // is proportional to the grip (no drive force, so the grip circle is 1)
        const lateralChange = (surface: number, classId: 'bulli' | 'jeep') => {
            const world = groundWorld({ surface: () => surface });
            const car = spawnCar(world, 'a', classId, 0, 0, 0);
            car.state.vz = 20;
            car.state.vx = 8;
            stepVehicle(car, world);
            // Yaw 0: left is +x, and the new velocity is set in the old frame
            return car.state.vx - 8;
        };
        const asphalt = lateralChange(SURFACE.asphalt, 'bulli');
        expect(asphalt).toBeLessThan(-0.1);
        // Grass 0.7 × the Bulli's offroad grip 0.9, concrete 0.97 without it
        expect(lateralChange(SURFACE.grass, 'bulli') / asphalt).toBeCloseTo(0.7 * 0.9, 9);
        expect(lateralChange(SURFACE.concrete, 'bulli') / asphalt).toBeCloseTo(0.97, 9);
        // The jeep keeps all its grip off-road (offroadGrip 1.0)
        expect(lateralChange(SURFACE.dirt, 'jeep') / lateralChange(SURFACE.asphalt, 'jeep')).toBeCloseTo(0.75, 9);
    });

    it('lowers the top speed on sand to where the drive equals the rolling resistance', () => {
        // accel · (1 - (v/vtop)^2.5) = roll: v = vtop · (1 - roll/accel)^0.4
        const topSpeed = (classId: 'bulli' | 'jeep') => {
            const world = groundWorld({ surface: () => SURFACE.sand });
            const car = spawnCar(world, 'a', classId, 0, -3000, 0);
            drive(car, world, 60 * 40, { throttle: 255 });
            return speedOf(car);
        };
        const bulli = VEHICLE_CLASSES.bulli, jeep = VEHICLE_CLASSES.jeep;
        expect(topSpeed('bulli')).toBeCloseTo(bulli.topSpeed * Math.pow(1 - 1.6 * 0.8 / bulli.accel, 1 / T.DRIVE_EXP), 1);
        expect(topSpeed('jeep')).toBeCloseTo(jeep.topSpeed * Math.pow(1 - 1.6 * 0.2 / jeep.accel, 1 / T.DRIVE_EXP), 1);
    });

    it('wades through shallow water like soft ground, with grip and drive', () => {
        const world = groundWorld({ height: () => -0.5, surface: () => SURFACE.water, waterLevel: 0 });
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        drive(car, world, 60, { throttle: 255 });
        // Drive 8.5 minus the wading drag 3.0 · 0.8 for a second, minus the air drag
        expect(car.state.vz).toBeGreaterThan(5);
        expect(car.state.vz).toBeLessThan(8.5 - 3.0 * 0.8 + 0.01);
        expect(car.state.waterTicks).toBe(0);
    });
});

describe('water', () => {
    // Sea floor 1 m deep for x < 50, dry land (1 m up) beyond; the reset
    // puts the car on the land at x = 100
    function sea(): SimWorld {
        const world = groundWorld({ height: x => x < 50 ? -1 : 1, waterLevel: 0 });
        world.resetPose = s => {
            s.x = 100;
            s.z = 0;
            s.yaw = Math.PI / 2;
            return true;
        };
        return world;
    }

    it('gives a car 0.6 m under water no drive', () => {
        const world = sea();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        drive(car, world, 30, { throttle: 255 });
        expect(car.state.vz).toBe(0);
        expect(car.state.waterTicks).toBe(30);
    });

    it('brakes a car that drives in with at least exp(-2.5 t)', () => {
        const world = sea();
        const car = spawnCar(world, 'a', 'sport', 0, 0, 0, 20);
        drive(car, world, 30, { throttle: 255 });
        expect(speedOf(car)).toBeLessThanOrEqual(20 * Math.exp(-2.5 * 30 * DT));
        expect(speedOf(car)).toBeGreaterThan(0);
    });

    it('resets the car onto the land after exactly one second in the water', () => {
        const world = sea();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        let resetTick = -1, ticksAtReset = -1;
        drive(car, world, 90, {}, tick => {
            if (car.events.reset && resetTick < 0) {
                resetTick = tick + 1;
                ticksAtReset = car.state.waterTicks;
            }
        });
        expect(resetTick).toBe(WATER_RESET_TICKS);
        // The snapshot of the reset tick already shows the car dry
        expect(ticksAtReset).toBe(0);
        expect(car.state.x).toBe(100);
        expect(car.state.y).toBe(1);
    });

    it('counts nothing while the car flies over the water, only once it is in', () => {
        const world = sea();
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.state.y = 5;
        car.state.grounded = false;
        let dryTicks = 0, wetTicks = 0;
        // Falls 5.6 m to the depth of 0.6 m in √(2 · 5.6 / 20) s = 45 ticks
        drive(car, world, 70, {}, () => {
            if (car.state.y > -0.6) {
                expect(car.state.waterTicks).toBe(0);
                dryTicks++;
            } else {
                wetTicks++;
            }
        });
        expect(dryTicks).toBeGreaterThan(10);
        expect(wetTicks).toBeGreaterThan(5);
    });

    it('allows no boost in the water', () => {
        const run = (height: number) => {
            const world = groundWorld({ height: () => height, waterLevel: 0 });
            const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 10);
            car.state.boostMeter = 1;
            let boosted = false;
            drive(car, world, 10, { throttle: 255, buttons: BTN_BOOST }, () => {
                boosted ||= car.state.boosting;
            });
            return boosted;
        };
        // Dry ground as the control: it works there
        expect(run(1)).toBe(true);
        expect(run(-1)).toBe(false);
    });
});

describe('falling out of the map', () => {
    it('resets a car below the fall limit at once, and never on the sine terrain', () => {
        const world = groundWorld({ height: x => x < 50 ? -30 : 1, fallLimit: -20 });
        world.resetPose = s => {
            s.x = 100;
            return true;
        };
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        stepVehicle(car, world);
        expect(car.events.reset).toBe(true);
        expect(car.state.x).toBe(100);
        expect(car.state.y).toBe(1);

        const deep = groundWorld({ height: () => -30 });
        const other = spawnCar(deep, 'b', 'bulli', 0, 0, 0);
        drive(other, deep, 30, {}, () => expect(other.events.reset).toBe(false));
    });
});
