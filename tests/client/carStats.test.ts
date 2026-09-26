import { describe, expect, it } from 'vitest';
import { BAR_FLOOR, carAnnouncement, carStats } from '../../src/client/ui/menu/carStats.js';

// The numbers of a car in the menu (docs/ui.md 4.3). Expected values by
// hand from the class table in shared/sim/vehicleClasses.ts: top speed
// m/s * 3.6, bars 0.35 + 0.65 * (v - min) / (max - min) over the five
// classes (top speed 47..55 m/s, acceleration 8.0..11.0 m/s²).

describe('carStats', () => {
    it('gives the 356 the highest top speed and a full bar', () => {
        const sport = carStats('sport');
        expect(sport.name).toBe('356');
        // 55 m/s * 3.6
        expect(sport.topSpeedKmh).toBe(198);
        expect(sport.topSpeedBar).toBeCloseTo(1, 12);
    });

    it('gives the Pickup the lowest top speed on the bar floor and the least acceleration', () => {
        const pickup = carStats('pickup');
        // 47 * 3.6 = 169.2
        expect(pickup.topSpeedKmh).toBe(169);
        expect(pickup.topSpeedBar).toBeCloseTo(BAR_FLOOR, 12);
        expect(BAR_FLOOR).toBe(0.35);
        expect(pickup.accelBar).toBeCloseTo(0.35, 12);
        expect(pickup.mass).toBe(2000);
    });

    it('shows the Beetle light and quickest off the line, the Bulli in between', () => {
        const beetle = carStats('beetle');
        expect(beetle.mass).toBe(900);
        // 48 * 3.6 = 172.8
        expect(beetle.topSpeedKmh).toBe(173);
        expect(beetle.accelBar).toBeCloseTo(1, 12);
        const bulli = carStats('bulli');
        expect(bulli.topSpeedKmh).toBe(180);
        // (50 - 47) / 8 = 0.375: 0.35 + 0.65 * 0.375 = 0.59375
        expect(bulli.topSpeedBar).toBeCloseTo(0.59375, 12);
        // (8.5 - 8) / 3 = 1/6: 0.35 + 0.65 / 6
        expect(bulli.accelBar).toBeCloseTo(0.35 + 0.65 / 6, 12);
        expect(carStats('jeep').name).toBe('Type 181');
        expect(carStats('jeep').topSpeedKmh).toBe(176);
    });

    it('reads a car out with name, top speed and mass', () => {
        expect(carAnnouncement('beetle')).toBe('Beetle – 173 km/h, 900 kg');
    });
});
