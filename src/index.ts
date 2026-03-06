import { promises as fsPromises } from 'fs';
import * as fs from 'fs';
import { Canvas, createCanvas, Image, loadImage } from "canvas";
import { parse } from "fast-xml-parser";
import { argv } from 'process';
import * as flatbuffers from 'flatbuffers';
import { Deca } from './schema';
import { extractAssets } from './unity-asset-parser';
import { runRenderer } from './renderer';
import { dir } from 'console';

const args = argv.slice(2);

const sheets = new Map<string, SpriteAtlas>();
const atlases: UnityAtlas[] = []
const seenPlayerskins32 = new Set<string>();

const cli_params = {
	"resources": undefined,
	"dest": undefined
}

let configURL = "./config.json"
let defaultConfig = "./default_config.json"

let defaultParams = JSON.parse(fs.readFileSync(defaultConfig, "utf-8"))
Object.keys(cli_params).forEach(function(key) {
    if ( cli_params[key] === undefined ) cli_params[key] = defaultParams[key];
});

const atlasMapper = {
    1: "groundTiles",
    2: "characters",
    4: "mapObjects",
}

type SpriteData = {
    aId: number,
    index: number,
    position: {
        x: number,
        y: number,
        w: number,
        h: number
    },
    maskPosition: {
        x: number,
        y: number,
        w: number,
        h: number
    },
    spriteSheetName?: string;
    direction?: number,
    action?: number,
    isT: boolean,
    set?: number
    padding?: number,
}

type AnimatedSprite = {
    index: number,
    spriteSheetName: string;
    direction: number,
    action: number,
    set: number,
    spriteData: SpriteData
}

let jsonData = fs.readFileSync(configURL, "utf-8")
Object.keys(cli_params).forEach(function(key) {
	const regex = new RegExp(`\\[\\[${key}\\]\\]`, "g");
	jsonData = jsonData.replace(regex, cli_params[key]);
})
console.log("config", jsonData)
const config = JSON.parse(jsonData);

async function main() {

    if (config.decompile) {
        await extractAssets(
            config.decompiler.input,
            config.decompiler.output,
            config.input
        );
    }


    const manifest = await loadManifest(config.manifestLocation);
    await loadUnityAtlases(config.input);
    let file = (await fsPromises.readFile(`${config.input}/spritesheetf.bytes`));
    let byteBuffer = new flatbuffers.ByteBuffer(file);
    let root = Deca.SpriteSheetRoot.getRootAsSpriteSheetRoot(byteBuffer);

    // array just for json creation
    let sprites: SpriteAtlasData[] = [];

    for (let i = 0; i < root.spritesLength(); i++) {
        let spriteSheet = root.sprites(i);
        let workingSprites : SpriteData[] = [];

        for (let j = 0; j < spriteSheet.spritesLength(); j++) {
            let sprite = spriteSheet.sprites(j);

            let spriteData: SpriteData = {
              //padding: sprite.padding(),
              index: sprite.index(),
              aId: Number(sprite.aId()),
              isT: sprite.isT(),
              padding: sprite.padding(),
              spriteSheetName: spriteSheet.name(),
              position: {
                  x:sprite.position().x(),
                  y:sprite.position().y(),
                  w:sprite.position().w(),
                  h:sprite.position().h(),
              },
              maskPosition: {
                  x:sprite.maskPosition().x(),
                  y:sprite.maskPosition().y(),
                  w:sprite.maskPosition().w(),
                  h:sprite.maskPosition().h(),
              },/*
              mostCommonColor: {
                r:sprite.mostCommonColor().r(),
                g:sprite.mostCommonColor().g(),
                b:sprite.mostCommonColor().b(),
                a:sprite.mostCommonColor().a(),
              }*/
            }

            workingSprites.push(spriteData);
        }

        let atlasData : SpriteAtlasData = {
            spriteSheetName: spriteSheet.name(),
            atlasId: Number(spriteSheet.atlasId()),
            elements: workingSprites,
        }

        setSpriteAtlas(atlasData ,manifest);
        sprites.push(atlasData);
    }

    let spritesAnimated: AnimatedSprite[] = [];

    for (let i = 0; i < root.animatedSpritesLength(); i++) {
        let animatedSprite = root.animatedSprites(i);
        let sprite = animatedSprite.sprite();

        let animatedSpriteData: AnimatedSprite = {
            spriteSheetName: animatedSprite.name(),
            index: animatedSprite.index(),
            direction: animatedSprite.direction(),
            action: animatedSprite.action(),
            set: animatedSprite.set(),
            spriteData: {
                spriteSheetName: sprite.spriteSheetName(),
                index: sprite.index(),
                padding: sprite.padding(),
                isT: sprite.isT(),
                aId: Number(sprite.aId()),
                direction: animatedSprite.direction(),
                action: animatedSprite.action(),
                position: {
                    x:sprite.position().x(),
                    y:sprite.position().y(),
                    w:sprite.position().w(),
                    h:sprite.position().h(),
                },
                maskPosition: {
                    x:sprite.maskPosition().x(),
                    y:sprite.maskPosition().y(),
                    w:sprite.maskPosition().w(),
                    h:sprite.maskPosition().h(),
                }
            }
        }

        spritesAnimated.push(animatedSpriteData);
        setAnimated({...animatedSpriteData.spriteData, ...animatedSpriteData}, manifest);
    }

    // save spritesheet as .json (needed?)
    let temp = {
        "sprites": sprites,
        "animatedSprites": spritesAnimated
    }
    const promises = [];

    const jsonSpriteSheet = JSON.stringify(temp,null,2);
    const spriteSheetExportPath = './spritesheet.json';
    fsPromises.writeFile(spriteSheetExportPath, jsonSpriteSheet)
        .then(() => {
                console.log(`JSON data has been saved`);
            })
            .catch((error) => {
                console.error(`Error saving JSON data: ${error}`);
            });


    try {
        await fsPromises.mkdir(`${config.output}`);
    } catch {}

    sheets.forEach((sheet, key) => {
        promises.push(sheet.save(config.output, key, manifest[key]));
        if (config.copy[key]) {
            for (let copy of config.copy[key]) {
                promises.push(sheet.save(config.output, copy, manifest[key]));
            }
        }
    })

    await Promise.all(promises);

    // Run the renderer (replaces the Python renderer/render.py)
    if (config.render) {
        console.log('\n=== Running Renderer ===');
        await runRenderer({
            source: config.render.source,
            dest: config.render.dest,
            gameVersion: config.render.gameVersion,
            buildHash: config.render.buildHash,
        });
        console.log('=== Renderer Done ===\n');
    }
}



async function loadUnityAtlases(dir) {
    for (const entry of Object.entries(atlasMapper)) {
        atlases[entry[0]] = await UnityAtlas.create(`${dir}/${entry[1]}`)
    }
}

async function loadManifest(dir) {
    const manifestXML = parse(await fsPromises.readFile(dir, "utf-8"), {
        ignoreAttributes: false,
    });
    const manifest = {};
    for (let set of [...<any[]>Object.values(manifestXML.Manifest.Importer.AnimatedImageSets)[0], ...<any[]>Object.values(manifestXML.Manifest.Importer.ImageSets)[0]]) {
        manifest[set["@_name"]] = {
            frameWidth: +set["@_frameWidth"],
            frameHeight: +set["@_frameHeight"],
            mask: set["@_mask"] != null
        }
    }
    return manifest;
}

function setSpriteAtlas(data: SpriteAtlasData, manifest) {
    let frameWidth = 8, frameHeight = 8;
    if (manifest[data.spriteSheetName]) {
        ({ frameWidth, frameHeight } = manifest[data.spriteSheetName]);
    }

    const atlas = new SpriteAtlas(frameWidth, frameHeight, data);
    for (const sprite of atlas.data.elements) {
        set(sprite, atlas);
    }
    sheets.set(atlas.data.spriteSheetName, atlas);
}

function set(sprite: SpriteData, sheet: SpriteAtlas) {
    sheet.set(sprite);
}

function setAnimated(sprite: SpriteData, manifest) {
    const { spriteSheetName } = sprite;
    let frameWidth = 8, frameHeight = 8;
    if (manifest[spriteSheetName]) {
        ({ frameWidth, frameHeight } = manifest[spriteSheetName]);
    }
    if (/(16x16)/g.test(sprite.spriteSheetName)) {
        frameWidth = frameHeight = 16;
    } else if (/(32x32)/g.test(sprite.spriteSheetName)) {
        frameWidth = frameHeight = 32;
    }

    if (spriteSheetName === 'playerskins32') {
        // Standing frames are 16×16; use same frame dimensions as playerskins16.
        frameWidth = 112;
        frameHeight = 32;
    }
    
    if (spriteSheetName === 'playerskins32' && !(sprite.direction === 0 && sprite.action === 0)) {
        return;
    }

    // For playerskins32 only keep the very first animation frame per skin index.
    if (spriteSheetName === 'playerskins32') {
        const key = `playerskins32+${sprite.index}`;
        if (seenPlayerskins32.has(key)) return;
        seenPlayerskins32.add(key);
    }

    if (!sheets.has(spriteSheetName)) {
        sheets.set(spriteSheetName, new AnimatedSpriteAtlas(sprite.position.w, sprite.position.h, frameWidth, frameHeight, null));
    }

    sheets.get(spriteSheetName).set(sprite);
}

class UnityAtlas {
    image: Image;
    maskImage: Image;
    constructor(imageURL) {}

    static async create(imageURL): Promise<UnityAtlas> {
        const atlas = new UnityAtlas(imageURL);
        atlas.image = await loadImage(imageURL + '.png');
        try {
            atlas.maskImage = await loadImage(imageURL + "_masks.png");
        } catch {

        }

        return atlas;
    }
}

type SpriteAtlasData = {
    spriteSheetName: string;
    atlasId: number;
    elements: SpriteData[]|SpriteData;
}


class SpriteAtlas {
    spriteWidth: number
    spriteHeight: number
    canvas: Canvas
    maskCanvas: Canvas;
    maskDrawnTo: boolean;
    data: SpriteAtlasData;

    constructor(spriteWidth, spriteHeight, data) {
        this.spriteWidth = spriteWidth;
        this.spriteHeight = spriteHeight;
        this.canvas = createCanvas(spriteWidth * 16, spriteHeight * 16);
        this.maskCanvas = createCanvas(this.canvas.width, this.canvas.height);
        this.maskDrawnTo = false;
        this.data = data;
    }

    expandCanvas(newHeight) {
        const newCanvas = createCanvas(this.canvas.width, newHeight);
        const newCanvasCtx = newCanvas.getContext("2d");

        newCanvasCtx.drawImage(this.canvas, 0, 0);
        this.canvas = newCanvas;

        const newMaskCanvas = createCanvas(newCanvas.width, newCanvas.height);
        const newMaskCanvasCtx = newMaskCanvas.getContext("2d");
        newMaskCanvasCtx.drawImage(this.maskCanvas, 0, 0);
        this.maskCanvas = newMaskCanvas;
    }

    set(sprite: SpriteData) {
        if (sprite.position == undefined || sprite.isT) return;
        let { x, y, w, h } = sprite.position;
        let { aId } = sprite;

        //hacky tile fix :(
        if (aId == 1) {
            w = 8;
            h = 8;
        }

        const sheetPos = {
            x: (sprite.index * w) % this.canvas.width,
            y: Math.floor(sprite.index / (this.canvas.width / w)) * h
        }

        if (sheetPos.y + h > this.canvas.height) {
            this.expandCanvas(sheetPos.y + (this.spriteHeight * 16));
        }

        const ctx = this.canvas.getContext("2d");
        ctx.drawImage(atlases[aId].image, x, y, w, h, sheetPos.x, sheetPos.y, w, h);

        if (sprite.maskPosition.w != 0) {
            const { x, y, w, h } = sprite.maskPosition;
            const maskCtx = this.maskCanvas.getContext("2d");
            maskCtx.drawImage(atlases[aId].maskImage, x, y, w, h, sheetPos.x, sheetPos.y, w, h);
            this.maskDrawnTo = true;
        }
    }

    async save(path, name, manifestEntry) {
        const canvasPromise = fsPromises.writeFile(`${path}/${name}.png`, this.canvas.toBuffer());
        if (this.maskDrawnTo) {
            return Promise.all([canvasPromise, fsPromises.writeFile(`${path}/${name}_mask.png`, this.maskCanvas.toBuffer())]);
        }
        return canvasPromise
    }
}

class AnimatedSpriteAtlas extends SpriteAtlas {
    animCounter: Map<string, number>
    frameWidth: number
    frameHeight: number

    playerSheet: boolean

    indexCount: any;

    constructor(spriteWidth, spriteHeight, frameWidth, frameHeight, data) {
        super(spriteWidth, spriteHeight, data);
        this.frameWidth = frameWidth;
        this.frameHeight = frameHeight;
        this.canvas = createCanvas(frameWidth, frameHeight * 16);
        this.maskCanvas = createCanvas(frameWidth, frameHeight * 16);
        this.playerSheet = spriteHeight != frameHeight;
        this.animCounter = new Map();
        this.indexCount = {};
    }

    set(sprite: SpriteData) {
        const spriteKey = `${sprite.spriteSheetName}+${sprite.index}+${sprite.direction}+${sprite.action}`
        let { action, direction } = sprite;
        let { x, y, w, h } = sprite.position;
        

        if (!this.animCounter.has(spriteKey)) {
            this.animCounter.set(spriteKey, 0);
        }

        const sheetPos = {
            x: (action == 2) ? this.spriteWidth * 4 : 0,
            y: sprite.index * this.frameHeight
        }

        sheetPos.x += (this.animCounter.get(spriteKey) * this.spriteWidth);

        if (sheetPos.y + h > this.canvas.height) {
            this.expandCanvas(this.canvas.height + (this.spriteHeight * 16));
        }

        const ctx = this.canvas.getContext("2d");
        ctx.drawImage(atlases[sprite.aId].image, x, y, w, h, sheetPos.x, sheetPos.y, w, h);

        if (sprite.maskPosition.w != 0) {
            const { x, y, w, h } = sprite.maskPosition;
            const maskCtx = this.maskCanvas.getContext("2d");
            maskCtx.drawImage(atlases[sprite.aId].maskImage, x, y, w, h, sheetPos.x, sheetPos.y, w, h);
            this.maskDrawnTo = true;
        }

        this.animCounter.set(spriteKey, this.animCounter.get(spriteKey) + 1);
    }
}

main();
