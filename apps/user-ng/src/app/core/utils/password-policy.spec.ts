import { meetsPasswordPolicy } from './password-policy';

describe('password policy AUTH-04', () => {
  it('rejects 7 characters and accepts the 8 character boundary', () => {
    expect(meetsPasswordPolicy('Abcde1!')).toBe(false);
    expect(meetsPasswordPolicy('Abcdefg1')).toBe(true);
  });

  it('requires upper, lower and a digit or special character', () => {
    expect(meetsPasswordPolicy('abcdefg1!')).toBe(false);
    expect(meetsPasswordPolicy('ABCDEFG1!')).toBe(false);
    expect(meetsPasswordPolicy('Abcdefgh')).toBe(false);
    expect(meetsPasswordPolicy('Abcdefg!')).toBe(true);
  });
});
