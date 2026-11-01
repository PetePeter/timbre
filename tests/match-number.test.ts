import { describe, expect, it } from 'vitest';
import { matchContactsByNumber } from '../src/contacts/match-number.js';

const abroad = { name: 'Abroad', numbers: ['+61491570006'] };
const local = { name: 'Local', numbers: ['+44409220113'] };

describe('matchContactsByNumber', () => {
  it('matches on the last 9 digits whatever the punctuation or prefix', () => {
    expect(matchContactsByNumber([abroad], '0491570006', '+44409220113')).toEqual([abroad]);
    expect(matchContactsByNumber([abroad], '(04) 9157-0006', null)).toEqual([abroad]);
  });

  it('needs all 9 digits to agree', () => {
    expect(matchContactsByNumber([abroad], '0509220113', null)).toEqual([]);
    expect(matchContactsByNumber([abroad], '220113', null)).toEqual([]);
  });

  it('prefers an exact normalized match over a suffix match', () => {
    expect(matchContactsByNumber([abroad, local], '0491570006', '+44409220113')).toEqual([local]);
  });
});
