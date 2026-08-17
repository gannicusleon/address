import { describe, expect, it } from 'vitest';
import { CatalogReverseGeocoder } from '../server/sync/catalog-reverse-geocoder.mjs';

const regions = [
  { id: 1, code: 'GD', name: 'Guangdong', native_name: '广东省', zh_name: '广东省', type: 'province', latitude: 23.4, longitude: 113.5 },
  { id: 2, code: 'FJ', name: 'Fujian', native_name: '福建省', zh_name: '福建省', type: 'province', latitude: 26.1, longitude: 118.0 },
  { id: 3, code: 'SH', name: 'Shanghai', native_name: '上海市', zh_name: '上海市', type: 'municipality', latitude: 31.23, longitude: 121.47 }
];
const cities = [
  { name: 'Shenzhen', native_name: '深圳', zh_name: '深圳市', region_id: 1, type: 'prefecture', latitude: 22.54, longitude: 114.06 },
  { name: 'Xiamen', native_name: '厦门', zh_name: '厦门市', region_id: 2, type: 'prefecture', latitude: 24.48, longitude: 118.09 },
  { name: "Xiang'an", native_name: '翔安', zh_name: '翔安', region_id: 2, type: 'district', latitude: 24.67, longitude: 118.13 },
  { name: 'Huangpu', native_name: '黄埔', zh_name: '黄埔', region_id: 3, type: 'district', latitude: 31.23, longitude: 121.49 }
];

describe('catalog reverse geocoder', () => {
  it('fills the missing city and its region for a nearby point', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: '', locality: '', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.locality).toBe('深圳');
    expect(filled.localityEn).toBe('Shenzhen');
    expect(filled.localityZh).toBe('深圳市');
    expect(filled.admin1).toBe('广东省');
    expect(filled.admin1Code).toBe('GD');
  });

  it('fills only the region when the city already exists', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 24.5, longitude: 118.1, components: { admin1: '', locality: '思明区', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.locality).toBeUndefined();
    expect(filled.admin1).toBe('福建省');
  });

  it('returns nothing for points far outside the catalog radius', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const filled = geocoder.lookup({ latitude: 48.8, longitude: 2.35, components: { admin1: '', locality: '' } });
    expect(filled).toEqual({});
  });

  it('limits nearest-city distance checks to nearby spatial buckets', () => {
    let coordinateReads = 0;
    const entries = Array.from({ length: 5000 }, (_, index) => {
      const latitude = -80 + (index % 160);
      const longitude = -170 + (Math.floor(index / 160) % 340);
      return {
        name: `City ${index}`, native_name: `City ${index}`, zh_name: '', region_id: null, type: 'city',
        get latitude() { coordinateReads += 1; return latitude; },
        get longitude() { coordinateReads += 1; return longitude; }
      };
    });
    entries.push({ name: 'Nearby', native_name: 'Nearby', zh_name: '', region_id: null, type: 'city', latitude: 10.1, longitude: 20.1 });
    const geocoder = new CatalogReverseGeocoder('US', [], entries);
    coordinateReads = 0;

    expect(geocoder.nearestCity(10, 20)?.name).toBe('Nearby');
    expect(coordinateReads).toBeLessThan(200);
  });

  it('replaces a Latin-script city with the Chinese name for Chinese countries', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: 'Guangdong', locality: 'Shenzhen', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled.replaceCity).toBe(true);
    expect(filled.locality).toBe('深圳');
    expect(filled.replaceRegion).toBe(true);
    expect(filled.admin1).toBe('广东省');
  });

  it('keeps an existing Chinese city untouched', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const record = { latitude: 22.56, longitude: 113.9, components: { admin1: '广东省', locality: '深圳', postalLocality: '' } };
    const filled = geocoder.lookup(record);
    expect(filled).toEqual({});
  });

  it('drops HK/Macau catalog regions for the CN geocoder', () => {
    const withHk = [
      ...regions,
      { id: 9, code: 'HK', name: 'Hong Kong', native_name: '香港', zh_name: '香港', latitude: 22.3, longitude: 114.17 }
    ];
    const hkCity = [{ name: 'Central', native_name: '中環', zh_name: '中环', region_id: 9, latitude: 22.28, longitude: 114.16 }];
    const geocoder = new CatalogReverseGeocoder('CN', withHk, [...cities, ...hkCity]);
    // A point near Hong Kong must still resolve to a mainland region, never Hong Kong.
    const filled = geocoder.lookup({ latitude: 22.3, longitude: 114.16, components: { admin1: '', locality: '' } });
    expect(filled.admin1 || '').not.toMatch(/香港|Hong Kong/);
  });

  it('is inert with an empty catalog', () => {
    const geocoder = new CatalogReverseGeocoder('CN', [], []);
    expect(geocoder.available).toBe(false);
    expect(geocoder.lookup({ latitude: 22.5, longitude: 114, components: {} })).toEqual({});
  });

  it('resolves a postcode to its canonical region instead of trusting source admin1', () => {
    const malaysiaRegions = [
      { id: 10, code: '10', name: 'Selangor', native_name: 'Selangor', zh_name: '雪兰莪', latitude: 3.1, longitude: 101.5 },
      { id: 16, code: '16', name: 'Putrajaya', native_name: 'Putrajaya', zh_name: '布城', latitude: 2.93, longitude: 101.69 }
    ];
    const postcodes = [{
      code: '43000', locality_name: 'Kajang', city_name: 'Kajang', city_native: 'Kajang', city_zh: '',
      region_id: 10, latitude: 2.99, longitude: 101.79
    }];
    const geocoder = new CatalogReverseGeocoder('MY', malaysiaRegions, [], postcodes);

    expect(geocoder.resolvePostalRegion({
      latitude: 2.99, longitude: 101.79,
      components: { postcode: '43000', locality: 'Kajang', admin1: 'Putrajaya', admin1Code: '16' }
    })).toMatchObject({
      status: 'resolved', region: { code: '10', name: 'Selangor' },
      postalLocality: 'Kajang', postalLocalityEn: 'Kajang'
    });
    expect(geocoder.resolvePostalRegion({ components: { postcode: '99999', locality: 'Nowhere' } }))
      .toEqual({ status: 'postcode_not_in_catalog' });
  });

  it('uses locality to disambiguate a postcode shared by multiple regions', () => {
    const sharedRegions = [
      { id: 1, code: 'AA', name: 'Alpha', native_name: 'Alpha', zh_name: '', latitude: 1, longitude: 1 },
      { id: 2, code: 'BB', name: 'Beta', native_name: 'Beta', zh_name: '', latitude: 2, longitude: 2 }
    ];
    const postcodes = [
      { code: '12345', locality_name: 'Northville', city_name: 'Northville', region_id: 1, latitude: 1, longitude: 1 },
      { code: '12345', locality_name: 'Southville', city_name: 'Southville', region_id: 2, latitude: 2, longitude: 2 }
    ];
    const geocoder = new CatalogReverseGeocoder('US', sharedRegions, [], postcodes);

    expect(geocoder.resolvePostalRegion({ components: { postcode: '12345', locality: 'Southville' } }))
      .toMatchObject({ status: 'resolved', region: { code: 'BB' } });
    expect(geocoder.resolvePostalRegion({ components: { postcode: '12345', locality: 'Unknown' } }))
      .toEqual({ status: 'ambiguous_postal_region' });
  });

  it('uses canonical postal prefixes for US ZIP+4 and Canadian FSA data', () => {
    const northAmerica = [
      { id: 1, code: 'NY', name: 'New York', native_name: 'New York', zh_name: '', latitude: 43, longitude: -75 },
      { id: 2, code: 'ON', name: 'Ontario', native_name: 'Ontario', zh_name: '', latitude: 50, longitude: -85 }
    ];
    const us = new CatalogReverseGeocoder('US', [northAmerica[0]], [], [
      { code: '11217', locality_name: 'Brooklyn', region_id: 1, latitude: 40.68, longitude: -73.98 }
    ]);
    const ca = new CatalogReverseGeocoder('CA', [northAmerica[1]], [], [
      { code: 'M5V', locality_name: 'Toronto', region_id: 2, latitude: 43.64, longitude: -79.39 }
    ]);

    expect(us.resolvePostalRegion({ components: { postcode: '11217-1234' } }))
      .toMatchObject({ status: 'resolved', region: { code: 'NY' } });
    expect(ca.resolvePostalRegion({ components: { postcode: 'M5V 3A8' } }))
      .toMatchObject({ status: 'resolved', region: { code: 'ON' } });
  });

  it('resolves USPS territory prefixes missing from the location catalog', () => {
    const geocoder = new CatalogReverseGeocoder('US', [
      { id: 1, code: 'NY', name: 'New York', native_name: 'New York', latitude: 43, longitude: -75 }
    ], [], [{ code: '11217', region_id: 1, latitude: 40.68, longitude: -73.98 }]);

    expect(geocoder.resolvePostalRegion({ components: { postcode: '00601' } }))
      .toMatchObject({ status: 'resolved', region: { code: 'PR', name: 'Puerto Rico' } });
    expect(geocoder.resolvePostalRegion({ components: { postcode: '00802-1234' } }))
      .toMatchObject({ status: 'resolved', region: { code: 'VI', name: 'U.S. Virgin Islands' } });
  });

  it('rejects an Indian postcode whose coordinate is implausibly far away', () => {
    const indiaRegions = [
      { id: 1, code: 'MH', name: 'Maharashtra', native_name: 'महाराष्ट्र', latitude: 19.75, longitude: 75.71 }
    ];
    const geocoder = new CatalogReverseGeocoder('IN', indiaRegions, [], [
      { code: '400001', locality_name: 'Mumbai', region_id: 1, latitude: 18.94, longitude: 72.84 }
    ]);

    expect(geocoder.resolvePostalRegion({
      latitude: 30.667, longitude: 76.76, components: { postcode: '400001', locality: 'Mohali' }
    })).toEqual({ status: 'postcode_coordinate_mismatch' });
    expect(geocoder.resolvePostalRegion({
      latitude: 19.08, longitude: 72.88, components: { postcode: '400001', locality: 'Mumbai' }
    })).toMatchObject({ status: 'resolved', region: { code: 'MH' } });
  });
});

describe('coordinate-anchored hierarchy', () => {
  it('applies hierarchy filters only to nearby spatial candidates', () => {
    let nativeNameReads = 0;
    const districts = Array.from({ length: 5000 }, (_, index) => ({
      name: `District ${index}`,
      get native_name() { nativeNameReads += 1; return `District ${index}`; },
      zh_name: '', region_id: 1, type: 'district',
      latitude: -80 + (index % 160), longitude: -170 + (Math.floor(index / 160) % 340)
    }));
    const geocoder = new CatalogReverseGeocoder('CN', regions, [...cities, ...districts]);
    nativeNameReads = 0;

    expect(geocoder.resolveHierarchy(22.54, 114.06, { sourceAdmin1: '广东省' })?.city).toBe('深圳');
    expect(nativeNameReads).toBeLessThan(200);
  });

  it('anchors a district-level point to its prefecture city, not the district', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    // Point in Xiang'an district must resolve city=厦门 (prefecture), district=翔安.
    const anchored = geocoder.resolveHierarchy(24.67, 118.13, { sourceAdmin1: '福建省' });
    expect(anchored.admin1).toBe('福建省');
    expect(anchored.city).toBe('厦门');
    expect(anchored.district).toBe('翔安');
  });

  it('treats a municipality as its own city', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const anchored = geocoder.resolveHierarchy(31.23, 121.48, { sourceAdmin1: '上海市' });
    expect(anchored.admin1).toBe('上海市');
    expect(anchored.city).toBe('上海市');
    expect(anchored.district).toBe('黄埔');
  });

  it('trusts a valid source province over a distant coordinate centroid', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    const anchored = geocoder.resolveHierarchy(24.48, 118.09, { sourceAdmin1: 'Fujian' });
    expect(anchored.admin1).toBe('福建省');
    expect(anchored.city).toBe('厦门');
  });

  it('drops a cross-border point with no city-tier anchor', () => {
    const geocoder = new CatalogReverseGeocoder('CN', regions, cities);
    expect(geocoder.resolveHierarchy(55.75, 37.61, { sourceAdmin1: '' })).toBeNull();
  });
});
