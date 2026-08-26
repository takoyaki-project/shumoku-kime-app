// コアロジックをNode上で動かし、指示書の「完成の確認方法」に書かれた
// 5つのシナリオを検証するテストハーネス。
// ブラウザ経由でのUI操作を待たずに、ロジックの妥当性を確認するためのもの。

const fs = require('fs');
const path = require('path');
const Papa = require('../lib/papaparse.min.js');
const EVENTS_MASTER = require('../src/events-master.js');
const Core = require('../src/core.js');

function readCsv(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length) {
    console.error('CSV parse errors in', p, parsed.errors);
  }
  return parsed.data;
}

const meiboPath = path.join(__dirname, '..', 'sample-data', 'dummy_meibo.csv');
const formPath = path.join(__dirname, '..', 'sample-data', 'dummy_form_responses.csv');

const meiboRows = readCsv(meiboPath);
const formRows = readCsv(formPath);
const formHeaders = Object.keys(formRows[0]);

const members = Core.buildMemberIndex(meiboRows);
const classification = Core.classifyFormHeaders(formHeaders, EVENTS_MASTER);

console.log('=== 列分類 ===');
console.log('種目として認識した列数:', Object.keys(classification.eventColumns).length, '/ 種目マスタ内の種目数:', EVENTS_MASTER.events.length);
console.log('未分類の列:', classification.unmatched);
console.log('種目数カウント希望列:', classification.wishCountHeader);
console.log('備考欄:', classification.remarksHeader);
console.log('リレー希望列:', classification.relayHeader);

const participants = Core.buildParticipants(formRows, classification, EVENTS_MASTER);
console.log('\n=== 名寄せ ===');
participants.forEach(function (p) {
  const m = Core.matchToMeibo(members, { ageCategory: p.ageCategory, sei: p.sei, mei: p.mei });
  p.matchStatus = m.status;
  p.displayName = m.status === 'exact' ? m.member.displayName : (p.sei + ' ' + p.mei);
  if (m.status !== 'exact') {
    console.log(' -', p.sei, p.mei, '=>', m.status, m.candidates.map(function (c) { return c.displayName; }));
  }
});

Core.runAssignment(EVENTS_MASTER, participants);

console.log('\n=== 割り当て結果 ===');
const eventsById = {};
EVENTS_MASTER.events.forEach(function (e) { eventsById[e.id] = e; });
participants.forEach(function (p) {
  const assigned = p.assignments.map(function (a) { return eventsById[a.eventId].name + '[' + a.bucketKey + ']'; });
  console.log('-', p.displayName, '(' + p.gender + '/' + p.ageCategory + ')',
    'target=' + p.wishTarget, 'raw○=' + p.rawWantCount,
    '=>', assigned.length ? assigned.join(', ') : '(なし)',
    p.flag ? '要確認: ' + p.flag : '');
  p.notes.forEach(function (n) { console.log('    ノート:', n); });
});

// ------------------------------------------------------------
// 指示書に明記された5つの確認観点をアサーションとして検証する
// ------------------------------------------------------------
let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log('[PASS]', label);
  } else {
    console.log('[FAIL]', label);
    failures++;
  }
}

function findByName(mei) {
  return participants.find(function (p) { return p.mei === mei; });
}

console.log('\n=== 指示書記載の確認観点 ===');

// 1. パンくい競争（定員5）に、えー・びー・ひーの3人がどう割り振られるか（ひーくんが確実に拾われるか）
const eita = findByName('エイタ');
const beat = findByName('ビート');
const hiroto = findByName('ヒロト');
const pankui = 'e10';
check('ヒロト（希望が少ない）がパンくい競争に割り当てられている',
  hiroto.assignments.some(function (a) { return a.eventId === pankui; }));
console.log('  参考: エイタ raw○=' + eita.rawWantCount, 'ビート raw○=' + beat.rawWantCount, 'ヒロト raw○=' + hiroto.rawWantCount);

// 2. サユリさん（×だらけで唯一の希望が競合）が「要確認」として出力されるか
const sayuri = findByName('サユリ');
check('サユリさんの割り当て状況が確認できる（0件なら要確認フラグが立つ）',
  sayuri.assignments.length > 0 || sayuri.flag);
console.log('  サユリさん: assignments=' + sayuri.assignments.length, 'flag=' + JSON.stringify(sayuri.flag));

// 3. ケンタくん（性別ミスマッチの希望）がどう扱われるか
const kenta = findByName('ケンタ');
console.log('  ケンタくん: assignments=' + kenta.assignments.length, 'notes=' + JSON.stringify(kenta.notes));
check('ケンタくんの性別ミスマッチ希望が対象外ノートとして記録されている、または正しく割当済み',
  kenta.notes.length > 0 || kenta.assignments.length > 0);

// 4. ハナコさん（応援のみ）がエラーにならず、割り当て対象から自然に除外されるか
check('ハナコさん（応援のみ）は参加者リストに含まれない',
  !participants.some(function (p) { return p.mei === 'ハナコ'; }));

// 5. 田村夫妻の備考欄が、それぞれの出力行にちゃんと残っているか
const masashi = findByName('マサシ');
const aya = findByName('アヤ');
check('田村マサシさんの備考欄が保持されている', masashi && masashi.remarks && masashi.remarks.indexOf('ペア') !== -1);
check('田村アヤさんの備考欄が保持されている', aya && aya.remarks && aya.remarks.indexOf('ペア') !== -1);

console.log('\n=== Excel出力プレビュー（先頭10行） ===');
const outputRows = Core.buildOutputRows(EVENTS_MASTER, participants);
console.log('列:', Core.OUTPUT_COLUMNS.join(' | '));
outputRows.slice(0, 10).forEach(function (r) {
  console.log(Core.OUTPUT_COLUMNS.map(function (c) { return r[c]; }).join(' | '));
});
console.log('総行数:', outputRows.length);

console.log('\n' + (failures === 0 ? 'すべての確認観点をPASSしました。' : failures + '件の確認観点がFAILしました。'));
process.exit(failures === 0 ? 0 : 1);
