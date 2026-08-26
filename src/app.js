// 種目決めアプリ - 画面まわりの処理
// DOM操作・ファイル入出力を担当。実際の計算は core.js に任せる。
// サーバー通信は一切行わない（すべてブラウザ内で完結）。

(function () {
  'use strict';

  var Core = window.UndoukaiCore;

  var state = {
    participants: [],
    tracker: null
  };

  function $(id) { return document.getElementById(id); }

  function parseCsv(text) {
    var res = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    return res.data;
  }

  function setStatus(el, msg, isError) {
    el.textContent = msg;
    el.className = 'status' + (isError ? ' status-error' : ' status-ok');
  }

  $('loadSampleBtn').addEventListener('click', function () {
    $('formInput').value = SAMPLE_FORM_CSV;
  });

  $('runAssignBtn').addEventListener('click', function () {
    try {
      var formText = $('formInput').value;
      if (!formText.trim()) {
        setStatus($('step1Status'), '回答CSVを貼り付けてください。', true);
        return;
      }
      var formRows = parseCsv(formText);
      if (!formRows.length) {
        setStatus($('step1Status'), '回答データが読み取れませんでした。1行目が見出し行になっているか確認してください。', true);
        return;
      }

      var classification = Core.classifyFormHeaders(Object.keys(formRows[0]), EVENTS_MASTER);
      var rawParticipants = Core.buildParticipants(formRows, classification, EVENTS_MASTER);
      var participants = Core.dedupeParticipants(rawParticipants);
      var duplicateCount = rawParticipants.length - participants.length;

      var tracker = Core.runAssignment(EVENTS_MASTER, participants);
      state.participants = participants;
      state.tracker = tracker;

      var msg = '参加者 ' + participants.length + '名を読み込み、割り当てを実行しました。';
      if (duplicateCount > 0) {
        msg += '（重複送信を' + duplicateCount + '件、新しい方に統合しました）';
      }
      if (classification.unmatched.length) {
        msg += '（未分類の列: ' + classification.unmatched.join('、') + '）';
      }
      setStatus($('step1Status'), msg, false);

      renderResultSummary();
      $('resultSection').classList.remove('hidden');
      $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      setStatus($('step1Status'), '処理中にエラーが発生しました: ' + e.message, true);
    }
  });

  function renderResultSummary() {
    var participants = state.participants;
    var total = participants.length;
    var assignedAtLeastOne = participants.filter(function (p) { return p.assignments.length > 0; }).length;
    var flagged = participants.filter(function (p) { return p.flag; });

    var html = '';
    html += '<p>参加者 ' + total + '名中、' + assignedAtLeastOne + '名が少なくとも1種目に割り当てられました。</p>';
    if (flagged.length) {
      html += '<p class="status-error">要確認: ' + flagged.length + '名</p><ul>';
      flagged.forEach(function (p) {
        html += '<li>' + p.displayName + '：' + p.flag + '</li>';
      });
      html += '</ul>';
    } else {
      html += '<p class="status-ok">要確認の人はいません。</p>';
    }
    $('resultSummary').innerHTML = html;
  }

  $('downloadBtn').addEventListener('click', function () {
    var rows = Core.buildOutputRows(EVENTS_MASTER, state.participants, state.tracker);
    var ws = XLSX.utils.json_to_sheet(rows, { header: Core.OUTPUT_COLUMNS });
    ws['!cols'] = Core.OUTPUT_COLUMNS.map(function (c) {
      return { wch: c === '備考' ? 32 : 16 };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '種目割り当て');

    var today = new Date();
    var stamp = today.getFullYear() + '' +
      String(today.getMonth() + 1).padStart(2, '0') +
      String(today.getDate()).padStart(2, '0');
    XLSX.writeFile(wb, '運動会種目割り当て_' + stamp + '.xlsx');
  });
})();
