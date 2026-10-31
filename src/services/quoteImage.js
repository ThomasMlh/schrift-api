/**
 * Quote picture of a character: the Japanese quote of the game, in the middle of a black canvas the size of
 * the artworks, with its translation at the bottom. The text is drawn as vector paths from a font shipped
 * with the API: the serverless functions have no system fonts.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import opentype from 'opentype.js';
import sharp from 'sharp';

const CANVAS = { width: 1260, height: 710 };
const QUOTE_BOX = { width: 1130, height: 340 };
const FONT_PATH = 'node_modules/@fontsource/lato/files/lato-latin-400-normal.woff';
const FONT_SIZE = 36;
const LINE_HEIGHT = 48;
const TEXT_WIDTH = 1100;
const BOTTOM_MARGIN = 56;
const QUOTE_GAP = 40;

let font;
const loadFont = () => {
  font ??= readFile(path.join(process.cwd(), FONT_PATH))
    .then((file) => opentype.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.length)));
  return font;
};

const textWidth = (loaded, text) => loaded.getAdvanceWidth(text, FONT_SIZE);

const wrapText = (loaded, text) => text.trim().split(/\s+/).reduce((lines, word) => {
  const candidate = lines.length > 0 ? `${lines.at(-1)} ${word}` : word;
  if (lines.length > 0 && textWidth(loaded, candidate) <= TEXT_WIDTH) return [...lines.slice(0, -1), candidate];
  return [...lines, word];
}, []);

// Path data written from the commands: the output of the font library stops the SVG renderer partway through
const pathData = (path) => path.commands.map(({ type, x, y, x1, y1, x2, y2 }) => {
  if (type === 'Z') return 'Z';
  const points = type === 'Q' ? [x1, y1, x, y] : type === 'C' ? [x1, y1, x2, y2, x, y] : [x, y];
  return `${type}${points.map((value) => value.toFixed(2)).join(' ')}`;
}).join('');

const textOverlay = async (lines) => {
  const loaded = await loadFont();
  const top = CANVAS.height - BOTTOM_MARGIN - lines.length * LINE_HEIGHT;
  const paths = lines.map((line, index) => {
    const x = (CANVAS.width - textWidth(loaded, line)) / 2;
    return pathData(loaded.getPath(line, x, top + (index + 0.8) * LINE_HEIGHT, FONT_SIZE));
  });
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}"><path fill="#fff" d="${paths.join(' ')}"/></svg>`);
};

// Scaled down when too large, never enlarged: the game text keeps its sharpness
const fitQuote = async (quote) => {
  const trimmed = await sharp(quote).trim().png().toBuffer();
  const image = await sharp(trimmed)
    .resize({ ...QUOTE_BOX, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const { width, height } = await sharp(image).metadata();
  return { image, width, height };
};

export const renderQuoteImage = async (quote, text) => {
  const loaded = await loadFont();
  const lines = text ? wrapText(loaded, text) : [];
  const fitted = await fitQuote(quote);
  // A long translation pushes the quote up rather than running into it
  const textTop = CANVAS.height - BOTTOM_MARGIN - lines.length * LINE_HEIGHT;
  const centred = Math.round((CANVAS.height - fitted.height) / 2);
  const top = lines.length > 0 ? Math.max(0, Math.min(centred, textTop - QUOTE_GAP - fitted.height)) : centred;
  const layers = [
    { input: fitted.image, top, left: Math.round((CANVAS.width - fitted.width) / 2) },
    ...(lines.length > 0 ? [{ input: await textOverlay(lines), top: 0, left: 0 }] : []),
  ];
  return sharp({ create: { ...CANVAS, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
};
