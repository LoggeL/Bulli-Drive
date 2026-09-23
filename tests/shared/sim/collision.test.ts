import { describe, expect, it } from 'vitest';
import { MEGA_SCALE } from '../../../src/shared/constants.js';
import { BTN_JUMP, DT, GHOST_EXIT_TICKS, V_SAFE } from '../../../src/shared/sim/constants.js';
import { createFlatWorld } from '../../../src/shared/sim/scenarios.js';
import type { CarClassId, SimCar } from '../../../src/shared/sim/types.js';
import { CAR_CLASS_IDS } from '../../../src/shared/sim/vehicleClasses.js';
import { stepVehicle } from '../../../src/shared/sim/world.js';
import type { ColliderInput, SimWorld } from '../../../src/shared/world/colliders.js';
import { DEG, drive, spawnCar, speedOf } from './helpers.js';

// Car against the static world (docs/phase-1a-design.md, 7.3 and 14.5)

function circleCentres(car: SimCar): [number, number][] {
    const { x, z, yaw } = car.state;
    const c = car.params.colliderOffset;
    return [[x + c * Math.sin(yaw), z + c * Math.cos(yaw)], [x - c * Math.sin(yaw), z - c * Math.cos(yaw)]];
}

describe('v2 wall response', () => {
    it('stops a frontal hit at 50 m/s with a small rebound and little rotation', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 20, hw: 50, hd: 0.25, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 50);
        let impact = 0, reboundTick = -1;
        drive(car, world, 30, {}, tick => {
            if (car.events.wallImpact > 0 && reboundTick < 0) {
                impact = car.events.wallImpact;
                reboundTick = tick;
                expect(car.state.vz).toBeLessThan(-2.5);
                expect(car.state.vz).toBeGreaterThanOrEqual(-3);
                expect(Math.abs(car.state.yawRate)).toBeLessThan(0.05);
                expect(car.events.wallZ).toBeCloseTo(19.75, 1);
            }
        });
        // It coasted without throttle for 0.35 s before the hit
        expect(impact).toBeGreaterThan(47);
        expect(car.state.wallTicks).toBeLessThan(30);
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(19.75 + 1e-6);
    });

    it('shield hits do not rebound', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 20, hw: 50, hd: 0.25, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 50);
        car.mods.shield = true;
        let hits = 0;
        drive(car, world, 30, {}, () => {
            if (car.events.wallImpact > 0) {
                hits++;
                expect(car.state.vz).toBeCloseTo(0, 9);
            }
        });
        // The shield still collides: it hit the wall and stayed in front of it
        expect(hits).toBeGreaterThan(0);
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(19.75 + 1e-6);
    });

    it('slides along a wall hit at 10° with 50 m/s and turns parallel to it', () => {
        const world = createFlatWorld([{ kind: 'box', x: 5, z: 0, hw: 0.25, hd: 150, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -100, 10 * DEG, 50);
        let hitTick = -1, speedAfter = 0;
        drive(car, world, 90, { throttle: 255 }, tick => {
            if (hitTick < 0 && car.events.wallImpact > 0) {
                hitTick = tick;
                // vn ≈ 50·sin 10° = 8.7 m/s turns into a 1.3 m/s rebound
                expect(car.events.wallImpact).toBeGreaterThan(7);
                expect(car.events.wallImpact).toBeLessThan(10);
            }
            if (hitTick >= 0 && tick === hitTick + 1) speedAfter = speedOf(car);
            // Never inside the wall
            for (const [cx] of circleCentres(car)) expect(cx + car.params.colliderRadius).toBeLessThan(4.75 + 0.01);
        });
        expect(hitTick).toBeGreaterThanOrEqual(0);
        expect(speedAfter).toBeGreaterThan(46.5);
        // The lever on the front circle turned the nose parallel to the wall
        // (overshooting slightly away from it) and the car keeps its speed
        expect(car.state.yaw).toBeLessThan(0);
        expect(car.state.yaw).toBeGreaterThan(-10 * DEG);
        expect(car.state.x).toBeLessThan(3);
        expect(speedOf(car)).toBeGreaterThan(47);
    });

    it('keeps the car inside the world border', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'sport', 480, 0, Math.PI / 2, 60);
        drive(car, world, 120, { throttle: 255, steer: 30 }, () => {
            for (const [cx, cz] of circleCentres(car)) {
                expect(Math.abs(cx) + car.params.colliderRadius).toBeLessThanOrEqual(498 + 1e-6);
                expect(Math.abs(cz) + car.params.colliderRadius).toBeLessThanOrEqual(498 + 1e-6);
            }
        });
    });

    it('flies over low colliders but hits them on the ground', () => {
        // Bench (top 1.2) and lamp (top 5.5) right ahead
        const colliders: ColliderInput[] = [
            { kind: 'circle', x: 0, z: 15, r: 1.7, top: 1.2 },
            { kind: 'circle', x: 0, z: 30, r: 0.7, top: 5.5 }
        ];
        const world = createFlatWorld(colliders);
        const grounded = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        drive(grounded, world, 60, { throttle: 255 });
        expect(grounded.state.z).toBeLessThan(15);

        // Jumping from 10 m before the bench clears it (apex 3 m), the lamp not
        const jumper = spawnCar(world, 'a', 'bulli', 0, 0, 0, 20);
        let maxZ = 0;
        drive(jumper, world, 120, tick => ({ throttle: 255, buttons: tick === 12 ? BTN_JUMP : 0 }), () => {
            maxZ = Math.max(maxZ, jumper.state.z);
        });
        expect(maxZ).toBeGreaterThan(17);
        expect(maxZ).toBeLessThan(30);
    });

    it('lands on top of a low collider instead of being pushed off sideways', () => {
        const world = createFlatWorld([{ kind: 'circle', x: 0, z: 0, r: 1.7, top: 1.2 }]);
        const car = spawnCar(world, 'a', 'bulli', 0.3, 0, 0);
        car.state.y = 3;
        car.state.grounded = false;
        drive(car, world, 60, {});
        expect(car.state.grounded).toBe(true);
        expect(car.state.y).toBe(1.2);
        expect(car.state.x).toBe(0.3);
        expect(car.state.z).toBe(0);
    });

    it('drives off the top of a low collider and drops down without a sideways jump', () => {
        const world = createFlatWorld([{ kind: 'circle', x: 0, z: 0, r: 5, top: 1.5 }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.state.y = 1.5;
        let lastZ = car.state.z, maxStep = 0;
        drive(car, world, 150, { throttle: 255 }, () => {
            maxStep = Math.max(maxStep, Math.abs(car.state.x), car.state.z - lastZ - speedOf(car) * DT);
            lastZ = car.state.z;
        });
        expect(car.state.y).toBe(0);
        expect(car.state.z).toBeGreaterThan(5 + 2);
        expect(maxStep).toBeLessThan(0.05);
    });

    it('jumping onto a fountain or a pond never moves the car further than its speed allows', () => {
        // Fountain (r 5, top 1.5), pond (r 5.7, top 0.8), bench and planter
        const low: Extract<ColliderInput, { kind: 'circle' }>[] = [
            { kind: 'circle', x: 0, z: 0, r: 5, top: 1.5 },
            { kind: 'circle', x: 0, z: 0, r: 5.7, top: 0.8 },
            { kind: 'circle', x: 0, z: 0, r: 1.7, top: 1.2 },
            { kind: 'circle', x: 0, z: 0, r: 1.0, top: 1.0 }
        ];
        for (const collider of low) {
            const world = createFlatWorld([collider]);
            for (const speed of [8, 12, 16, 20]) {
                for (let jumpAt = 0; jumpAt <= 8; jumpAt += 0.5) {
                    const car = spawnCar(world, 'a', 'bulli', 0, -(collider.r + 20), 0, speed);
                    let jumped = false;
                    for (let tick = 0; tick < 240; tick++) {
                        const jump: boolean = !jumped && car.state.z >= -(collider.r + jumpAt);
                        jumped ||= jump;
                        car.input.throttle = 160;
                        car.input.buttons = jump ? BTN_JUMP : 0;
                        const { x, z } = car.state;
                        stepVehicle(car, world);
                        const moved = Math.hypot(car.state.x - x, car.state.z - z);
                        expect(moved, `r ${collider.r} at ${speed} m/s, jump ${jumpAt} m before`)
                            .toBeLessThanOrEqual(speedOf(car) * DT + 0.5);
                    }
                }
            }
        }
    });

    it('a Party ghost does not stand on low colliders', () => {
        const world = createFlatWorld([{ kind: 'circle', x: 0, z: 0, r: 5, top: 1.5 }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0);
        car.mods.ghost = true;
        car.state.y = 3;
        car.state.grounded = false;
        drive(car, world, 60, {});
        expect(car.state.y).toBe(0);
    });
});

describe('v2 Party ghost against the world', () => {
    it('drives through a building, then keeps collisions off until it is out', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 10, hd: 12, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, -60, 0, 30);
        let ghostExitSeen = 0;
        drive(car, world, 180, tick => {
            car.mods.ghost = tick < 100;
            return { throttle: 255 };
        }, () => {
            ghostExitSeen = Math.max(ghostExitSeen, car.state.ghostExit);
        });
        // Set to GHOST_EXIT_TICKS and counted down once in the same tick
        expect(ghostExitSeen).toBe(GHOST_EXIT_TICKS - 1);
        expect(car.state.ghostExit).toBe(0);
        // Came out on the far side, no plop back
        expect(car.state.z).toBeGreaterThan(12 + 2);
        expect(car.events.wallImpact).toBe(0);
    });

    it('still respects the world border while ghosting', () => {
        const world = createFlatWorld();
        const car = spawnCar(world, 'a', 'bulli', 0, 480, 0, 50);
        car.mods.ghost = true;
        drive(car, world, 60, { throttle: 255 });
        expect(car.state.z + 0.7 + 1.3).toBeLessThanOrEqual(498 + 1e-6);
    });

    it('collides normally after a ghost that ended in the open', () => {
        const world = createFlatWorld([{ kind: 'box', x: 0, z: 40, hw: 10, hd: 2, top: Infinity }]);
        const car = spawnCar(world, 'a', 'bulli', 0, 0, 0, 30);
        drive(car, world, 120, tick => {
            car.mods.ghost = tick < 10;
            return { throttle: 255 };
        });
        expect(car.state.ghostExit).toBe(0);
        expect(car.state.z).toBeLessThan(38);
    });
});

// ---- Tunneling (14.5) ----

interface Approach {
    classId: CarClassId;
    mega: boolean;
    speed: number;
    world: SimWorld;
    x: number;
    z: number;
    yaw: number;
    ticks: number;
    // The run checks nothing unless the car reaches the collider
    mustTouch: boolean;
    check: (car: SimCar) => void;
}

// Drives at a fixed speed along the heading until the first wall contact,
// then lets the sim take over; check runs after every tick
function approach({ classId, mega, speed, world, x, z, yaw, ticks, mustTouch, check }: Approach): SimCar {
    const car = spawnCar(world, 'a', classId, x, z, yaw);
    if (mega) {
        car.mods.mega = true;
        car.state.scale = MEGA_SCALE;
    }
    let touched = false, pushed = false;
    for (let tick = 0; tick < ticks; tick++) {
        if (!touched) {
            car.state.vx = Math.sin(yaw) * speed;
            car.state.vz = Math.cos(yaw) * speed;
            car.state.yawRate = 0;
        }
        car.input.throttle = 255;
        stepVehicle(car, world);
        touched ||= car.events.wallImpact > 0;
        // A graze can push the car out without an impulse (wallTicks = 0,
        // counted up once at the end of the tick)
        pushed ||= touched || car.state.wallTicks === 1;
        check(car);
    }
    if (mustTouch) expect(pushed, `${classId} ${speed} m/s never reached the collider`).toBe(true);
    return car;
}

const ANGLES = [0, 10, 20, 30, 40, 50, 60, 70, 80].map(a => a * DEG);
const SPEEDS = [85, V_SAFE];

// Start distances spread over one tick of travel: how deep a circle is in
// at the first contact substep depends on this phase alone, and it decides
// whether a car tunnels (section 7.3). With SUBSTEPS = 1 these checks fail.
function phases(speed: number): number[] {
    const list: number[] = [];
    for (let phase = 0; phase < speed * DT; phase += 0.05) list.push(phase);
    return list;
}

function offsets(reach: number): number[] {
    const list: number[] = [];
    for (let k = -Math.round(reach * 10); k <= Math.round(reach * 10); k++) list.push(k / 10);
    return list;
}

describe('v2 tunneling against the world', () => {
    for (const classId of CAR_CLASS_IDS) {
        for (const mega of [false, true]) {
            const label = `${classId}${mega ? ' (Mega)' : ''}`;

            it(`${label} never passes through a 0.35 m post`, () => {
                // The post is round, so one heading (+z) covers every angle
                const world = createFlatWorld([{ kind: 'circle', x: 0, z: 0, r: 0.35, top: 3.3 }]);
                for (const speed of SPEEDS) {
                    const probe = spawnCar(world, 'p', classId, 0, 0, 0);
                    const scale = mega ? MEGA_SCALE : 1;
                    const r = probe.base.colliderRadius * scale, c = probe.base.colliderOffset * scale;
                    for (const phase of phases(speed)) {
                        // Offsets up to just inside the reach, so every run hits
                        for (const offset of offsets(r + 0.25)) {
                            // Along/lateral coordinates of every circle relative to the post
                            let prev: [number, number][] | null = null;
                            approach({
                                classId, mega, speed, world, ticks: 30, yaw: 0, mustTouch: true,
                                x: offset, z: -(c + r + 8) - phase,
                                check: car => {
                                    const now = circleCentres(car).map(([px, pz]) => [pz, px] as [number, number]);
                                    if (prev) {
                                        for (let i = 0; i < 2; i++) {
                                            const [a0, l0] = prev[i], [a1, l1] = now[i];
                                            if (a0 < 0 && a1 >= 0) {
                                                // Crossed the post's line: must be beside it, not through it
                                                const lateral = l0 + (l1 - l0) * (-a0 / (a1 - a0));
                                                expect(Math.abs(lateral), `${label} ${speed} m/s phase ${phase} offset ${offset}`)
                                                    .toBeGreaterThan(r + 0.35 - 0.3);
                                            }
                                        }
                                    }
                                    prev = now;
                                }
                            });
                        }
                    }
                }
            });

            it(`${label} never passes through a wall of 0.25 m half thickness`, () => {
                const world = createFlatWorld([{ kind: 'box', x: 0, z: 0, hw: 200, hd: 0.25, top: Infinity }]);
                for (const speed of SPEEDS) {
                    for (const angle of ANGLES) {
                        // The wall is long, so where along it the car hits
                        // does not matter; the start phase does
                        for (const phase of phases(speed)) {
                            const scale = mega ? MEGA_SCALE : 1;
                            const probe = spawnCar(world, 'p', classId, 0, 0, 0);
                            const reach = (probe.base.colliderOffset + probe.base.colliderRadius) * scale;
                            approach({
                                classId, mega, speed, world, ticks: 30, yaw: angle, mustTouch: true,
                                x: -Math.tan(angle) * 3, z: -(reach + 3) - phase * Math.cos(angle),
                                check: car => {
                                    expect(car.state.z, `${label} ${speed} m/s ${angle / DEG}°`).toBeLessThan(-0.25);
                                    for (const [, cz] of circleCentres(car)) expect(cz).toBeLessThan(-0.25);
                                }
                            });
                        }
                    }
                }
            });

            it(`${label} never passes through a building corner`, () => {
                const world = createFlatWorld([{ kind: 'box', x: 10, z: 10, hw: 10, hd: 10, top: Infinity }]);
                for (const speed of SPEEDS) {
                    for (const angle of ANGLES) {
                        // Aim at the corner (0, 0) with the heading rotated by angle from +z
                        const dx = Math.sin(angle), dz = Math.cos(angle);
                        const scale = mega ? MEGA_SCALE : 1;
                        const probe = spawnCar(world, 'p', classId, 0, 0, 0);
                        const reach = (probe.base.colliderOffset + probe.base.colliderRadius) * scale;
                        for (const offset of offsets(reach + 0.4)) {
                            approach({
                                classId, mega, speed, world, ticks: 30, yaw: angle, mustTouch: false,
                                x: -dx * (reach + 6) + dz * offset,
                                z: -dz * (reach + 6) - dx * offset,
                                check: car => {
                                    const inside = car.state.x > 0 && car.state.x < 20 && car.state.z > 0 && car.state.z < 20;
                                    expect(inside, `${label} ${speed} m/s ${angle / DEG}° offset ${offset}`).toBe(false);
                                }
                            });
                        }
                    }
                }
            });
        }
    }
});
