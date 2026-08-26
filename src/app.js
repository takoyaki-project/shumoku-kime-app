// うんどうかい係 - 画面まわりの処理
// DOM操作・ファイル入出力を担当。実際の計算は core.js に任せる。
// サーバー通信は一切行わない（すべてブラウザ内で完結）。

(function () {
  'use strict';

  var Core = window.UndoukaiCore;

  var state = {
    members: [],
    participants: [],
    matches: [], // { participant, result }
    linkedOverrides: {} // participantIndex -> memberSeq | 'skip'
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

  // ---------------- ステップ1: 読み込み ----------------

  $('loadSampleBtn').addEventListener('click', function () {
    $('meiboInput').value = SAMPLE_MEIBO_CSV;
    $('formInput').value = SAMPLE_FORM_CSV;
  });

  $('runMatchBtn').addEventListener('click', function () {
    try {
      var meiboText = $('meiboInput').value;
      var formText = $('formInput').value;
      if (!meiboText.trim() || !formText.trim()) {
        setStatus($('step1Status'), '名簿・回答の両方を貼り付けてください。', true);
        return;
      }
      var meiboRows = parseCsv(meiboText);
      var formRows = parseCsv(formText);
      if (!formRows.length) {
        setStatus($('step1Status'), '回答データが読み取れませんでした。1行目が見出し行になっているか確認してください。', true);
        return;
      }

      state.members = Core.buildMemberIndex(meiboRows);
      var classification = Core.classifyFormHeaders(Object.keys(formRows[0]), EVENTS_MASTER);
      state.participants = Core.buildParticipants(formRows, classification, EVENTS_MASTER);
      state.linkedOverrides = {};

      state.matches = state.participants.map(function (p) {
        return Core.matchToMeibo(state.members, { ageCategory: p.ageCategory, sei: p.sei, mei: p.mei });
      });

      var msg = '参加者 ' + state.participants.length + '名を読み込みました。';
      if (classification.unmatched.length) {
        msg += '（未分類の列: ' + classification.unmatched.join('、') + '）';
      }
      setStatus($('step1Status'), msg, false);

      renderMatchTable();
      $('step2').classList.remove('hidden');
      $('step3').classList.add('hidden');
      $('resultSection').classList.add('hidden');
    } catch (e) {
      console.error(e);
      setStatus($('step1Status'), '読み込み中にエラーが発生しました: ' + e.message, true);
    }
  });

  // ---------------- ステップ2: 名寄せ確認 ----------------

  function renderMatchTable() {
    var tbody = $('matchTableBody');
    tbody.innerHTML = '';
    var needsReview = 0;

    state.matches.forEach(function (m, idx) {
      var p = state.participants[idx];
      if (m.status === 'exact') return;
      needsReview++;

      var tr = document.createElement('tr');

      var tdName = document.createElement('td');
      tdName.textContent = p.sei + ' ' + p.mei + '（' + p.ageCategory + '）';
      tr.appendChild(tdName);

      var tdStatus = document.createElement('td');
      tdStatus.textContent = m.status === 'candidates' ? '候補あり' : '名簿に見当たりません';
      tr.appendChild(tdStatus);

      var tdAction = document.createElement('td');
      if (m.status === 'candidates') {
        var select = document.createElement('select');
        var optSkip = document.createElement('option');
        optSkip.value = 'skip';
        optSkip.textContent = 'このまま進める（紐付けしない）';
        select.appendChild(optSkip);
        m.candidates.forEach(function (c) {
          var opt = document.createElement('option');
          opt.value = String(c.seq);
          opt.textContent = c.displayName + '（' + c.ageCategory + '）';
          select.appendChild(opt);
        });
        select.value = m.candidates.length === 1 ? String(m.candidates[0].seq) : 'skip';
        state.linkedOverrides[idx] = select.value;
        select.addEventListener('change', function () {
          state.linkedOverrides[idx] = select.value;
        });
        tdAction.appendChild(select);
      } else {
        var span = document.createElement('span');
        span.textContent = '名簿の表記ゆれの可能性があります（このまま進めても割り当ては行われます）';
        span.className = 'muted';
        tdAction.appendChild(span);
      }
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    });

    $('matchSummary').textContent = needsReview === 0
      ? 'すべて名簿と一致しました。確認は不要です。'
      : needsReview + '件、確認が必要な行があります（そのまま進めても動作します）。';

    $('matchTableWrap').classList.toggle('hidden', needsReview === 0);
  }

  $('proceedToAssignBtn').addEventListener('click', function () {
    state.matches.forEach(function (m, idx) {
      var p = state.participants[idx];
      if (m.status === 'exact') {
        p.displayName = m.member.displayName;
        return;
      }
      var choice = state.linkedOverrides[idx];
      if (choice && choice !== 'skip') {
        var member = state.members[parseInt(choice, 10)];
        if (member) { p.displayName = member.displayName; return; }
      }
      p.displayName = p.sei + '　' + p.mei;
    });

    $('step3').classList.remove('hidden');
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------------- ステップ3: 実行・出力 ----------------

  $('runAssignBtn').addEventListener('click', function () {
    try {
      Core.runAssignment(EVENTS_MASTER, state.participants);
      renderResultSummary();
      $('resultSection').classList.remove('hidden');
      $('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      alert('割り当て処理中にエラーが発生しました: ' + e.message);
    }
  });

  function renderResultSummary() {
    var total = state.participants.length;
    var assignedAtLeastOne = state.participants.filter(function (p) { return p.assignments.length > 0; }).length;
    var flagged = state.participants.filter(function (p) { return p.flag; });

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
    var rows = Core.buildOutputRows(EVENTS_MASTER, state.participants);
    var ws = XLSX.utils.json_to_sheet(rows, { header: Core.OUTPUT_COLUMNS });
    ws['!cols'] = Core.OUTPUT_COLUMNS.map(function (c) {
      return { wch: c === 'システムメモ' || c === '備考' ? 32 : 16 };
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
