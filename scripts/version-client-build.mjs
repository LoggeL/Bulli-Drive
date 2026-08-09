import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const clientOutputPath = path.join(projectRoot, 'public', 'js');
const stylesheetPath = path.join(projectRoot, 'public', 'style.css');
const versionFilePath = path.join(projectRoot, 'public', 'build-version.txt');

async function collectFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries.map(entry => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    }));
    return files.flat();
}

function findModuleSpecifiers(sourceFile) {
    const specifiers = [];

    function visit(node) {
        let moduleSpecifier;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            moduleSpecifier = node.moduleSpecifier;
        } else if (
            ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments.length >= 1
        ) {
            moduleSpecifier = node.arguments[0];
        }

        if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
            specifiers.push(moduleSpecifier);
        }
        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    return specifiers;
}

function replaceModuleSpecifiers(filePath, source, replaceSpecifier) {
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const replacements = [];

    for (const specifier of findModuleSpecifiers(sourceFile)) {
        const value = replaceSpecifier(specifier.text);
        if (value === specifier.text) continue;
        replacements.push({
            start: specifier.getStart(sourceFile) + 1,
            end: specifier.getEnd() - 1,
            value
        });
    }

    let rewrittenSource = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        rewrittenSource = rewrittenSource.slice(0, replacement.start)
            + replacement.value
            + rewrittenSource.slice(replacement.end);
    }
    return { source: rewrittenSource, replacementCount: replacements.length };
}

const javascriptFiles = (await collectFiles(clientOutputPath))
    .filter(filePath => filePath.endsWith('.js'))
    .sort();

if (javascriptFiles.length === 0) {
    throw new Error('Client build produced no JavaScript files to version.');
}

const emittedSources = new Map();
const graphHash = createHash('sha256');
for (const filePath of javascriptFiles) {
    const emittedSource = await readFile(filePath, 'utf8');
    // Normalize our own previous suffix first so the postbuild is safe to run
    // directly more than once and still produces the same graph hash.
    const { source } = replaceModuleSpecifiers(filePath, emittedSource, specifier =>
        /^\.{1,2}\/.*\.js\?v=[a-f0-9]{16}$/.test(specifier)
            ? specifier.replace(/\?v=[a-f0-9]{16}$/, '')
            : specifier
    );
    const relativePath = path.relative(clientOutputPath, filePath);
    emittedSources.set(filePath, source);
    graphHash.update(relativePath);
    graphHash.update('\0');
    graphHash.update(source);
    graphHash.update('\0');
}
graphHash.update('style.css');
graphHash.update('\0');
graphHash.update(await readFile(stylesheetPath));

const buildVersion = graphHash.digest('hex').slice(0, 16);
const expectedSuffix = `?v=${buildVersion}`;
let rewrittenEdgeCount = 0;

for (const [filePath, source] of emittedSources) {
    const versioned = replaceModuleSpecifiers(filePath, source, specifier =>
        /^\.{1,2}\/.*\.js$/.test(specifier) ? `${specifier}${expectedSuffix}` : specifier
    );
    const versionedSource = versioned.source;
    rewrittenEdgeCount += versioned.replacementCount;
    await writeFile(filePath, versionedSource);
}

if (rewrittenEdgeCount === 0) {
    throw new Error('Client build contained no relative JavaScript module edges.');
}

// A missed edge can load a second copy of singleton modules such as state.js.
// Reparse every output and fail the build unless the complete graph agrees.
const invalidEdges = [];
for (const filePath of javascriptFiles) {
    const source = await readFile(filePath, 'utf8');
    const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const specifier of findModuleSpecifiers(sourceFile)) {
        if (!/^\.{1,2}\/.*\.js(?:\?.*)?$/.test(specifier.text)) continue;
        if (!specifier.text.endsWith(expectedSuffix)) {
            invalidEdges.push(`${path.relative(clientOutputPath, filePath)} -> ${specifier.text}`);
        }
    }
}

if (invalidEdges.length > 0) {
    throw new Error(`Unversioned or mismatched client module edges:\n${invalidEdges.join('\n')}`);
}

await writeFile(versionFilePath, `${buildVersion}\n`);
console.log(`Client build version: ${buildVersion} (${rewrittenEdgeCount} module edges)`);
