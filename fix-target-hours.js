const fs = require('fs');

const filePath = './testdata.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

let totalModified = 0;

for (const user of data.users) {
  for (const entry of user.entries) {
    const diff = 8 - entry.target_hours;
    if (diff !== 0) {
      entry.actual_hours = Math.round((entry.actual_hours + diff) * 100) / 100;
      if (entry.end_hour !== null) {
        entry.end_hour = Math.round((entry.end_hour + diff) * 100) / 100;
      }
      entry.target_hours = 8;
      totalModified++;
    }
  }
}

fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
console.log(`Fertig. ${totalModified} Einträge wurden angepasst.`);
