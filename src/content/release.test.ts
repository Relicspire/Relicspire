import { describe, expect, it } from 'vitest';
import input from './release.json';
import { createCampaignMetadata, parseGameRelease } from '../game/data/release';

describe('第1階層の正式カタログ', () => {
  it('正式データが検証を通り、全48ノードと全編の進行・報酬を保持する', () => {
    const release = parseGameRelease(input);
    expect(release.campaign).toEqual(createCampaignMetadata());
    expect(
      release.content.jobs.flatMap((j) => [...j.routes.a, ...j.routes.b]),
    ).toHaveLength(48);
    expect(release.content.skills).toHaveLength(61);
    expect(release.content.enemies).toHaveLength(6);
    expect(release.content.equipment).toHaveLength(11);
    expect(release.scope.playableFloorIds).toEqual(['floor-01']);
  });
});
