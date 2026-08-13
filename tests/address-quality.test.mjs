import { describe, expect, it } from 'vitest';
import {
  addressQualitySqlClause,
  countryAddressPolicies,
  normalizeAddressFacts,
  normalizePostcode,
  validateAddressQuality
} from '../src/domain/address-quality.mjs';

const base = {
  houseNumber: '12', street: 'Main Street', locality: 'Example City', district: 'Central',
  admin1: 'Example State', postcode: '12345'
};
const validPostcodes = {
  US: '19103', CA: 'K1A 0B1', MX: '01000', GB: 'SW1A 1AA', DE: '10115', FR: '75001',
  IT: '00118', ES: '28001', NL: '1012 AB', JP: '100-0001', CN: '', HK: '', TW: '100',
  KR: '03001', SG: '018989', MY: '50000', TH: '10110', PH: '1000', VN: '10000',
  TR: '34000', SA: '12345', IN: '110001', AU: '2000', BR: '01001-000', NG: '100001',
  ZA: '8001', RU: '101000'
};

describe('country address quality gate', () => {
  it.each(Object.entries(countryAddressPolicies))('enforces every declared field for %s', (countryCode, policy) => {
    const native = {
      JP: { admin1: '東京都', locality: '新宿区', district: '西新宿', street: '西新宿二丁目' },
      TW: { admin1: '臺北市', locality: '中正區', district: '', street: '忠孝東路' }
    }[countryCode] || {};
    const components = { ...base, ...native, postcode: validPostcodes[countryCode] };
    expect(validateAddressQuality({ countryCode, components }).valid).toBe(true);
    const required = {
      admin1: ['admin1', 'missing_admin1'], locality: ['locality', 'missing_locality'],
      district: ['district', 'missing_district'], postcode: ['postcode', 'missing_postcode']
    };
    for (const [rule, [field, reason]] of Object.entries(required)) {
      if (!policy[rule]) continue;
      const missing = { ...components, [field]: '' };
      if (field === 'locality') missing.postalLocality = '';
      expect(validateAddressQuality({ countryCode, components: missing }).reasons).toContain(reason);
    }
  });

  it.each([
    ['DE', { ...base, admin1: '', district: '', postcode: '' }, 'missing_postcode'],
    ['IN', { ...base, postcode: '' }, 'missing_postcode'],
    ['US', { ...base, postcode: '' }, 'missing_postcode'],
    ['DE', { ...base, admin1: '', district: '', postcode: 'ABCDE' }, 'invalid_postcode'],
    ['IN', { ...base, postcode: '012345' }, 'invalid_postcode'],
    ['US', { ...base, postcode: '1234' }, 'invalid_postcode']
  ])('rejects incomplete or malformed %s records', (countryCode, components, reason) => {
    expect(validateAddressQuality({ countryCode, components })).toMatchObject({ valid: false, reasons: expect.arrayContaining([reason]) });
  });

  it('accepts complete German, Indian and US records', () => {
    expect(validateAddressQuality({ countryCode: 'DE', components: { ...base, admin1: '', district: '', postcode: '10115' } }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'IN', components: { ...base, postcode: '110001' } }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'US', components: { ...base, district: '', postcode: '19103' } }).valid).toBe(true);
  });

  it('does not require unused district fields for India and the Philippines', () => {
    expect(validateAddressQuality({
      countryCode: 'IN', components: { ...base, district: '', postcode: '110001' }
    }).valid).toBe(true);
    expect(validateAddressQuality({
      countryCode: 'PH', components: { ...base, district: '', postcode: '1000' }
    }).valid).toBe(true);
  });

  it('accepts the current two-level Vietnam hierarchy without a legacy district', () => {
    expect(validateAddressQuality({
      countryCode: 'VN',
      components: {
        houseNumber: '10', street: 'Đường Lê Lợi', locality: 'Phường Bến Thành',
        district: '', admin1: 'Thành phố Hồ Chí Minh', postcode: '70000'
      }
    }).valid).toBe(true);
    expect(validateAddressQuality({
      countryCode: 'VN', components: { ...base, postcode: '100000' }
    }).reasons).toContain('invalid_postcode');
  });

  it('accepts a Korean land-lot address whose neighborhood is the address line', () => {
    const components = {
      houseNumber: '71', street: '내수동', buildingName: '경희궁의아침2단지',
      locality: '종로구', district: '내수동', admin1: '서울특별시', postcode: '03174'
    };
    expect(validateAddressQuality({
      countryCode: 'KR', components, latitude: 37.57435296, longitude: 126.97178982
    }).valid).toBe(true);
  });

  it('only performs deterministic postcode formatting', () => {
    expect(normalizePostcode('CA', 'k1a0b1')).toBe('K1A 0B1');
    expect(normalizePostcode('GB', 'sw1a1aa')).toBe('SW1A 1AA');
    expect(normalizePostcode('JP', '1000001')).toBe('100-0001');
    expect(normalizePostcode('BR', '01001000')).toBe('01001-000');
  });

  it('drops numeric building names without inventing source units', () => {
    expect(normalizeAddressFacts('US', { ...base, buildingName: '3' })).not.toHaveProperty('unit');
    expect(normalizeAddressFacts('US', { ...base, buildingName: '3' })).not.toHaveProperty('buildingName');
  });

  it.each([
    ['JP', { ...base, admin1: '東京都', locality: '東京都', district: '西新宿', street: '西新宿二丁目', postcode: '100-0001' }, 'duplicate_admin1_locality'],
    ['JP', { ...base, admin1: 'Tokyo', locality: 'Shinjuku', district: 'Nishi', postcode: '100-0001' }, 'invalid_japanese_script'],
    ['JP', { ...base, admin1: '東京都', locality: '新宿区', district: '西新宿', street: '西新宿二丁目', postcode: '100-0001' }, null],
    ['TW', { ...base, admin1: '臺北市', locality: '中正區', district: '', street: '忠孝東路', postcode: '100' }, null],
    ['TW', { ...base, admin1: '臺北', locality: '中正', district: '', street: '忠孝東路', postcode: '100' }, 'invalid_taiwan_admin1'],
    ['DE', { ...base, admin1: '', locality: 'Berlin', district: '', street: '123', postcode: '10115' }, 'invalid_street_name']
  ])('applies native hierarchy rules for %s', (countryCode, components, reason) => {
    const result = validateAddressQuality({ countryCode, components });
    if (reason) expect(result.reasons).toContain(reason);
    else expect(result.valid).toBe(true);
  });

  it('rejects priority-country coordinates outside the country envelope', () => {
    expect(validateAddressQuality({
      countryCode: 'FR', components: { ...base, locality: 'Paris', postcode: '75001' },
      latitude: 39.9, longitude: 116.4
    }).reasons).toContain('coordinates_outside_country');
  });

  it('accepts French overseas coordinates without opening a cross-ocean envelope', () => {
    const components = { ...base, locality: 'Saint-Denis', postcode: '97400', street: 'Rue de Paris' };
    expect(validateAddressQuality({ countryCode: 'FR', components, latitude: -20.88, longitude: 55.45 }).valid).toBe(true);
    expect(validateAddressQuality({ countryCode: 'FR', components, latitude: 20, longitude: -20 }).reasons)
      .toContain('coordinates_outside_country');
  });

  it('requires postcode columns in the SQL read gate', () => {
    const clause = addressQualitySqlClause('pool.');
    expect(clause).toMatch(/pool\.country_code IN \([^)]*'US'[^)]*\)/u);
    expect(clause).toContain("trim(pool.postcode) <> ''");
    expect(clause).toContain("pool.country_code IN ('CN')");
  });
});
