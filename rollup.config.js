const typescript = require("@rollup/plugin-typescript");
const path = require("path");
const fs = require("fs");

// Resolve .ts and .js->.ts imports so rollup can bundle all local source files
const resolveTs = {
    name: 'resolve-ts',
    resolveId(source, importer) {
        if (!importer) return null;
        const dir = path.dirname(importer);
        const tsPath = path.resolve(dir, source + '.ts');
        if (fs.existsSync(tsPath)) return tsPath;
        if (source.endsWith('.js')) {
            const tsPath2 = path.resolve(dir, source.replace(/\.js$/, '.ts'));
            if (fs.existsSync(tsPath2)) return tsPath2;
        }
        return null;
    }
};

export default {
    input: "src/index.ts",
    output: {
        file: "out/index.js",
        format: "cjs"
    },
    external: [
        'fs', 'path', 'process', 'zlib',
        'canvas', 'fast-xml-parser', 'flatbuffers'
    ],
    plugins: [resolveTs, typescript()]
}