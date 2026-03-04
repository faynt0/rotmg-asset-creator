/**
 * Muledump Renderer - TypeScript port
 *
 * Parses game XML files and sprite sheets to produce:
 *   - constants.js  (items, classes, skins, petAbilities, textures, pets, petSkins)
 *   - renders.png   (composite item icon spritesheet)
 *   - sheets.js     (base64-encoded skin/textile/pet skin sheets + renders)
 *
 * This replaces the standalone Python renderer/render.py.
 */

import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import { createCanvas, loadImage, Canvas, CanvasRenderingContext2D, Image } from 'canvas';
import { parse } from 'fast-xml-parser';

// ── public interface ────────────────────────────────────────────────

export interface RendererConfig {
    /** Path to the data directory containing xml/ and sheets/ (e.g. "./data") */
    source: string;
    /** Output directory for constants.js, renders.png, sheets.js */
    dest: string;
    /** Game version string embedded in constants.js header */
    gameVersion?: string;
    /** Build hash embedded in constants.js header */
    buildHash?: string;
}

// ── types ───────────────────────────────────────────────────────────

type ItemData = [string, number, number, number, number, number, number, number, boolean, number, boolean];
type ClassData = [string, number[], number[], number[], number[]];
type SkinData = [string, number, boolean, string, number];
type TextureData = (string | number | null)[];
type PetData = (string | number | null)[];
type PetSkinData = (string | number | boolean | null)[];

// ── helpers ─────────────────────────────────────────────────────────

function parseHexOrDec(val: string): number {
    if (typeof val === 'number') return val;
    const s = String(val).trim();
    if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s.slice(2), 16);
    return parseInt(s, 10);
}

function argbSplit(x: number): [number, number, number, number] {
    const u = x >>> 0; // unsigned 32-bit
    const a = (u >>> 24) & 0xFF;
    const r = (u >>> 16) & 0xFF;
    const g = (u >>> 8) & 0xFF;
    const b = u & 0xFF;
    return [a, r, g, b];
}

/** Ensure a value is always an array (XML parser collapses single-element arrays). */
function ensureArray<T>(v: T | T[]): T[] {
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
}

function getTextContent(node: any): string | undefined {
    if (node == null) return undefined;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (node['#text'] != null) return String(node['#text']);
    return undefined;
}

// ── renderer ────────────────────────────────────────────────────────

export async function runRenderer(cfg: RendererConfig): Promise<void> {
    const source = cfg.source;
    const dest = cfg.dest;
    const GAME_VERSION = cfg.gameVersion ?? '0.0.0.0.0';
    const BUILD_HASH = cfg.buildHash ?? '';

    const IMAGE_DIR = path.join(source, 'sheets');
    const XML_DIR = path.join(source, 'xml');

    // Ensure output dir exists
    await fsPromises.mkdir(dest, { recursive: true });

    // Clean previous output
    for (const f of ['constants.js', 'constants.json', 'renders.png', 'sheets.js', 'sheets.json']) {
        const p = path.join(dest, f);
        try { await fsPromises.unlink(p); } catch { /* ignore */ }
    }

    // Image cache
    const imageCache = new Map<string, Image>();
    async function loadSheetImage(name: string): Promise<Image> {
        if (!imageCache.has(name)) {
            const img = await loadImage(path.join(IMAGE_DIR, name + '.png'));
            imageCache.set(name, img);
        }
        return imageCache.get(name)!;
    }

    // Render canvas (100-column grid of 45×45 cells with 5px gutter)
    // Height is pre-allocated for up to 200 rows to handle large item sets.
    const GRID = 100;
    const MAX_ROWS = 200;
    const CELL = 45;
    const render = createCanvas(CELL * GRID + 5, CELL * MAX_ROWS + 5);
    const renderCtx = render.getContext('2d');

    // black 40×40 image for shadow
    const allBlack = createCanvas(40, 40);
    const abCtx = allBlack.getContext('2d');
    abCtx.fillStyle = 'black';
    abCtx.fillRect(0, 0, 40, 40);

    let imgx = 2; // skip Empty and Unknown slots
    let imgy = 0;

    // Data collections
    const items = new Map<number, ItemData>();
    items.set(-1, ['Empty Slot', 0, -1, 5, 5, 0, 0, 0, false, 0, false]);
    items.set(0, ['Unknown Item', 0, -1, 50, 5, 0, 0, 0, false, 0, false]);

    const classes = new Map<number, ClassData>();
    const skins = new Map<number, SkinData>();
    const petAbilities = new Map<number, string>();
    const textures = new Map<number, TextureData>();
    const pets = new Map<number, PetData>();
    const petSkins = new Map<number, PetSkinData>();

    const skinFiles = new Set<string>(['players']);
    const textileFiles = new Set<number>();
    const petSkinFiles = new Set<string>();

    // Paste error.png at slot 1 (position 50,5)
    try {
        const errorImg = await loadImage(path.join(source, '..', 'error.png'));
        renderCtx.drawImage(errorImg, 50, 5);
    } catch {
        // error.png not found – draw a red square as fallback
        renderCtx.fillStyle = 'red';
        renderCtx.fillRect(50, 5, 40, 40);
    }

    // Cache for deduplicating invalid-textile mask renders.
    // Key: "<maskFile>:<maskIndex>:<tex1|tex2>"  →  [dx, dy] of the first render.
    const invalidTexCache = new Map<string, [number, number]>();

    // ── Gather and process XML ──────────────────────────────────────

    console.log('+ Gathering XML');
    const xmlFiles = (await fsPromises.readdir(XML_DIR))
        .filter(f => f.endsWith('.xml'))
        .sort();

    console.log('+ Processing XML');

    for (const xmlFile of xmlFiles) {
        const xmlPath = path.join(XML_DIR, xmlFile);
        let xmlData: string;
        try {
            xmlData = await fsPromises.readFile(xmlPath, 'utf-8');
        } catch { continue; }

        let data: any;
        try {
            data = parse(xmlData, {
                ignoreAttributes: false,
                attributeNamePrefix: '@_',
                textNodeName: '#text',
                parseAttributeValue: false,
                parseTrueNumberOnly: false,
            });
        } catch { continue; }

        // Determine root element
        const rootKey = Object.keys(data).find(k => k !== '?xml');
        if (!rootKey) continue;
        const root = data[rootKey];

        if (rootKey === 'Objects' && root.Object) {
            const objects = ensureArray(root.Object);

            for (const obj of objects) {
                if (!obj.Class) continue;
                const clazz = getTextContent(Array.isArray(obj.Class) ? obj.Class[0] : obj.Class) ?? '';
                const objType = String(obj['@_type'] ?? '');
                const objId = String(obj['@_id'] ?? '');

                // ── Player ──────────────────────────────────────────
                if (clazz === 'Player') {
                    const baseStats = [
                        parseInt(getTextContent(obj.MaxHitPoints)!, 10),
                        parseInt(getTextContent(obj.MaxMagicPoints)!, 10),
                        parseInt(getTextContent(obj.Attack)!, 10),
                        parseInt(getTextContent(obj.Defense)!, 10),
                        parseInt(getTextContent(obj.Speed)!, 10),
                        parseInt(getTextContent(obj.Dexterity)!, 10),
                        parseInt(getTextContent(obj.HpRegen)!, 10),
                        parseInt(getTextContent(obj.MpRegen)!, 10),
                    ];

                    const averages: Record<string, number> = {};
                    for (const li of ensureArray(obj.LevelIncrease)) {
                        const stat = getTextContent(li)!;
                        const minV = parseInt(String(li['@_min']), 10);
                        const maxV = parseInt(String(li['@_max']), 10);
                        averages[stat] = (minV + maxV) / 2 * 19;
                    }
                    const avgs = [
                        averages['MaxHitPoints'] ?? 0,
                        averages['MaxMagicPoints'] ?? 0,
                        averages['Attack'] ?? 0,
                        averages['Defense'] ?? 0,
                        averages['Speed'] ?? 0,
                        averages['Dexterity'] ?? 0,
                        averages['HpRegen'] ?? 0,
                        averages['MpRegen'] ?? 0,
                    ].map((v, i) => v + baseStats[i]);

                    const maxStats = [
                        parseInt(String(obj.MaxHitPoints?.['@_max']), 10),
                        parseInt(String(obj.MaxMagicPoints?.['@_max']), 10),
                        parseInt(String(obj.Attack?.['@_max']), 10),
                        parseInt(String(obj.Defense?.['@_max']), 10),
                        parseInt(String(obj.Speed?.['@_max']), 10),
                        parseInt(String(obj.Dexterity?.['@_max']), 10),
                        parseInt(String(obj.HpRegen?.['@_max']), 10),
                        parseInt(String(obj.MpRegen?.['@_max']), 10),
                    ];

                    const key = parseHexOrDec(objType);
                    const slotTypes = getTextContent(obj.SlotTypes)!.split(',').slice(0, 4).map(s => parseInt(s.trim(), 10));

                    classes.set(key, [objId, baseStats, avgs, maxStats, slotTypes]);

                    const animIndex = parseHexOrDec(getTextContent(obj.AnimatedTexture.Index)!);
                    const animFile = getTextContent(obj.AnimatedTexture.File)!;
                    skins.set(key, [objId, animIndex, false, animFile, key]);
                }

                // ── Skin ────────────────────────────────────────────
                if (clazz === 'Skin' || obj.Skin != null) {
                    if (!obj.PlayerClassType || !obj.AnimatedTexture) continue;
                    const pctStr = getTextContent(obj.PlayerClassType)!;
                    const skinTypeKey = parseHexOrDec(objType);
                    const animIndex = parseHexOrDec(getTextContent(obj.AnimatedTexture.Index)!);
                    const animFile = getTextContent(obj.AnimatedTexture.File)!;
                    const is16 = animFile.includes('16');
                    skins.set(skinTypeKey, [
                        objId,
                        animIndex,
                        is16,
                        animFile,
                        parseHexOrDec(pctStr),
                    ]);
                    skinFiles.add(animFile);
                }

                // ── PetAbility ──────────────────────────────────────
                if (clazz === 'PetAbility' || obj.PetAbility != null) {
                    petAbilities.set(parseHexOrDec(objType), objId);
                }

                // ── Dye (textures table) ────────────────────────────
                if (clazz === 'Dye') {
                    let texKey: number;
                    let offs: number;
                    if (obj.Tex1 != null) {
                        texKey = parseHexOrDec(getTextContent(obj.Tex1)!);
                        offs = 0;
                    } else if (obj.Tex2 != null) {
                        texKey = parseHexOrDec(getTextContent(obj.Tex2)!);
                        offs = 2;
                    } else {
                        continue;
                    }
                    const entry: TextureData = textures.get(texKey) ?? [null, null, null, null];
                    entry[offs] = objId;
                    entry[offs + 1] = parseHexOrDec(objType);
                    textures.set(texKey, entry);
                }

                // ── Equipment / Dye (item render) ───────────────────
                if (clazz === 'Equipment' || clazz === 'Dye') {
                    const bagType = obj.BagType != null ? parseInt(getTextContent(obj.BagType)!, 10) : 0;

                    let displayName: string;
                    if (obj.DisplayId != null && clazz !== 'Dye') {
                        const did = Array.isArray(obj.DisplayId) ? obj.DisplayId[0] : obj.DisplayId;
                        displayName = getTextContent(did) ?? objId;
                    } else {
                        displayName = objId;
                    }

                    const typeNum = parseHexOrDec(objType);
                    const tier = obj.Tier != null ? parseInt(getTextContent(obj.Tier)!, 10) : -1;
                    const xp = obj.XPBonus != null ? parseInt(getTextContent(obj.XPBonus)!, 10) : 0;
                    const fp = obj.feedPower != null ? parseInt(getTextContent(obj.feedPower)!, 10) : 0;

                    let slot = 0;
                    if (obj.SlotType != null) {
                        const st = Array.isArray(obj.SlotType) ? obj.SlotType[0] : obj.SlotType;
                        slot = parseInt(getTextContent(st)!, 10);
                    }

                    const soulbound = obj.Soulbound != null;

                    let utst = 0;
                    // Check for set name in the raw text (approximate repr check)
                    const objStr = JSON.stringify(obj);
                    if (objStr.includes('setName')) {
                        utst = 2;
                    } else if ((slot >= 1 && slot <= 9) || (slot >= 11 && slot <= 25)) {
                        if (soulbound && tier === -1) {
                            utst = 1;
                        }
                    }

                    const labels = obj.Labels != null ? (getTextContent(obj.Labels) ?? '') : '';
                    const shiny = /\bSHINY\b/i.test(labels) || /shiny/i.test(objId);

                    // Reuse an already-rendered invalid-textile mask sprite instead of
                    // drawing another identical one.
                    if (obj.Mask && (obj.Tex1 != null || obj.Tex2 != null)) {
                        const rawTex = getTextContent(obj.Tex1 != null ? obj.Tex1 : obj.Tex2);
                        if (rawTex) {
                            const [ta, tr, tg] = argbSplit(parseHexOrDec(rawTex));
                            if (ta !== 1 && (tr > 0 || tg > 0)) {
                                const mfKey = getTextContent(obj.Mask.File) ?? '';
                                const miKey = String(parseHexOrDec(getTextContent(obj.Mask.Index) ?? '0'));
                                const tcKey = obj.Tex1 != null ? 'tex1' : 'tex2';
                                const cached = invalidTexCache.get(`${mfKey}:${miKey}:${tcKey}`);
                                if (cached) {
                                    items.set(typeNum, [displayName, slot, tier, cached[0], cached[1], xp, fp, bagType, soulbound, utst, shiny]);
                                    continue;
                                }
                            }
                        }
                    }

                    // Determine image source
                    let imageName: string;
                    let imageIndex: number;
                    if (obj.Texture) {
                        imageName = getTextContent(obj.Texture.File)!;
                        imageIndex = parseHexOrDec(getTextContent(obj.Texture.Index)!);
                    } else if (obj.AnimatedTexture) {
                        imageName = getTextContent(obj.AnimatedTexture.File)!;
                        imageIndex = parseHexOrDec(getTextContent(obj.AnimatedTexture.Index)!);
                    } else {
                        continue;
                    }

                    const normalIndex = ![
                        'playerskins', 'oryxSanctuaryChars32x32', 'chars8x8dEncounters',
                        'chars8x8rPets1', 'chars16x16dEncounters2', 'characters',
                        'petsDivine', 'epicHiveChars16x16', 'playerskins16', 'playerskins32',
                    ].includes(imageName);

                    let img: Image;
                    try {
                        img = await loadSheetImage(imageName);
                    } catch {
                        console.warn(`  Warning: could not load sheet ${imageName}, skipping ${displayName}`);
                        continue;
                    }

                    let imgTileSize = 8;
                    if (imageName.includes('16') || imageName === 'petsDivine') {
                        imgTileSize = 16;
                    } else if (imageName.includes('32')) {
                        imgTileSize = 32;
                    }

                    let srcx: number, srcy: number;
                    if (normalIndex) {
                        const srcw = img.width / imgTileSize;
                        srcx = imgTileSize * (imageIndex % srcw);
                        srcy = imgTileSize * Math.floor(imageIndex / srcw);
                    } else if (imageName === 'playerskins' || imageName === 'characters') {
                        srcx = 0;
                        srcy = 3 * imgTileSize * imageIndex;
                    } else {
                        srcx = 0;
                        srcy = imgTileSize * imageIndex;
                    }

                    // Draw the item icon onto the render canvas
                    const dx = imgx * CELL + 5;
                    const dy = imgy * CELL + 5;

                    // Create a temp canvas to resize and add border
                    const iconCanvas = createCanvas(40, 40);
                    const iconCtx = iconCanvas.getContext('2d');
                    iconCtx.imageSmoothingEnabled = false;
                    // 4px border → draw at (4,4) as 32×32
                    iconCtx.drawImage(img, srcx, srcy, imgTileSize, imgTileSize, 4, 4, 32, 32);

                    // Edge detection for shadow (alpha channel dilate via max filter 3×3)
                    const edgeCanvas = createCanvas(40, 40);
                    const edgeCtx = edgeCanvas.getContext('2d');
                    const iconPixels = iconCtx.getImageData(0, 0, 40, 40);
                    const alpha = new Uint8Array(40 * 40);
                    for (let i = 0; i < 40 * 40; i++) alpha[i] = iconPixels.data[i * 4 + 3];

                    // Max filter radius 1 (3×3)
                    const dilated = new Uint8Array(40 * 40);
                    for (let py = 0; py < 40; py++) {
                        for (let px = 0; px < 40; px++) {
                            let maxVal = 0;
                            for (let ky = -1; ky <= 1; ky++) {
                                for (let kx = -1; kx <= 1; kx++) {
                                    const ny = py + ky, nx = px + kx;
                                    if (ny >= 0 && ny < 40 && nx >= 0 && nx < 40) {
                                        maxVal = Math.max(maxVal, alpha[ny * 40 + nx]);
                                    }
                                }
                            }
                            dilated[py * 40 + px] = maxVal;
                        }
                    }

                    // Box blur radius 7 for shadow (approximated as 15×15 box)
                    const blurred = new Uint8Array(40 * 40);
                    const R = 7;
                    for (let py = 0; py < 40; py++) {
                        for (let px = 0; px < 40; px++) {
                            let sum = 0, count = 0;
                            for (let ky = -R; ky <= R; ky++) {
                                for (let kx = -R; kx <= R; kx++) {
                                    const ny = py + ky, nx = px + kx;
                                    if (ny >= 0 && ny < 40 && nx >= 0 && nx < 40) {
                                        sum += dilated[ny * 40 + nx];
                                        count++;
                                    }
                                }
                            }
                            blurred[py * 40 + px] = Math.floor(sum / count / 2);
                        }
                    }

                    // Draw shadow (allblack with blurred alpha)
                    const shadowData = renderCtx.createImageData(40, 40);
                    for (let i = 0; i < 40 * 40; i++) {
                        shadowData.data[i * 4 + 3] = blurred[i];
                    }
                    const shadowCanvas = createCanvas(40, 40);
                    shadowCanvas.getContext('2d').putImageData(shadowData, 0, 0);
                    renderCtx.drawImage(shadowCanvas, dx, dy);

                    // Draw edge (allblack with dilated alpha)
                    const edgeData = renderCtx.createImageData(40, 40);
                    for (let i = 0; i < 40 * 40; i++) {
                        edgeData.data[i * 4 + 3] = dilated[i];
                    }
                    const edgeShadowCanvas = createCanvas(40, 40);
                    edgeShadowCanvas.getContext('2d').putImageData(edgeData, 0, 0);
                    renderCtx.drawImage(edgeShadowCanvas, dx, dy);

                    // Draw the icon itself (cropped 1px border → 38×38 placed at +1,+1)
                    renderCtx.drawImage(iconCanvas, 1, 1, 38, 38, dx + 1, dy + 1, 38, 38);

                    // ── Mask handling ────────────────────────────────
                    if (obj.Mask) {
                        const maskName = getTextContent(obj.Mask.File)!;
                        const maskIndex = parseHexOrDec(getTextContent(obj.Mask.Index)!);
                        let maskImg: Image;
                        try {
                            maskImg = await loadSheetImage(maskName);
                        } catch {
                            maskImg = img;
                        }

                        const msrcw = maskImg.width / imgTileSize;
                        const msrcx = imgTileSize * (maskIndex % msrcw);
                        const msrcy = imgTileSize * Math.floor(maskIndex / msrcw);

                        // Create mask canvas (40×40)
                        const maskCanvas = createCanvas(40, 40);
                        const maskCtx = maskCanvas.getContext('2d');
                        maskCtx.imageSmoothingEnabled = false;
                        maskCtx.drawImage(maskImg, msrcx, msrcy, imgTileSize, imgTileSize, 4, 4, 32, 32);

                        // Determine tex color/texture
                        // isTex1 = large clothes (Tex1), false = small clothes (Tex2)
                        let texStr: string | undefined;
                        let isTex1 = false;
                        if (obj.Tex1 != null) {
                            texStr = getTextContent(obj.Tex1);
                            isTex1 = true;
                        } else if (obj.Tex2 != null) {
                            texStr = getTextContent(obj.Tex2);
                        }

                        if (texStr) {
                            const texVal = parseHexOrDec(texStr);
                            const [a, r, g, b] = argbSplit(texVal);

                            let fillCanvas: Canvas;
                            if (a === 1) {
                                // Solid color
                                fillCanvas = createCanvas(40, 40);
                                const fCtx = fillCanvas.getContext('2d');
                                fCtx.fillStyle = `rgb(${r},${g},${b})`;
                                fCtx.fillRect(0, 0, 40, 40);
                            } else {
                                // Textile
                                if (r > 0 || g > 0) {
                                    // Invalid textile value – fill mask with error color:
                                    //   Tex1 (large clothes) → red
                                    //   Tex2 (small clothes) → green
                                    fillCanvas = createCanvas(40, 40);
                                    const fCtx = fillCanvas.getContext('2d');
                                    fCtx.fillStyle = isTex1 ? '#ff0000' : '#08e200';
                                    fCtx.fillRect(0, 0, 40, 40);
                                } else {
                                textileFiles.add(a);
                                let texImg: Image;
                                try {
                                    texImg = await loadSheetImage(`textile${a}x${a}`);
                                } catch {
                                    console.warn(`  Could not load textile${a}x${a}`);
                                    continue;
                                }
                                const tsrcw = texImg.width / a;
                                const tsrcx = a * (b % tsrcw);
                                const tsrcy = a * Math.floor(b / tsrcw);
                                // Tile the textile to fill 40×40
                                fillCanvas = createCanvas(40, 40);
                                const fCtx = fillCanvas.getContext('2d');
                                fCtx.imageSmoothingEnabled = false;
                                // First extract the tile
                                const tileCanvas = createCanvas(a, a);
                                const tileCtx = tileCanvas.getContext('2d');
                                tileCtx.drawImage(texImg, tsrcx, tsrcy, a, a, 0, 0, a, a);
                                // Tile it
                                for (let ty = 0; ty < 40; ty += a) {
                                    for (let tx = 0; tx < 40; tx += a) {
                                        fCtx.drawImage(tileCanvas, tx, ty);
                                    }
                                }
                                } // end valid textile
                            }

                            // Apply mask (draw allblack with mask alpha, then fill with mask)
                            renderCtx.save();
                            // Draw the black shadow using mask
                            const maskPixels = maskCtx.getImageData(0, 0, 40, 40);
                            const maskAlpha = createCanvas(40, 40);
                            const maCtx = maskAlpha.getContext('2d');
                            maCtx.putImageData(maskPixels, 0, 0);

                            // Composite: draw black behind the mask area
                            const tempCanvas = createCanvas(40, 40);
                            const tempCtx = tempCanvas.getContext('2d');
                            tempCtx.drawImage(maskAlpha, 0, 0);
                            tempCtx.globalCompositeOperation = 'source-in';
                            tempCtx.fillStyle = 'black';
                            tempCtx.fillRect(0, 0, 40, 40);
                            renderCtx.drawImage(tempCanvas, dx, dy);

                            // Fill with color/texture using mask 
                            const fillMasked = createCanvas(40, 40);
                            const fmCtx = fillMasked.getContext('2d');
                            fmCtx.drawImage(maskAlpha, 0, 0);
                            fmCtx.globalCompositeOperation = 'source-in';
                            fmCtx.drawImage(fillCanvas, 0, 0);
                            renderCtx.drawImage(fillMasked, dx, dy);

                            renderCtx.restore();

                            // On the first render of an invalid-textile mask, record the
                            // sprite position so subsequent identical items can reuse it.
                            if (a !== 1 && (r > 0 || g > 0)) {
                                const tcKey = isTex1 ? 'tex1' : 'tex2';
                                const ck = `${maskName}:${maskIndex}:${tcKey}`;
                                if (!invalidTexCache.has(ck)) {
                                    invalidTexCache.set(ck, [dx, dy]);
                                }
                            }
                        }
                    }

                    // ── Quantity text ────────────────────────────────
                    if (obj.Quantity != null) {
                        const num = getTextContent(obj.Quantity)!;
                        const tx = dx + 3;
                        const ty = dy + 3 + 10; // baseline offset since canvas text draws from baseline
                        renderCtx.font = '10px sans-serif';
                        // Black outline (8 directions)
                        renderCtx.fillStyle = '#000';
                        for (const [ox, oy] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
                            renderCtx.fillText(num, tx + ox, ty + oy);
                        }
                        // White text
                        renderCtx.fillStyle = '#fff';
                        renderCtx.fillText(num, tx, ty);
                    }

                    items.set(typeNum, [displayName, slot, tier, dx, dy, xp, fp, bagType, soulbound, utst, shiny]);
                    imgx++;
                    if (imgx >= GRID) {
                        imgx = 0;
                        imgy++;
                    }
                }

                // ── Pet ─────────────────────────────────────────────
                if (clazz === 'Pet') {
                    const petId = parseHexOrDec(objType);
                    const family = obj.Family != null ? (getTextContent(obj.Family) ?? '').replace(/\n/g, '').trim() || null : null;
                    const rarity = obj.Rarity != null ? (getTextContent(obj.Rarity) ?? '').replace(/\n/g, '').trim() || null : null;
                    const defaultSkin = obj.DefaultSkin != null ? (getTextContent(obj.DefaultSkin) ?? '').replace(/\n/g, '').trim() || null : null;
                    let size: number | null = null;
                    if (obj.Size != null) {
                        const sv = (getTextContent(obj.Size) ?? '').replace(/\n/g, '').trim();
                        size = sv ? parseInt(sv, 10) : null;
                    }
                    pets.set(petId, [objId, family, rarity, defaultSkin, size]);
                }

                // ── PetSkin ─────────────────────────────────────────
                if (clazz === 'PetSkin') {
                    const petskinId = parseHexOrDec(objType);
                    const displayId = obj.DisplayId != null ? (getTextContent(Array.isArray(obj.DisplayId) ? obj.DisplayId[0] : obj.DisplayId) ?? '').replace(/\n/g, '').trim() || null : null;
                    let itemTier: number | null = null;
                    if (obj.ItemTier != null) {
                        const itv = (getTextContent(obj.ItemTier) ?? '').replace(/\n/g, '').trim();
                        itemTier = itv ? parseInt(itv, 10) : null;
                    }
                    const family = obj.Family != null ? (getTextContent(obj.Family) ?? '').replace(/\n/g, '').trim() || null : null;
                    const rarity = obj.Rarity != null ? (getTextContent(obj.Rarity) ?? '').replace(/\n/g, '').trim() || null : null;

                    if (!obj.AnimatedTexture) continue;
                    const animIndex = parseHexOrDec(getTextContent(obj.AnimatedTexture.Index)!);
                    const animFile = getTextContent(obj.AnimatedTexture.File)!;
                    const is16 = animFile.includes('16');

                    petSkins.set(petskinId, [objId, displayId, itemTier, family, rarity, animIndex, is16, animFile]);
                    petSkinFiles.add(animFile);
                }
            }
        }
    }

    // ── Crop render to actual size ──────────────────────────────────
    const finalHeight = CELL * (imgy + 1) + 5;
    const finalRender = createCanvas(CELL * GRID + 5, finalHeight);
    const frCtx = finalRender.getContext('2d');
    frCtx.drawImage(render, 0, 0);

    // ── Write constants.js ──────────────────────────────────────────
    console.log('+ Writing constants.js');
    const now = new Date();
    const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
    ].join('');

    let cjs = '';
    cjs += '//  Generated with https://github.com/jakcodex/muledump-render\n';
    cjs += `//  Realm of the Mad God v${GAME_VERSION}`;
    if (BUILD_HASH) cjs += ` (build: ${BUILD_HASH})`;
    cjs += '\n\n';
    cjs += `rendersVersion = "renders-${timestamp}-${GAME_VERSION}";\n\n`;

    // items
    cjs += '//   type: ["id", SlotType, Tier, x, y, FameBonus, feedPower, BagType, Soulbound, UT/ST, Shiny],\n';
    cjs += 'items = {\n';
    for (const [id, data] of [...items.entries()].sort((a, b) => a[0] - b[0])) {
        const formatted = formatJsArray(data);
        if (id === -1) {
            cjs += `  '${id}': ${formatted},\n`;
        } else {
            cjs += `  ${id}: ${formatted},\n`;
        }
    }
    cjs += '};\n\n';

    // classes
    cjs += '//   type: ["id", base, averages, maxes, slots]\n';
    cjs += 'classes = {\n';
    for (const [id, data] of [...classes.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: ${formatJsArray(data)},\n`;
    }
    cjs += '};\n\n';

    // skins
    cjs += '//   type: ["id", index, 16x16, "sheet", class]\n';
    cjs += 'skins = {\n';
    for (const [id, data] of [...skins.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: ${formatJsArray(data)},\n`;
    }
    cjs += '};\n\n';

    // petAbilities
    cjs += '//   type: "id"\n';
    cjs += 'petAbilities = {\n';
    for (const [id, name] of [...petAbilities.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: "${name}",\n`;
    }
    cjs += '};\n\n';

    // textures
    cjs += '//   texId: ["clothing id", clothing type, "accessory id", accessory type]\n';
    cjs += 'textures = {\n';
    for (const [id, data] of [...textures.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: ${JSON.stringify(data)},\n`;
    }
    cjs += '}\n\n';

    // pets
    cjs += '//  type: ["id", "Family", "Rarity", "DefaultSkin", "Size"]\n';
    cjs += 'pets = {\n';
    for (const [id, data] of [...pets.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: ${JSON.stringify(data)},\n`;
    }
    cjs += '};\n\n';

    // petSkins
    cjs += '//  type: ["id", "DisplayId", "ItemTier", "Family", "Rarity"]\n';
    cjs += 'petSkins = {\n';
    for (const [id, data] of [...petSkins.entries()].sort((a, b) => a[0] - b[0])) {
        cjs += `  ${id}: ${JSON.stringify(data)},\n`;
    }
    cjs += '};\n';

    await fsPromises.writeFile(path.join(dest, 'constants.js'), cjs, 'utf-8');

    // ── Write constants.json ────────────────────────────────────────
    console.log('+ Writing constants.json');
    const jsonExport: Record<string, any> = {
        version: `renders-${timestamp}-${GAME_VERSION}`,
        gameVersion: GAME_VERSION,
        buildHash: BUILD_HASH || undefined,
        items: Object.fromEntries([...items.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            name: d[0], technicalName: d[10] ? d[0] + ' Shiny' : d[0],
            slotType: d[1], tier: d[2], x: d[3], y: d[4],
            fameBonus: d[5], feedPower: d[6], bagType: d[7], isSoulbound: d[8], utst: d[9],
            isShiny: d[10],
        }])),
        classes: Object.fromEntries([...classes.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            name: d[0], base: d[1], averages: d[2], maxes: d[3], slots: d[4],
        }])),
        skins: Object.fromEntries([...skins.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            name: d[0], index: d[1], is16x16: d[2], sheet: d[3], classType: d[4],
        }])),
        petAbilities: Object.fromEntries([...petAbilities.entries()].sort((a, b) => a[0] - b[0])),
        textures: Object.fromEntries([...textures.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            clothingId: d[0], clothingType: d[1], accessoryId: d[2], accessoryType: d[3],
        }])),
        pets: Object.fromEntries([...pets.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            name: d[0], family: d[1], rarity: d[2], defaultSkin: d[3], size: d[4],
        }])),
        petSkins: Object.fromEntries([...petSkins.entries()].sort((a, b) => a[0] - b[0]).map(([id, d]) => [id, {
            name: d[0], displayId: d[1], itemTier: d[2], family: d[3], rarity: d[4],
            animIndex: d[5], is16x16: d[6], sheet: d[7],
        }])),
    };
    await fsPromises.writeFile(path.join(dest, 'constants.json'), JSON.stringify(jsonExport, null, 2), 'utf-8');

    // ── Write renders.png ───────────────────────────────────────────
    console.log('+ Writing renders.png');
    await fsPromises.writeFile(path.join(dest, 'renders.png'), finalRender.toBuffer('image/png'));

    // ── Write sheets.js ─────────────────────────────────────────────
    console.log('+ Writing sheets.js');
    let sjs = '';

    // Textiles
    sjs += 'textiles = {\n';
    for (const tf of [...textileFiles].sort((a, b) => a - b)) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, `textile${tf}x${tf}.png`));
            sjs += `  ${tf}: 'data:image/png;base64,${data.toString('base64')}',\n`;
        } catch {
            console.warn(`  Warning: could not read textile${tf}x${tf}.png`);
        }
    }
    sjs += '};\n\n';

    // Player skins
    sjs += 'skinsheets = {\n';
    for (const sf of [...skinFiles].sort()) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, sf + '.png'));
            sjs += `  ${sf}: 'data:image/png;base64,${data.toString('base64')}',\n`;
        } catch {
            console.warn(`  Warning: could not read ${sf}.png`);
        }
        try {
            const maskData = await fsPromises.readFile(path.join(IMAGE_DIR, sf + '_mask.png'));
            sjs += `  ${sf}Mask: 'data:image/png;base64,${maskData.toString('base64')}',\n`;
        } catch {
            // mask may not exist for all skin files
        }
    }
    sjs += '};\n\n';

    // Pet skins
    sjs += 'petskinsheets = {\n';
    for (const psf of [...petSkinFiles].sort()) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, psf + '.png'));
            sjs += `  ${psf}: 'data:image/png;base64,${data.toString('base64')}',\n`;
        } catch {
            console.warn(`  Warning: could not read ${psf}.png`);
        }
    }
    sjs += '};\n\n';

    // Renders as base64
    const renderBuffer = finalRender.toBuffer('image/png');
    sjs += `renders = 'data:image/png;base64,${renderBuffer.toString('base64')}';\n`;

    await fsPromises.writeFile(path.join(dest, 'sheets.js'), sjs, 'utf-8');

    // ── Write sheets.json ────────────────────────────────────────────
    console.log('+ Writing sheets.json');
    const sheetsJson: Record<string, any> = {
        textiles: {} as Record<number, string>,
        skinsheets: {} as Record<string, string>,
        petskinsheets: {} as Record<string, string>,
        renders: '',
    };

    for (const tf of [...textileFiles].sort((a, b) => a - b)) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, `textile${tf}x${tf}.png`));
            sheetsJson.textiles[tf] = `data:image/png;base64,${data.toString('base64')}`;
        } catch { /* skip missing */ }
    }

    for (const sf of [...skinFiles].sort()) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, sf + '.png'));
            sheetsJson.skinsheets[sf] = `data:image/png;base64,${data.toString('base64')}`;
        } catch { /* skip missing */ }
        try {
            const maskData = await fsPromises.readFile(path.join(IMAGE_DIR, sf + '_mask.png'));
            sheetsJson.skinsheets[sf + 'Mask'] = `data:image/png;base64,${maskData.toString('base64')}`;
        } catch { /* mask may not exist */ }
    }

    for (const psf of [...petSkinFiles].sort()) {
        try {
            const data = await fsPromises.readFile(path.join(IMAGE_DIR, psf + '.png'));
            sheetsJson.petskinsheets[psf] = `data:image/png;base64,${data.toString('base64')}`;
        } catch { /* skip missing */ }
    }

    sheetsJson.renders = `data:image/png;base64,${renderBuffer.toString('base64')}`;

    await fsPromises.writeFile(path.join(dest, 'sheets.json'), JSON.stringify(sheetsJson, null, 2), 'utf-8');

    console.log(`+ Renderer complete. ${items.size} items, ${classes.size} classes, ${skins.size} skins.`);
}

// ── JS formatting helpers ───────────────────────────────────────────

function formatJsArray(arr: any): string {
    if (!Array.isArray(arr)) {
        if (typeof arr === 'boolean') return arr ? 'true' : 'false';
        if (typeof arr === 'string') return JSON.stringify(arr);
        return String(arr);
    }
    const parts = arr.map((v: any) => {
        if (Array.isArray(v)) return formatJsArray(v);
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        if (typeof v === 'string') return JSON.stringify(v);
        if (v === null || v === undefined) return 'null';
        return String(v);
    });
    return `[${parts.join(', ')}]`;
}
