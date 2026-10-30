import sharp from 'sharp';
import { attackImageLayout, attackImageSize, buttonBase, buttonIcon, renderAttackImage } from '../../src/services/attackImage.js';
import { imageUpdate } from '../../src/services/gameDb/characterDocuments.js';
import { GENERATED_ATTACK_IMAGE, rmfsImages } from '../../src/services/gameDb/source.js';

const step = (fields = {}) => ({ weapon: 1, color: null, statuses: [], heal: null, buff: null, revival: false, advanced: false, twice: false, ...fields });
const wek = { code: 'wek', plus: true };

// Renji, creator special version: a buff that heals on strong attack 2, a special that revives
const renji = {
  normal: { steps: [step({ statuses: [wek] })] },
  heavy1: { steps: [step({ statuses: [wek] })] },
  heavy2: { steps: [step({ heal: 20, buff: { target: 2 } })] },
  heavy3: { steps: [step({ statuses: [wek] })] },
  ex: { steps: [step({ weapon: 0, revival: true, statuses: [wek] })] },
};

describe('attack buttons picture', () => {
  it('uses the same button pieces as the character page', () => {
    expect(buttonBase('heavy2', renji.heavy2.steps)).toBe('bt_buff_heavy');
    expect(buttonIcon('heavy2', renji.heavy2.steps)).toBe('6_heavy4');
    expect(buttonIcon('ex', renji.ex.steps)).toBe('10_special1');
    expect(buttonBase('normal', [step({ color: 'B' })])).toBe('bt_projectile');
  });

  it('lays the buttons out like the game: the big one is the normal attack', () => {
    const pieces = attackImageLayout(renji);
    const base = (name) => pieces.find((p) => p.name === name);
    expect(base('bt_fighting')).toMatchObject({ x: 209.5, y: 201 });
    expect(base('bt_skill')).toMatchObject({ x: 239, y: 66 });
    // Status badges on every button but the buff, the drop badge on the buff that heals
    expect(pieces.filter((p) => p.name === 'ailment_wek')).toHaveLength(4);
    expect(pieces.filter((p) => p.name === 'sub_5')).toHaveLength(1);
    expect(attackImageSize(renji)).toEqual({ width: 294, height: 286 });
  });

  it('moves the buttons right to make room for an EX move', () => {
    const withExMove = { ...renji, extra_action: { steps: [step({ color: 'B' })] } };
    const pieces = attackImageLayout(withExMove);
    expect(pieces.find((p) => p.name === 'bt_fighting')).toMatchObject({ x: 209.5 + 84 });
    expect(pieces.find((p) => p.name === 'ex_action_base01')).toMatchObject({ x: 41.5, y: 160.5 });
    expect(attackImageSize(withExMove)).toEqual({ width: 378, height: 286 });
  });

  it('puts a second status in a smaller disc on the top right, the last status of the attack in the main disc', () => {
    // Renji, creator special version in the game: burn in the main disc, lacerate on its top right
    const statuses = [{ code: 'inj', plus: false }, { code: 'brn', plus: false }];
    const pieces = attackImageLayout({ heavy1: { steps: [step({ statuses })] } });
    const names = pieces.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['ailment_base_heavy', 'ailment_brn', 'ailment_base_2', 'ailment_inj']));
    expect(names.filter((n) => n === 'ailment_base_heavy')).toHaveLength(1);
    // Drawn over the first disc, the frame with the dark corner stays the first one
    expect(names.indexOf('ailment_inj')).toBeGreaterThan(names.indexOf('ailment_brn'));
    const main = pieces.find((p) => p.name === 'ailment_brn');
    const next = pieces.find((p) => p.name === 'ailment_inj');
    expect([next.x - main.x, next.y - main.y]).toEqual([19, -15]);
    expect(next.scale).toBeLessThan(main.scale);
  });

  it('renders a transparent PNG of the game screen size, without the pieces it cannot load', async () => {
    const square = await sharp({ create: { width: 99, height: 99, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
    const loadPiece = async (name) => {
      if (name === 'sub_5') throw new Error('missing');
      return square;
    };
    const image = await renderAttackImage(renji, loadPiece);
    expect(await sharp(image).metadata()).toMatchObject({ width: 294, height: 286, format: 'png', hasAlpha: true });
    expect(await renderAttackImage({}, loadPiece)).toBeNull();
  });

  it('is drawn once: queued when it came from elsewhere, not at every sync', () => {
    const game = { resource_2d_id: '1872', attacks: renji };
    expect(rmfsImages(game).attack).toBe(GENERATED_ATTACK_IMAGE);
    expect(rmfsImages({ attacks: renji })).toEqual({ attack: GENERATED_ATTACK_IMAGE });

    const sources = { ...rmfsImages(game) };
    const fromOtherSite = { source_images: { ...sources, attack: 'https://bucket.bbs-simulator.com/characters/x.png' }, images_revisions: { quote: 2 } };
    expect(imageUpdate(game, fromOtherSite).pending).toEqual(['attack']);
    expect(imageUpdate(game, { source_images: sources, images_revisions: { quote: 2, attack: 2 } })).toBeNull();
  });
});
