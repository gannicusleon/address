import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeSourceRecord } from '../server/sync/address-etl.mjs';
import { CatalogReverseGeocoder } from '../server/sync/catalog-reverse-geocoder.mjs';
import { PostgresAddressImporter } from '../server/sync/postgres-address-importer.mjs';
import { openTestDatabase } from './helpers/postgres-test-database.mjs';

const directories = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

const source = {
  id: 'fixture-my', adapter: 'overture', name: 'Fixture', homepageUrl: 'https://example.test',
  dataUrl: 'https://example.test/data', licenseCode: 'CC0-1.0', licenseName: 'CC0',
  licenseUrl: 'https://example.test/license', attributionText: 'Fixture',
  attributionUrl: 'https://example.test', termsUrl: 'https://example.test/terms',
  shareAlike: false, redistributionAllowed: true, updateCadence: 'monthly'
};

const createImporter = (database) => new PostgresAddressImporter({
  database,
  normalizeRecord: normalizeSourceRecord,
  hash: (value) => createHash('sha256').update(value).digest('hex'),
  reverseGeocoder: (countryCode) => CatalogReverseGeocoder.load(database, countryCode),
  localizeRecords: async (records) => records.map((record) => ({
    ...record,
    localizations: Object.fromEntries(['native', 'en', 'zh-CN'].map((language) => [language, {
      components: record.components, formattedAddress: record.formattedAddress, source: 'fixture'
    }]))
  }))
});

const seedMalaysiaCatalog = async (database) => {
  await database.prepare(`INSERT INTO catalog_regions(
    id,country_code,code,name,native_name,zh_name,type,path,latitude,longitude
  ) VALUES (10,'MY','10','Selangor','Selangor','雪兰莪','state','Selangor',3.1,101.5),
    (16,'MY','16','Putrajaya','Putrajaya','布城','territory','Putrajaya',2.93,101.69)`).run();
  await database.prepare(`INSERT INTO catalog_cities(
    id,country_code,region_id,name,native_name,zh_name,type,population,latitude,longitude
  ) VALUES (100,'MY',10,'Kajang','Kajang','加影','city',300000,2.99,101.79)`).run();
  await database.prepare(`INSERT INTO catalog_postcodes(
    id,country_code,region_id,city_id,code,locality_name,latitude,longitude
  ) VALUES (1000,'MY',10,100,'43000','Kajang',2.99,101.79)`).run();
};

const row = (id, postcode) => ({
  id, country: 'MY', admin1: 'Putrajaya', locality: 'Kajang', postal_city: 'Kajang',
  address_levels: ['Putrajaya', 'Kajang'], postcode, street: 'Jalan Reko', number: id,
  longitude: 101.79, latitude: 2.99, property_type: 'residential',
  residential_building_id: `building-${id}`, residential_building_class: 'house'
});

describe('postal hierarchy reconciliation', () => {
  it('corrects a valid but wrong state and quarantines an unverified postcode', async () => {
    const database = openTestDatabase(':memory:');
    await seedMalaysiaCatalog(database);
    const directory = resolve('.data-cache', 'postal-hierarchy-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture.jsonl');
    await writeFile(file, `${[row('1', '43000'), row('2', '99999')].map(JSON.stringify).join('\n')}\n`, 'utf8');

    const result = await createImporter(database).importShard({
      shard: { id: 'fixture-my', countryCode: 'MY', source },
      discovery: { version: 'v1', dataUrl: source.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'a'.repeat(64) },
      maxRecords: 10, perLocality: 10
    });

    expect(result).toMatchObject({
      acceptedCount: 1,
      rejectedCount: 1,
      rejectionReasons: { postcode_not_in_catalog: 1 },
      metrics: expect.objectContaining({ postalCorrections: 1 })
    });
    expect(await database.prepare(`SELECT admin1,admin1_code,postcode FROM address_pool_runtime`).first())
      .toMatchObject({ admin1: 'Selangor', admin1_code: '10', postcode: '43000' });
    database.close();
  });

  it('uses the canonical US state name when catalog native_name is corrupt', async () => {
    const database = openTestDatabase(':memory:');
    await database.prepare(`INSERT INTO catalog_regions(
      id,country_code,code,name,native_name,zh_name,type,path,latitude,longitude
    ) VALUES (20,'US','AK','Alaska','Down','','state','Alaska',64.2,-152.3)`).run();
    await database.prepare(`INSERT INTO catalog_postcodes(
      id,country_code,region_id,city_id,code,locality_name,latitude,longitude
    ) VALUES (2000,'US',20,NULL,'99501','Anchorage',61.22,-149.9)`).run();
    const directory = resolve('.data-cache', 'postal-hierarchy-tests', randomUUID());
    directories.push(directory);
    await mkdir(directory, { recursive: true });
    const file = resolve(directory, 'fixture-us.jsonl');
    await writeFile(file, `${JSON.stringify({
      id: 'ak-1', country: 'US', admin1: 'Down', locality: 'Anchorage', postal_city: 'Anchorage',
      address_levels: ['Down', 'Anchorage'], postcode: '99501', street: 'E 5th Ave', number: '100',
      longitude: -149.9, latitude: 61.22, property_type: 'residential',
      residential_building_id: 'building-ak-1', residential_building_class: 'house'
    })}\n`, 'utf8');
    const usSource = { ...source, id: 'fixture-us' };

    const result = await createImporter(database).importShard({
      shard: { id: 'fixture-us', countryCode: 'US', source: usSource },
      discovery: { version: 'v1', dataUrl: usSource.dataUrl },
      materialized: { file, format: 'overture-jsonl', checksum: 'b'.repeat(64) },
      maxRecords: 10, perLocality: 10
    });

    expect(result.acceptedCount).toBe(1);
    expect(await database.prepare(`SELECT admin1,admin1_code,postcode FROM address_pool_runtime`).first())
      .toMatchObject({ admin1: 'Alaska', admin1_code: 'AK', postcode: '99501' });
    database.close();
  });
});
