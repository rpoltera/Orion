const Database = require('better-sqlite3');
const db = new Database(process.env.APPDATA + '/Orion/orion.db');

// Show all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

// Show schema for item_details if it exists
const itemDetails = tables.find(t => t.name === 'item_details');
if (itemDetails) {
  const cols = db.prepare("PRAGMA table_info(item_details)").all();
  console.log('item_details columns:', cols.map(c => c.name));
  const sample = db.prepare("SELECT * FROM item_details LIMIT 1").get();
  console.log('Sample row keys:', sample ? Object.keys(sample) : 'empty table');
}
