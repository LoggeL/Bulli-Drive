import { afterEach, describe, expect, it } from 'vitest';
import { SIM_TUNING, SIM_TUNING_DEFAULTS } from '../../../src/shared/sim/constants.js';
import {
    classDefaults, exportTuning, importTuning, profileDefaults, refreshCarParams, resetTuning, tuningIsDefault
} from '../../../src/shared/sim/tuning.js';
import { tuningIsDefault as scenarioTuningIsDefault } from '../../../src/shared/sim/scenarios.js';
import { applyModifiers } from '../../../src/shared/sim/modifiers.js';
import { createVehicleModifiers } from '../../../src/shared/sim/types.js';
import { createSimCar } from '../../../src/shared/sim/vehicle.js';
import { ASSIST_PROFILES, CAR_CLASS_IDS, VEHICLE_CLASSES, createVehicleParams } from '../../../src/shared/sim/vehicleClasses.js';

// Live tuning of the sandbox panel (docs/phase-1a-design.md, 13): export
// of the changed values, import, reset, and cars that already exist

describe('v2 tuning', () => {
    afterEach(() => resetTuning());

    it('starts at the shipped defaults with an empty export', () => {
        expect(tuningIsDefault()).toBe(true);
        expect(exportTuning()).toStrictEqual({ format: 1, global: {}, classes: {}, profiles: {} });
        for (const id of CAR_CLASS_IDS) expect(VEHICLE_CLASSES[id]).toStrictEqual(classDefaults(id));
        expect(ASSIST_PROFILES.touch).toStrictEqual(profileDefaults('touch'));
    });

    it('exports only the changed values and imports them back after a reset', () => {
        SIM_TUNING.gripScale = 1.25;
        VEHICLE_CLASSES.sport.gripRear = 2.4;
        VEHICLE_CLASSES.jeep.drive = 'rear';
        ASSIST_PROFILES.touch.counterSteer = 0.8;
        expect(tuningIsDefault()).toBe(false);
        // The golden tests check the same thing through scenarios.ts
        expect(scenarioTuningIsDefault()).toBe(false);

        const exported = exportTuning();
        expect(exported).toStrictEqual({
            format: 1,
            global: { gripScale: 1.25 },
            classes: { sport: { gripRear: 2.4 }, jeep: { drive: 'rear' } },
            profiles: { touch: { counterSteer: 0.8 } }
        });
        const json = JSON.stringify(exported);

        resetTuning();
        expect(tuningIsDefault()).toBe(true);
        expect(SIM_TUNING).toStrictEqual({ ...SIM_TUNING_DEFAULTS });

        importTuning(json);
        expect(exportTuning()).toStrictEqual(exported);
        expect(SIM_TUNING.gripScale).toBe(1.25);
        expect(VEHICLE_CLASSES.sport.gripRear).toBe(2.4);
    });

    it('replaces the whole tuning on import, not just the listed values', () => {
        SIM_TUNING.K_BD = 9;
        VEHICLE_CLASSES.bulli.mass = 1700;
        importTuning({ format: 1, global: { STICK: 12 } });
        expect(exportTuning()).toStrictEqual({ format: 1, global: { STICK: 12 }, classes: {}, profiles: {} });
    });

    it('rejects broken input and leaves the tuning untouched', () => {
        SIM_TUNING.gripScale = 1.1;
        const before = JSON.stringify(exportTuning());
        const broken: unknown[] = [
            'not json',
            '[]',
            { global: {} },
            { format: 2 },
            { format: 1, extra: {} },
            { format: 1, global: { NOPE: 1 } },
            { format: 1, global: { gripScale: 'fast' } },
            { format: 1, global: { gripScale: null } },
            { format: 1, classes: { tank: { mass: 1 } } },
            { format: 1, classes: { bulli: { mass: Number.NaN } } },
            { format: 1, classes: { bulli: { drive: 'front' } } },
            { format: 1, classes: { bulli: { wings: 2 } } },
            { format: 1, profiles: { pro: { counterSteer: 1 } } },
            { format: 1, profiles: { touch: 3 } }
        ];
        for (const input of broken) {
            expect(() => importTuning(input), JSON.stringify(input)).toThrow(/tuning/);
            expect(JSON.stringify(exportTuning())).toBe(before);
        }
        // All problems at once in the message
        expect(() => importTuning({ format: 1, global: { A: 1, B: 2 } })).toThrow(/global\.A.*global\.B/);
    });

    it('names each problem of a rejected import', () => {
        const message = (input: unknown) => {
            try {
                importTuning(input);
            } catch (err) {
                return (err as Error).message;
            }
            return 'accepted';
        };
        expect(message('{')).toBe('tuning is not valid JSON');
        expect(message([])).toBe('tuning is not an object');
        expect(message(null)).toBe('tuning is not an object');
        expect(message({ format: 2 })).toBe('invalid tuning: format must be 1');
        expect(message({ format: 1, extra: 1 })).toBe('invalid tuning: extra is unknown');
        expect(message({ format: 1, global: [] })).toBe('invalid tuning: global is not an object');
        expect(message({ format: 1, global: { NOPE: 1 } })).toBe('invalid tuning: global.NOPE is unknown');
        expect(message({ format: 1, global: { STICK: Infinity } })).toBe('invalid tuning: global.STICK must be a finite number');
        expect(message({ format: 1, classes: [] })).toBe('invalid tuning: classes is not an object');
        expect(message({ format: 1, classes: { tank: {} } })).toBe('invalid tuning: classes.tank is unknown');
        expect(message({ format: 1, classes: { bulli: null } })).toBe('invalid tuning: classes.bulli is not an object');
        expect(message({ format: 1, classes: { jeep: { drive: 4 } } })).toBe("invalid tuning: classes.jeep.drive must be 'rear' or 'all'");
        expect(message({ format: 1, profiles: 'touch' })).toBe('invalid tuning: profiles is not an object');
        expect(message({ format: 1, profiles: { touch: { counterSteer: '1' } } }))
            .toBe('invalid tuning: profiles.touch.counterSteer must be a finite number');
        expect(message({ format: 1, global: { A: 1 }, classes: { tank: {} } }))
            .toBe('invalid tuning: global.A is unknown; classes.tank is unknown');
        expect(message({ format: 1, classes: { jeep: { drive: 'all' } }, profiles: {} })).toBe('accepted');
    });

    it('is not the default once a class or a profile alone changed', () => {
        VEHICLE_CLASSES.beetle.mass = 950;
        expect(tuningIsDefault()).toBe(false);
        resetTuning();
        ASSIST_PROFILES.standard.counterSteer = 0.1;
        expect(tuningIsDefault()).toBe(false);
        resetTuning();
        expect(tuningIsDefault()).toBe(true);
    });

    it('reaches new and existing cars of the tuned class', () => {
        const bulli = createSimCar('b', 'bulli', 'touch');
        const sport = createSimCar('s', 'sport');
        VEHICLE_CLASSES.bulli.topSpeed = 58;
        ASSIST_PROFILES.touch.spinGuardAngle = 0.5;
        expect(createVehicleParams('bulli', 'touch').topSpeed).toBe(58);

        refreshCarParams(bulli, 'bulli', 'touch');
        refreshCarParams(sport, 'sport', 'standard');
        expect(bulli.base.topSpeed).toBe(58);
        expect(bulli.base.spinGuardAngle).toBe(0.5);
        expect(sport.base).toStrictEqual(createVehicleParams('sport', 'standard'));

        resetTuning();
        refreshCarParams(bulli, 'bulli', 'touch');
        expect(bulli.base).toStrictEqual(createVehicleParams('bulli', 'touch'));
        expect(bulli.base.topSpeed).toBe(50);
    });

    it('lets the mass reach the car-car contacts, also through an import', () => {
        const pickup = createSimCar('p', 'pickup');
        VEHICLE_CLASSES.pickup.mass = 3000;
        refreshCarParams(pickup, 'pickup', 'standard');
        expect(pickup.base.contactMass).toBe(3000);
        pickup.mods.mega = true;
        expect(applyModifiers(pickup.base, pickup.mods, 1, pickup.params).contactMass).toBe(9000);

        importTuning({ format: 1, classes: { pickup: { mass: 2500 } } });
        expect(createVehicleParams('pickup').contactMass).toBe(2500);
        expect(applyModifiers(createVehicleParams('pickup'), createVehicleModifiers(), 1, createVehicleParams('pickup')).contactMass).toBe(2500);
    });
});
