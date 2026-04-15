const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '/Orion/orion.db');
const rows = db.prepare("SELECT COUNT(*) as cnt FROM item_details WHERE value LIKE '%watchProviders%'").get();
console.log('Items with watchProviders in SQLite:', rows.cnt);
const sample = db.prepare("SELECT id, value FROM item_details WHERE value LIKE '%watchProviders%' LIMIT 1").get();
if (sample) {
  const parsed = JSON.parse(sample.value);
  console.log('Sample watchProviders:', parsed.watchProviders);
} else {
  console.log('No watchProviders data found in SQLite at all.');
}
const total = db.prepare("SELECT COUNT(*) as cnt FROM item_details").get();
console.log('Total rows in item_details:', total.cnt);
