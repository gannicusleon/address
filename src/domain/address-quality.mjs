import { isValidPostcode } from './postcode-patterns.mjs';

const policies = {
  US: { admin1: true, locality: true, postcode: true },
  CA: { admin1: true, locality: true, postcode: true },
  MX: { admin1: true, locality: true, district: true, postcode: true },
  GB: { locality: true, postcode: true },
  DE: { locality: true, postcode: true },
  FR: { locality: true, postcode: true },
  IT: { admin1: true, locality: true, postcode: true },
  ES: { admin1: true, locality: true, postcode: true },
  NL: { locality: true, postcode: true },
  JP: { admin1: true, locality: true, district: true, postcode: true },
  CN: { admin1: true, locality: true, district: true, postcode: false },
  HK: { locality: true, postcode: false },
  TW: { admin1: true, locality: true, postcode: true },
  KR: { admin1: true, locality: true, district: true, postcode: true },
  SG: { postcode: true },
  MY: { admin1: true, locality: true, postcode: true },
  TH: { admin1: true, locality: true, district: true, postcode: true },
  PH: { admin1: true, locality: true, postcode: true },
  VN: { admin1: true, locality: true, postcode: true },
  TR: { admin1: true, locality: true, district: true, postcode: true },
  SA: { locality: true, district: true, postcode: true },
  IN: { admin1: true, locality: true, postcode: true },
  AU: { admin1: true, locality: true, postcode: true },
  BR: { admin1: true, locality: true, district: true, postcode: true },
  NG: { admin1: true, locality: true, district: true, postcode: true },
  ZA: { admin1: true, locality: true, district: true, postcode: true },
  RU: { admin1: true, locality: true, postcode: true }
};

const clean = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const compact = (value) => clean(value).replace(/\s+/gu, '').toUpperCase();
const letters = /\p{L}/u;
const han = /\p{Script=Han}/u;
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const countryBounds = {
  US: [[-180, 17, -64, 72]], JP: [[122, 20, 154, 46]], DE: [[5, 47, 16, 56]],
  TW: [[119, 21, 123, 26]],
  FR: [
    [-6, 41, 10, 52], [-62, 15.7, -60.9, 16.6], [-54.7, 2, -51.5, 5.9],
    [-61.3, 14.3, -60.7, 14.9], [44.9, -13.1, 45.4, -12.5], [55.1, -21.5, 55.9, -20.8]
  ]
};

const same = (left, right) => Boolean(clean(left)) && compact(left) === compact(right);
const addDuplicateReasons = (country, components, reasons) => {
  const locality = localityValue(components);
  const district = districtValue(components);
  const koreanLandLot = country === 'KR' && same(components.street, district)
    && /(?:동|읍|면|리)$/u.test(clean(components.street));
  if (['JP', 'TW'].includes(country) && same(components.admin1, locality)) {
    reasons.push('duplicate_admin1_locality');
  }
  if (district && same(locality, district)) reasons.push('duplicate_locality_district');
  if (same(components.street, locality) || (!koreanLandLot && same(components.street, district))
    || same(components.street, components.admin1)) {
    reasons.push('street_matches_administration');
  }
};

const addCountryReasons = (country, components, reasons) => {
  const admin1 = clean(components.admin1);
  const locality = localityValue(components);
  const district = districtValue(components);
  const street = clean(components.street);
  if (country === 'US' && !/^(?:[A-Z]{2}|[\p{L} .'-]+)$/u.test(clean(components.admin1Code || admin1))) {
    reasons.push('invalid_us_admin1');
  }
  if (country === 'JP') {
    if (!japanese.test(`${admin1}${locality}${district}${street}`)) reasons.push('invalid_japanese_script');
    if (admin1 && !/[都道府県]$/u.test(admin1)) reasons.push('invalid_japanese_prefecture');
    if (locality && !/[市区町村郡]$/u.test(locality)) reasons.push('invalid_japanese_locality');
  }
  if (country === 'TW') {
    if (!han.test(`${admin1}${locality}${street}`)) reasons.push('invalid_taiwan_script');
    if (admin1 && !/[縣市]$/u.test(admin1)) reasons.push('invalid_taiwan_admin1');
    if (locality && !/[區鄉鎮市]$/u.test(locality)) reasons.push('invalid_taiwan_locality');
  }
  if (['DE', 'FR'].includes(country) && (!letters.test(street) || /^\d+$/u.test(street))) {
    reasons.push('invalid_street_name');
  }
};

const addCoordinateReasons = (country, latitude, longitude, reasons) => {
  if (latitude === undefined && longitude === undefined) return;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    reasons.push('invalid_coordinates');
    return;
  }
  const bounds = countryBounds[country];
  if (bounds && !bounds.some(([minimumLongitude, minimumLatitude, maximumLongitude, maximumLatitude]) =>
    lon >= minimumLongitude && lat >= minimumLatitude && lon <= maximumLongitude && lat <= maximumLatitude)) {
    reasons.push('coordinates_outside_country');
  }
};

export const normalizePostcode = (countryCode, value) => {
  const country = clean(countryCode).toUpperCase();
  const source = clean(value).toUpperCase();
  if (!source) return '';
  const packed = compact(source);
  if (country === 'CA' && /^[A-Z]\d[A-Z]\d[A-Z]\d$/u.test(packed)) return `${packed.slice(0, 3)} ${packed.slice(3)}`;
  if (country === 'GB' && /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, -3)} ${packed.slice(-3)}`;
  if (country === 'NL' && /^\d{4}[A-Z]{2}$/u.test(packed)) return `${packed.slice(0, 4)} ${packed.slice(4)}`;
  if (country === 'JP' && /^\d{7}$/u.test(packed)) return `${packed.slice(0, 3)}-${packed.slice(3)}`;
  if (country === 'BR' && /^\d{8}$/u.test(packed)) return `${packed.slice(0, 5)}-${packed.slice(5)}`;
  if (country === 'IN' && /^\d{6}$/u.test(packed)) return packed;
  return source;
};

const localityValue = (components) => clean(components.locality || components.postalLocality);
const districtValue = (components) => clean(components.district || components.dependentLocality);

export const normalizeAddressFacts = (countryCode, input = {}) => {
  const components = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? clean(value) : value]));
  components.postcode = normalizePostcode(countryCode, components.postcode);
  const buildingName = clean(components.buildingName);
  const unit = clean(components.unit);
  if (/^\d+[\p{L}\p{N}./-]*$/u.test(buildingName)) {
    delete components.buildingName;
  } else if (/^(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|#|no\.?)$/iu.test(buildingName)) {
    delete components.buildingName;
  }
  if (/^(?:apt|apartment|unit|ste|suite|fl|floor|#|no\.?)$/iu.test(unit)) delete components.unit;
  return components;
};

export const validateAddressQuality = ({ countryCode, components, latitude, longitude } = {}) => {
  const country = clean(countryCode).toUpperCase();
  const policy = policies[country];
  const normalizedComponents = normalizeAddressFacts(country, components);
  const reasons = [];
  if (!policy) reasons.push('unsupported_country');
  if (!clean(normalizedComponents.houseNumber)) reasons.push('missing_house_number');
  if (!clean(normalizedComponents.street)) reasons.push('missing_street');
  if (policy?.admin1 && !clean(normalizedComponents.admin1 || normalizedComponents.admin1Code)) reasons.push('missing_admin1');
  if (policy?.locality && !localityValue(normalizedComponents)) reasons.push('missing_locality');
  if (policy?.district && !districtValue(normalizedComponents)) reasons.push('missing_district');
  const postcode = clean(normalizedComponents.postcode);
  if (policy?.postcode && !postcode) reasons.push('missing_postcode');
  else if (postcode && !isValidPostcode(country, postcode)) reasons.push('invalid_postcode');
  if (clean(normalizedComponents.buildingName) && /^\d+[\p{L}\p{N}./-]*$/u.test(clean(normalizedComponents.buildingName))) {
    reasons.push('numeric_building_name');
  }
  addDuplicateReasons(country, normalizedComponents, reasons);
  addCountryReasons(country, normalizedComponents, reasons);
  addCoordinateReasons(country, latitude, longitude, reasons);
  return { valid: reasons.length === 0, reasons, components: normalizedComponents };
};

export const addressQualitySqlClause = (prefix = '') => {
  const value = (field) => `trim(${prefix}${field}) <> ''`;
  const city = `(${value('locality')} OR (${value('postal_locality')} AND ${prefix}postal_locality <> ${prefix}street))`;
  const district = `(${value('district')})`;
  const region = `(${value('admin1')} OR ${value('admin1_code')})`;
  const groups = new Map();
  for (const [country, policy] of Object.entries(policies)) {
    const checks = [value('house_number'), value('street')];
    if (policy.admin1) checks.push(region);
    if (policy.locality) checks.push(city);
    if (policy.district) checks.push(district);
    if (policy.postcode) checks.push(value('postcode'));
    const expression = checks.join(' AND ');
    const countries = groups.get(expression) || [];
    countries.push(country);
    groups.set(expression, countries);
  }
  return `(${[...groups].map(([expression, countries]) => `(${prefix}country_code IN (${countries.map((country) => `'${country}'`).join(',')}) AND ${expression})`).join(' OR ')})`;
};

export const countryAddressPolicies = policies;
