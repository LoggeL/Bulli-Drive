import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildRoadNetwork, nearestRoad } from '../../../src/shared/map/roadNetwork.js';
import { parseRoadNetwork, type RoadNetworkFile } from '../../../src/shared/map/roadSchema.js';
import { commitEdit, splitEdge } from '../../../tools/worldviewer/logic/editOps.js';
import { formatMapJson } from '../../../tools/worldviewer/logic/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const readSource = (name: string) => readFileSync(path.join(ROOT, 'src/shared/maps/bulli-bay', name), 'utf8');

describe('formatMapJson', () => {
    it('writes one line per entry of the top-level arrays and records', () => {
        const text = formatMapJson({ format: 'x', list: [{ a: 1 }, { b: [1, 2] }], record: { k: { w: 1.5 } }, empty: [], none: {}, nothing: null });
        expect(text).toBe(
            '{\n' +
            '  "format": "x",\n' +
            '  "list": [\n' +
            '    {"a":1},\n' +
            '    {"b":[1,2]}\n' +
            '  ],\n' +
            '  "record": {\n' +
            '    "k": {"w":1.5}\n' +
            '  },\n' +
            '  "empty": [],\n' +
            '  "none": {},\n' +
            '  "nothing": null\n' +
            '}\n');
    });

    // Regression lock against the committed files: exporting an unchanged
    // map must not change a byte (no diff noise from the editor)
    it('reproduces the committed roads.json and zones.json byte for byte', () => {
        for (const name of ['roads.json', 'zones.json']) {
            const text = readSource(name);
            expect(formatMapJson(JSON.parse(text) as object)).toBe(text);
        }
    });

    it('changes only the lines of the edited objects', () => {
        const text = readSource('roads.json');
        const file = JSON.parse(text) as RoadNetworkFile;
        // A Catmull-Rom edge (the Ridge Road's Bézier arcs cannot be split, A22)
        const street = buildRoadNetwork(file).edgeById.get('hillcrest-3')!;
        const middle = street.samples[Math.floor(street.samples.length / 2)];
        const hit = nearestRoad(buildRoadNetwork(file), middle.x, middle.z, 1)!;
        const result = commitEdit(file, f => splitEdge(f, 'hillcrest-3', hit));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const out = formatMapJson(result.result.file);
        expect(parseRoadNetwork(JSON.parse(out)).ok).toBe(true);
        const before = new Set(text.split('\n'));
        const newLines = out.split('\n').filter(line => !before.has(line));
        // The new joint, the shortened hillcrest-3 and its second half
        expect(newLines).toHaveLength(3);
        expect(newLines.filter(line => line.includes('"id":"node-1"'))).toHaveLength(1);
        expect(newLines.filter(line => line.includes('"id":"hillcrest-3-b"'))).toHaveLength(1);
        expect(out.split('\n').length).toBe(text.split('\n').length + 2);
    });
});
