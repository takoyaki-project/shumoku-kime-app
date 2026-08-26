// コアロジックをNode上で動かし、指示書の「完成の確認方法」に書かれた
// 確認観点を検証するテストハーネス。
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

const formPath = path.join(__dirname, '..', 'sample-data', 'dummy_form_responses.csv');
const formRows = readCsv(formPath);
const formHeaders = Object.keys(formRows[0]);

const classification = Core.classifyFormHeaders(formHeaders, EVENTS_MASTER);

console.log('=== 列分類 ===');
console.log('種目として認識した列数:', Object.keys(classification.eventColumns).length, '/ 種目マスタ内の種目数:', EVENTS_MASTER.events.length);
console.log('未分類の列:', classification.unmatched);
console.log('備考欄:', classification.remarksHeader);

let rawParticipants = Core.buildParticipants(formRows, classification, EVENTS_MASTER);
console.log('\n=== 重複送信の統合前 ===');
console.log('件数:', rawParticipants.length);

const participants = Core.dedupeParticipants(rawParticipants);
console.log('\n=== 重複送信の統合後 ===');
console.log('件数:', participants.length);

const tracker = Core.runAssignment(EVENTS_MASTER, participants);

console.log('\n=== 割り当て結果 ===');
const eventsById = {};
EVENTS_MASTER.events.forEach(function (e) { eventsById[e.id] = e; });
participants.forEach(function (p) {
  const assigned = p.assignments.map(function (a) { return eventsById[a.eventId].name + '[' + a.bucketKey + ']'; });
  console.log('-', p.displayName, '(' + p.gender + '/' + p.ageCategory + ')',
    'raw○=' + p.rawWantCount,
    '=>', assigned.length ? assigned.join(', ') : '(なし)',
    p.flag ? '要確認: ' + p.flag : '');
  p.notes.forEach(function (n) { console.log('    ノート:', n); });
});

// ------------------------------------------------------------
// 指示書に明記された確認観点をアサーションとして検証する
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

function findByFurigana(furigana) {
  return participants.find(function (p) { return p.furigana === furigana; });
}

console.log('\n=== 指示書記載の確認観点 ===');

// 1. パンくい競争（定員5）に対して、えー・びー・ひー・サユリさんの4人がどう割り振られるか
const eita = findByFurigana('イチバンエイタ');
const beat = findByFurigana('イチバンビート');
const hiroto = findByFurigana('イチバンヒロト');
const sayuri = findByFurigana('イチバンサユリ');
const pankui = 'e10';
check('ヒロト（希望が1つだけ）がパンくい競争に割り当てられている',
  hiroto.assignments.some(function (a) { return a.eventId === pankui; }));
console.log('  参考: エイタ raw○=' + eita.rawWantCount, 'ビート raw○=' + beat.rawWantCount,
  'ヒロト raw○=' + hiroto.rawWantCount, 'サユリ raw○=' + sayuri.rawWantCount);

// 2. サユリさん（1種目のみチェック）が、外れた場合に「要確認」として出力されるか
check('サユリさんの割り当て状況が確認できる（0件なら要確認フラグが立つ）',
  sayuri.assignments.length > 0 || sayuri.flag);
console.log('  サユリさん: assignments=' + sayuri.assignments.length, 'flag=' + JSON.stringify(sayuri.flag));

// 3. ケンタくん（性別ミスマッチの希望）がどう扱われるか
const kenta = findByFurigana('イチバンケンタ');
console.log('  ケンタくん: assignments=' + kenta.assignments.length, 'notes=' + JSON.stringify(kenta.notes));
check('ケンタくんの性別ミスマッチ希望が対象外ノートとして記録されている、または正しく割当済み',
  kenta.notes.length > 0 || kenta.assignments.length > 0);

// 4. ハナコさん（応援のみ）がエラーにならず、割り当て対象から自然に除外されるか
check('ハナコさん（応援のみ）は参加者リストに含まれない',
  !participants.some(function (p) { return p.furigana === 'イチバンハナコ'; }));

// 5. 田村夫妻の備考欄が、それぞれの出力行にちゃんと残っているか
const masashi = findByFurigana('タムラマサシ');
const aya = findByFurigana('タムラアヤ');
check('田村マサシさんの備考欄が保持されている', masashi && masashi.remarks && masashi.remarks.indexOf('ペア') !== -1);
check('田村アヤさんの備考欄が保持されている', aya && aya.remarks && aya.remarks.indexOf('ペア') !== -1);

// 6. えーくんの重複送信（2件目、タイムスタンプが新しい方）が正しく1件だけ採用されるか
const eitaMatches = participants.filter(function (p) { return p.furigana === 'イチバンエイタ'; });
check('一番英太さんの重複送信が1件に統合されている', eitaMatches.length === 1);
if (eitaMatches.length === 1) {
  console.log('  採用されたタイムスタンプ:', eitaMatches[0].timestampRaw, '(2026/09/02のほうが新しい想定)');
  check('新しい方（2026/09/02）のタイムスタンプが採用されている', eitaMatches[0].timestampRaw.indexOf('2026/09/02') === 0);
}
check('生の回答（統合前）には英太さんが2件含まれていた', rawParticipants.filter(function (p) { return p.furigana === 'イチバンエイタ'; }).length === 2);

console.log('\n=== Excel出力プレビュー ===');
const outputRows = Core.buildOutputRows(EVENTS_MASTER, participants, tracker);
console.log('列:', Core.OUTPUT_COLUMNS.join(' | '));
outputRows.forEach(function (r) {
  console.log(Core.OUTPUT_COLUMNS.map(function (c) { return r[c]; }).join(' | '));
});
console.log('総行数:', outputRows.length);

const vacancyRows = outputRows.filter(function (r) { return r['氏名'] === '欠員'; });
check('7. 定員に対して希望者が少ない種目に「欠員」行が出力されている', vacancyRows.length > 0);
console.log('  欠員行の数:', vacancyRows.length);

console.log('\n' + (failures === 0 ? 'すべての確認観点をPASSしました。' : failures + '件の確認観点がFAILしました。'));
process.exit(failures === 0 ? 0 : 1);
