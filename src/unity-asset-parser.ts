/**
 * Unity Serialized File Parser
 * 
 * Parses Unity .assets files (serialized format version 22+) and extracts:
 * - Texture2D assets (as raw RGBA data)
 * - TextAsset assets (as raw bytes)
 * 
 * This replaces the need for the external AssetRipper binary.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

// Unity class IDs we care about
const CLASS_TEXTURE2D = 28;
const CLASS_TEXT_ASSET = 49;

// Unity texture formats
const TEXTURE_FORMAT_RGBA32 = 4;

interface SerializedFileHeader {
    version: number;
    endianness: number;
    metadataSize: number;
    fileSize: number;
    dataOffset: number;
    unityVersion: string;
}

interface TypeEntry {
    classID: number;
    isStripped: boolean;
    scriptTypeIndex: number;
}

interface ObjectInfo {
    pathID: number;
    byteStart: number;
    byteSize: number;
    typeIdx: number;
    classID: number;
}

export interface Texture2DAsset {
    name: string;
    width: number;
    height: number;
    textureFormat: number;
    imageData: Buffer;
}

export interface TextAssetData {
    name: string;
    data: Buffer;
}

/**
 * Read a Unity-style length-prefixed string from a buffer.
 * Returns the string value and the next aligned offset.
 */
function readAlignedString(buf: Buffer, off: number): { value: string; nextOff: number } {
    const len = buf.readInt32LE(off);
    if (len < 0 || len > 10_000_000) {
        throw new Error(`Invalid string length ${len} at offset ${off}`);
    }
    const value = buf.slice(off + 4, off + 4 + len).toString('utf-8');
    const end = off + 4 + len;
    const pad = (4 - (end % 4)) % 4;
    return { value, nextOff: end + pad };
}

/**
 * Parse the serialized file header (format version 22).
 */
function parseHeader(fd: number): SerializedFileHeader {
    const hdr = Buffer.alloc(128);
    fs.readSync(fd, hdr, 0, 128, 0);

    const version = hdr.readUInt32BE(8);
    if (version < 22) {
        throw new Error(`Unsupported serialized file format version: ${version}. Only version 22+ is supported.`);
    }

    const endianness = hdr[16]; // 0 = LE, 1 = BE
    const metadataSize = hdr.readUInt32BE(20);
    const fileSizeHi = hdr.readUInt32BE(24);
    const fileSizeLo = hdr.readUInt32BE(28);
    const fileSize = fileSizeHi * 0x100000000 + fileSizeLo;
    const dataOffsetHi = hdr.readUInt32BE(32);
    const dataOffsetLo = hdr.readUInt32BE(36);
    const dataOffset = dataOffsetHi * 0x100000000 + dataOffsetLo;

    // Version string starts at byte 48
    let strOff = 48;
    let unityVersion = '';
    while (hdr[strOff] !== 0 && strOff < 128) {
        unityVersion += String.fromCharCode(hdr[strOff]);
        strOff++;
    }

    return { version, endianness, metadataSize, fileSize, dataOffset, unityVersion };
}

/**
 * Parse type entries from the metadata section.
 */
function parseTypes(metaBuf: Buffer, startOff: number): { types: TypeEntry[]; nextOff: number } {
    let off = startOff;

    // targetPlatform (int32)
    off += 4;

    // enableTypeTree (bool)
    const enableTypeTree = metaBuf[off] !== 0;
    off += 1;

    if (enableTypeTree) {
        throw new Error('Type tree parsing is not implemented. Only assets with enableTypeTree=false are supported.');
    }

    // typeCount (int32)
    const typeCount = metaBuf.readInt32LE(off);
    off += 4;

    const types: TypeEntry[] = [];
    for (let i = 0; i < typeCount; i++) {
        const classID = metaBuf.readInt32LE(off); off += 4;
        const isStripped = metaBuf[off] !== 0; off += 1;
        const scriptTypeIndex = metaBuf.readInt16LE(off); off += 2;

        // MonoBehaviour types have an extra scriptID hash
        if (classID === 114) {
            off += 16; // Skip Hash128 scriptID
        }

        // oldTypeHash (Hash128 = 16 bytes)
        off += 16;

        types.push({ classID, isStripped, scriptTypeIndex });
    }

    return { types, nextOff: off };
}

/**
 * Parse the object info table from metadata.
 */
function parseObjects(metaBuf: Buffer, startOff: number, types: TypeEntry[]): { objects: ObjectInfo[]; nextOff: number } {
    let off = startOff;

    const objectCount = metaBuf.readInt32LE(off);
    off += 4;

    const objects: ObjectInfo[] = [];
    for (let i = 0; i < objectCount; i++) {
        // Align to 4 bytes
        if (off % 4 !== 0) off += 4 - (off % 4);

        const pathID = Number(metaBuf.readBigInt64LE(off)); off += 8;
        const byteStartLo = metaBuf.readUInt32LE(off); off += 4;
        const byteStartHi = metaBuf.readUInt32LE(off); off += 4;
        const byteSize = metaBuf.readUInt32LE(off); off += 4;
        const typeIdx = metaBuf.readInt32LE(off); off += 4;

        const byteStart = byteStartHi * 0x100000000 + byteStartLo;
        const classID = types[typeIdx]?.classID ?? -1;

        objects.push({ pathID, byteStart, byteSize, typeIdx, classID });
    }

    return { objects, nextOff: off };
}

/**
 * Read the name of an object from its data. Both Texture2D and TextAsset
 * start with a length-prefixed string (m_Name).
 */
function readObjectName(fd: number, dataOffset: number, obj: ObjectInfo): string {
    const buf = Buffer.alloc(256);
    fs.readSync(fd, buf, 0, 256, dataOffset + obj.byteStart);
    const { value } = readAlignedString(buf, 0);
    return value;
}

/**
 * Extract a Texture2D asset from the file.
 * 
 * Texture2D layout (Unity 6000 / format v22, RGBA32, no streaming):
 *   - string m_Name
 *   - int32  m_ForcedFallbackFormat
 *   - int32  m_Width
 *   - int32  m_Height
 *   - int32  m_CompleteImageSize
 *   - int32  m_MipsStripped
 *   - int32  m_TextureFormat
 *   - int32  m_MipCount
 *   - ... (various settings, ~60 bytes)
 *   - int32  imageDataLength
 *   - byte[] imageData
 *   - StreamingInfo (offset, size, path)
 */
export function extractTexture2D(fd: number, dataOffset: number, obj: ObjectInfo): Texture2DAsset {
    // Read the header portion (up to 256 bytes should be enough)
    const headerBuf = Buffer.alloc(256);
    fs.readSync(fd, headerBuf, 0, 256, dataOffset + obj.byteStart);

    let off = 0;
    const name = readAlignedString(headerBuf, off);
    off = name.nextOff;

    const forcedFallbackFormat = headerBuf.readInt32LE(off); off += 4;
    const width = headerBuf.readInt32LE(off); off += 4;
    const height = headerBuf.readInt32LE(off); off += 4;
    const completeImageSize = headerBuf.readInt32LE(off); off += 4;
    const mipsStripped = headerBuf.readInt32LE(off); off += 4;
    const textureFormat = headerBuf.readInt32LE(off); off += 4;
    const mipCount = headerBuf.readInt32LE(off); off += 4;

    if (textureFormat !== TEXTURE_FORMAT_RGBA32) {
        console.warn(`Warning: Texture "${name.value}" has format ${textureFormat}, expected RGBA32 (4). Attempting extraction anyway.`);
    }

    // Find the image data array by scanning for the array length value
    // The length should equal completeImageSize
    let dataArrayOff = -1;
    for (let i = off; i < 200; i += 4) {
        const val = headerBuf.readInt32LE(i);
        if (val === completeImageSize && completeImageSize > 0) {
            dataArrayOff = i;
            break;
        }
    }

    if (dataArrayOff === -1) {
        throw new Error(`Could not find image data array for texture "${name.value}"`);
    }

    const imageDataOffset = dataOffset + obj.byteStart + dataArrayOff + 4;
    const imageData = Buffer.alloc(completeImageSize);
    fs.readSync(fd, imageData, 0, completeImageSize, imageDataOffset);

    return {
        name: name.value,
        width,
        height,
        textureFormat,
        imageData,
    };
}

/**
 * Extract a TextAsset from the file.
 * 
 * TextAsset layout:
 *   - string m_Name
 *   - byte[] m_Script (int32 length + data)
 */
export function extractTextAsset(fd: number, dataOffset: number, obj: ObjectInfo): TextAssetData {
    // Read the name first
    const nameBuf = Buffer.alloc(256);
    fs.readSync(fd, nameBuf, 0, 256, dataOffset + obj.byteStart);
    const name = readAlignedString(nameBuf, 0);

    // Read the script data length
    const lenBuf = Buffer.alloc(4);
    fs.readSync(fd, lenBuf, 0, 4, dataOffset + obj.byteStart + name.nextOff);
    const scriptLen = lenBuf.readInt32LE(0);

    // Read the script data
    const data = Buffer.alloc(scriptLen);
    fs.readSync(fd, data, 0, scriptLen, dataOffset + obj.byteStart + name.nextOff + 4);

    return { name: name.value, data };
}

/**
 * Convert raw RGBA32 image data to a PNG buffer.
 * Unity stores textures with origin at bottom-left, so we flip rows.
 * Uses a minimal PNG encoder (Node zlib) to avoid native dependencies.
 */
export function rgba32ToPng(imageData: Buffer, width: number, height: number): Buffer {
    const rowSize = width * 4;

    // Build the raw image data with filter bytes (filter = 0 = None for each row)
    // Flip Y: Unity row 0 = bottom, PNG row 0 = top
    const rawData = Buffer.alloc((rowSize + 1) * height);
    for (let y = 0; y < height; y++) {
        const srcRow = (height - 1 - y) * rowSize;
        const dstOff = y * (rowSize + 1);
        rawData[dstOff] = 0; // filter byte = None
        imageData.copy(rawData, dstOff + 1, srcRow, srcRow + rowSize);
    }

    // Compress with zlib deflate
    const compressed = zlib.deflateSync(rawData, { level: 6 });

    // Build PNG file
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type = RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    const ihdrChunk = createPngChunk('IHDR', ihdr);
    const idatChunk = createPngChunk('IDAT', compressed);
    const iendChunk = createPngChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Create a PNG chunk with CRC.
 */
function createPngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    // CRC32 over type + data
    const crcInput = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);

    return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * CRC32 implementation for PNG chunks.
 */
const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
        if (c & 1) {
            c = 0xEDB88320 ^ (c >>> 1);
        } else {
            c = c >>> 1;
        }
    }
    crcTable[n] = c;
}

function crc32(buf: Buffer): number {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    }
    return crc ^ 0xFFFFFFFF;
}

/**
 * Main interface: parse a Unity .assets file and return categorized objects.
 */
export function parseAssetsFile(assetsPath: string): {
    header: SerializedFileHeader;
    types: TypeEntry[];
    objects: ObjectInfo[];
    fd: number;
    dataOffset: number;
} {
    const fd = fs.openSync(assetsPath, 'r');
    const header = parseHeader(fd);

    // Read the full metadata section
    const metaBuf = Buffer.alloc(header.metadataSize + 1024);
    fs.readSync(fd, metaBuf, 0, metaBuf.length, 48);

    // Skip version string in metadata
    let off = 0;
    while (metaBuf[off] !== 0) off++;
    off++; // skip null terminator

    const { types, nextOff: typesEnd } = parseTypes(metaBuf, off);
    const { objects } = parseObjects(metaBuf, typesEnd, types);

    return { header, types, objects, fd, dataOffset: header.dataOffset };
}

/**
 * High-level extraction: extract from resources.assets and write files
 * to the expected directory structure.
 * 
 * Replaces the AssetRipper external tool.
 */
export async function extractAssets(
    assetsPath: string,
    outputDir: string,
    atlasDir: string
): Promise<void> {
    console.log(`Parsing Unity assets file: ${assetsPath}`);
    const { header, objects, fd, dataOffset } = parseAssetsFile(assetsPath);
    console.log(`Unity version: ${header.unityVersion}`);
    console.log(`Found ${objects.length} objects`);

    // Categorize objects
    const texture2DObjects = objects.filter(o => o.classID === CLASS_TEXTURE2D);
    const textAssetObjects = objects.filter(o => o.classID === CLASS_TEXT_ASSET);
    console.log(`Texture2D: ${texture2DObjects.length}, TextAsset: ${textAssetObjects.length}`);

    // Target textures we need for sprite extraction
    const targetTextureNames = new Set([
        'characters', 'characters_masks', 'groundTiles', 'mapObjects'
    ]);

    // Create output directories
    const { promises: fsp } = require('fs');
    await fsp.mkdir(atlasDir, { recursive: true });
    await fsp.mkdir(`${outputDir}/xml`, { recursive: true });

    // Identify and extract target textures
    console.log('\nExtracting textures...');
    for (const obj of texture2DObjects) {
        const name = readObjectName(fd, dataOffset, obj);
        if (!targetTextureNames.has(name)) continue;

        console.log(`  Extracting Texture2D: ${name} (${obj.byteSize} bytes)`);
        const tex = extractTexture2D(fd, dataOffset, obj);
        console.log(`    Dimensions: ${tex.width}x${tex.height}, Format: ${tex.textureFormat}`);

        const pngData = rgba32ToPng(tex.imageData, tex.width, tex.height);
        const pngPath = `${atlasDir}/${name}.png`;
        await fsp.writeFile(pngPath, pngData);
        console.log(`    Saved: ${pngPath} (${pngData.length} bytes)`);
    }

    // Extract TextAssets
    console.log('\nExtracting text assets...');
    for (const obj of textAssetObjects) {
        const name = readObjectName(fd, dataOffset, obj);

        if (name === 'spritesheetf') {
            console.log(`  Extracting TextAsset: ${name} (${obj.byteSize} bytes)`);
            const ta = extractTextAsset(fd, dataOffset, obj);
            const bytesPath = `${atlasDir}/spritesheetf.bytes`;
            await fsp.writeFile(bytesPath, ta.data);
            console.log(`    Saved: ${bytesPath}`);
        } else {
            // Check if it's an XML file (for manifest and other text assets)
            const ta = extractTextAsset(fd, dataOffset, obj);
            const content = ta.data.toString('ascii');
            if (content.startsWith('<?xml version=')) {
                const xmlPath = `${outputDir}/xml/${name}.xml`;
                await fsp.writeFile(xmlPath, ta.data);
                console.log(`  Saved XML: ${xmlPath}`);
            }
        }
    }

    fs.closeSync(fd);
    console.log('\nAsset extraction complete!');
}
