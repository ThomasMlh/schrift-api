import { addAltAccount, updateAccount, upsertPrimaryAccount } from '../../src/utils/bbsAccounts.js';

describe('guild_joined_at', () => {
  const known = new Date(2025, 0, 1);
  const accounts = [{ bbs_id: 'a', guilde_id: 'g1', guild_joined_at: known, is_primary: true }];

  it('keeps the date while the guild does not change', () => {
    expect(updateAccount(accounts, 'a', { guildeId: 'g1', role: 'membre' })[0].guild_joined_at).toBe(known);
    expect(upsertPrimaryAccount(accounts, { bbsName: 'A' })[0].guild_joined_at).toBe(known);
  });

  it('resets the date on a guild change and clears it when leaving', () => {
    const moved = updateAccount(accounts, 'a', { guildeId: 'g2' })[0];
    expect(moved.guild_joined_at).toBeInstanceOf(Date);
    expect(moved.guild_joined_at).not.toBe(known);
    expect(updateAccount(accounts, 'a', { guildeId: null })[0].guild_joined_at).toBeNull();
  });

  it('restores a given date, unknown (null) included', () => {
    const left = updateAccount(accounts, 'a', { guildeId: null });
    expect(updateAccount(left, 'a', { guildeId: 'g1', guildJoinedAt: known })[0].guild_joined_at).toBe(known);
    expect(updateAccount(left, 'a', { guildeId: 'g1', guildJoinedAt: null })[0].guild_joined_at).toBeNull();
    expect(addAltAccount([], { bbsId: 'b', guildeId: 'g1', guildJoinedAt: known })[0].guild_joined_at).toBe(known);
  });
});
