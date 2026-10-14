#!/usr/bin/env node
// Release title and notes for a version (used by .github/workflows/build.yml):
//   node scripts/release-notes.mjs 0.3.1   writes notes.md and prints the title
// The title is "SniperValley 0.3.1", plus the name after the version in CHANGELOG.md's heading
// ("## 0.3.1 – First game experience fixes"); that section is listed in the notes.
import fs from 'node:fs';

const version = process.argv[2];
if (!version) { console.error('usage: node scripts/release-notes.mjs <version>'); process.exit(1); }

let title = `SniperValley ${version}`;
let changes = '';
try {
  const lines = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (i >= 0) {
    const name = lines[i].slice(3 + version.length).replace(/^\s*[–—-]\s*/, '').trim();
    if (name) title += ` – ${name}`;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('## ')) j++;
    changes = lines.slice(i + 1, j).join('\n').trim();
  }
} catch { /* no changelog: the notes without a list of changes */ }

const notes = [
  '**Windows:** download `SniperValley-windows-x64.zip` below, unzip it and start `SniperValley.exe`.',
  '',
  'The program is not code-signed. To start it without a warning: right-click the zip, choose **Properties**, tick **Unblock** and click **OK** before you unzip it. Otherwise Windows shows *Windows protected your PC* the first time: click **More info**, then **Run anyway**.',
  '',
  'LAN games: one player clicks HOST GAME, the others type the IP address it shows and click JOIN GAME.',
];
if (changes) notes.push('', "## What's new", '', changes);
fs.writeFileSync('notes.md', `${notes.join('\n')}\n`);
console.log(title);
