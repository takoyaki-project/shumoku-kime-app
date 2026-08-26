// 種目決めアプリ - コアロジック（重複送信の統合・割り当て・出力データ組み立て）
//
// ブラウザ（<script>タグ、非モジュール）でもNode（テスト用）でも
// そのまま読み込めるように、UMD風の素朴な形にしてある。
// DOM操作は一切含まない。app.js から呼び出して使う。
//
// 名簿との突き合わせ（名寄せ）は行わない（設計ブリーフ3-1：大人の名簿が存在しないため、
// フォーム回答CSVを唯一の情報源とする）。氏名はフォームの「名前」列をそのまま使う。

(function (root) {
  'use strict';

  // ============================================================
  // 種目名の正規化（Googleフォームの列見出し ⇔ 種目マスタ）
  // ============================================================

  // papaparseはheader:trueのとき、同名列が複数あると "見出し", "見出し_1", "見出し_2"...
  // のように末尾へ連番を振って重複を避ける。フォームは年齢分岐のため同じ種目名の列が
  // 複数回登場する（指示書の注意点①②）ので、比較前にこの連番を取り除く必要がある。
  function stripDuplicateSuffix(header) {
    return String(header || '').replace(/_\d+$/, '');
  }

  function normalizeEventHeader(header) {
    var s = stripDuplicateSuffix(header).normalize('NFKC').trim();
    s = s.replace(/^[☆０-９0-9①-⑳．.、]+/, '');
    return s.trim();
  }

  function buildEventNameIndex(eventsMaster) {
    var idx = {};
    eventsMaster.events.forEach(function (ev) {
      idx[normalizeEventHeader(ev.name)] = ev.id;
      (ev.aliases || []).forEach(function (a) {
        idx[normalizeEventHeader(a)] = ev.id;
      });
    });
    return idx;
  }

  var META_COLUMNS = [
    'タイムスタンプ', '名前', 'ふりがな', '住所', '電話番号（携帯）',
    '参加形式', '性別', '年齢'
  ];
  var REMARKS_HEADER_HINT = 'ご質問';

  // フォームCSVのヘッダーを分類する。
  // 戻り値: { eventColumns: { eventId: [header,...] }, remarksHeader, unmatched: [header,...] }
  function classifyFormHeaders(headers, eventsMaster) {
    var nameIndex = buildEventNameIndex(eventsMaster);
    var ignoreSet = {};
    (eventsMaster.ignore_columns || []).forEach(function (c) { ignoreSet[c] = true; });

    var eventColumns = {};
    var remarksHeader = null;
    var unmatched = [];

    headers.forEach(function (h) {
      if (META_COLUMNS.indexOf(h) !== -1) return;
      if (ignoreSet[h]) return;
      if (h.indexOf(REMARKS_HEADER_HINT) !== -1) { remarksHeader = h; return; }

      var norm = normalizeEventHeader(h);
      var eventId = nameIndex[norm];
      if (eventId) {
        if (!eventColumns[eventId]) eventColumns[eventId] = [];
        eventColumns[eventId].push(h);
      } else {
        unmatched.push(h);
      }
    });

    return { eventColumns: eventColumns, remarksHeader: remarksHeader, unmatched: unmatched };
  }

  function firstNonEmpty(row, columns) {
    for (var i = 0; i < columns.length; i++) {
      var v = (row[columns[i]] || '').trim();
      if (v) return v;
    }
    return '';
  }

  // ============================================================
  // 属性判定ヘルパー
  // ============================================================

  function gradeBandOf(ageCategory) {
    if (ageCategory === '就学前児童（保護者同伴で競技に参加）') return 'preschool';
    if (ageCategory === '就学前児童（一人で競技に参加できる）') return 'preschool';
    if (ageCategory === '小学１～３年生') return 'low';
    if (ageCategory === '小学４～６年生') return 'high';
    return 'adult';
  }

  function ageBandOf(ageCategory, eventsMaster) {
    return eventsMaster.age_category_to_subquota_band[ageCategory];
  }

  // ============================================================
  // 小枠（サブクォータ）の構造化
  // 学年内訳が「1年/2年/3年」のように回答データにない粒度の場合は、
  // 回答データで判別できる学年帯（1-3年 / 4-6年）単位に
  // 合算した1つの枠として扱う（データの粒度上の割り切り）。
  // ============================================================

  function getSubquotaBuckets(event) {
    var sq = event.subquota;
    if (!sq) {
      var cap = event.capacity_total == null ? Infinity : event.capacity_total;
      return [{ key: '_all', capacity: cap, match: function () { return true; } }];
    }

    switch (sq.type) {
      case 'gender':
        return Object.keys(sq.breakdown).map(function (k) {
          return { key: k, capacity: sq.breakdown[k], match: function (p) { return p.gender === k; } };
        });

      case 'grade': {
        // breakdownは学年番号ごとの人数のみを持ち、性別の情報を含まない場合がある
        // （例：e13/e15は「1年,2年,...」の内訳だが、対象学年は男児/女児で分かれる）。
        // そのため性別条件はevent.targetの文言から補う。
        var genderReq = null;
        if (event.target) {
          if (event.target.indexOf('女') !== -1) genderReq = '女';
          else if (event.target.indexOf('男') !== -1) genderReq = '男';
        }
        var lowCap = 0, highCap = 0, hasLow = false, hasHigh = false;
        Object.keys(sq.breakdown).forEach(function (k) {
          var n = parseInt(k, 10);
          if (n >= 1 && n <= 3) { lowCap += sq.breakdown[k]; hasLow = true; }
          else if (n >= 4 && n <= 6) { highCap += sq.breakdown[k]; hasHigh = true; }
        });
        var out = [];
        if (hasLow) out.push({
          key: '1-3年(学年内訳合算)', capacity: lowCap, match: function (p) {
            if (genderReq && p.gender !== genderReq) return false;
            return gradeBandOf(p.ageCategory) === 'low';
          }
        });
        if (hasHigh) out.push({
          key: '4-6年(学年内訳合算)', capacity: highCap, match: function (p) {
            if (genderReq && p.gender !== genderReq) return false;
            return gradeBandOf(p.ageCategory) === 'high';
          }
        });
        return out;
      }

      case 'grade_band':
        return Object.keys(sq.breakdown).map(function (k) {
          var genderReq = null;
          if (k.indexOf('男') !== -1) genderReq = '男';
          else if (k.indexOf('女') !== -1) genderReq = '女';
          var bandTokens = [['就学前', 'preschool'], ['低学年', 'low'], ['1-3', 'low'], ['1〜3', 'low'],
            ['高学年', 'high'], ['4-6', 'high'], ['4〜6', 'high'], ['中学生以上', 'adult']];
          var matchedBand = null;
          for (var i = 0; i < bandTokens.length; i++) {
            if (k.indexOf(bandTokens[i][0]) !== -1) { matchedBand = bandTokens[i][1]; break; }
          }
          var cap = sq.breakdown[k];
          return {
            key: k, capacity: cap, match: function (p) {
              if (matchedBand && gradeBandOf(p.ageCategory) !== matchedBand) return false;
              if (genderReq && p.gender !== genderReq) return false;
              return true;
            }
          };
        });

      case 'age_band':
        return Object.keys(sq.breakdown).map(function (k) {
          return {
            key: k, capacity: sq.breakdown[k], match: function (p, eventsMaster) {
              return ageBandOf(p.ageCategory, eventsMaster) === k;
            }
          };
        });

      case 'age_gender':
        return Object.keys(sq.breakdown).map(function (k) {
          return {
            key: k, capacity: sq.breakdown[k], match: function (p) {
              if (p.gender !== '女') return false;
              var under35 = ['中学生～２９歳', '３０歳〜３４歳'].indexOf(p.ageCategory) !== -1;
              return under35 ? k === '中学生以上女子' : k === '35歳以上女子';
            }
          };
        });

      case 'mixed':
        return Object.keys(sq.breakdown).map(function (k) {
          var cap = sq.breakdown[k];
          if (k === '就学前児童') {
            return { key: k, capacity: cap, match: function (p) { return gradeBandOf(p.ageCategory) === 'preschool'; } };
          }
          if (k === '1〜6年各学年') {
            return { key: k, capacity: cap, match: function (p) { var gb = gradeBandOf(p.ageCategory); return gb === 'low' || gb === 'high'; } };
          }
          if (k === '中学生以上女子') {
            return { key: k, capacity: cap, match: function (p) { return gradeBandOf(p.ageCategory) === 'adult' && p.gender === '女'; } };
          }
          return { key: k, capacity: cap, match: function () { return false; } };
        });

      default:
        return [];
    }
  }

  function resolveSubquotaBucket(event, person, eventsMaster) {
    var buckets = getSubquotaBuckets(event);
    for (var i = 0; i < buckets.length; i++) {
      if (buckets[i].match(person, eventsMaster)) {
        return { key: buckets[i].key, capacity: buckets[i].capacity };
      }
    }
    return null;
  }

  // ============================================================
  // 割り当てトラッカー（種目×小枠ごとの残数管理）
  // ============================================================

  function createTracker(eventsMaster) {
    var buckets = {}; // key: eventId + '::' + bucketKey -> { capacity, remaining, assigned: [] }

    eventsMaster.events.forEach(function (event) {
      getSubquotaBuckets(event).forEach(function (b) {
        buckets[event.id + '::' + b.key] = { capacity: b.capacity, remaining: b.capacity, assigned: [] };
      });
    });

    function k(eventId, bucketKey) { return eventId + '::' + bucketKey; }

    return {
      remaining: function (eventId, bucketKey) {
        var b = buckets[k(eventId, bucketKey)];
        return b ? b.remaining : 0;
      },
      capacity: function (eventId, bucketKey) {
        var b = buckets[k(eventId, bucketKey)];
        return b ? b.capacity : 0;
      },
      assign: function (eventId, bucketKey, person) {
        var b = buckets[k(eventId, bucketKey)];
        if (!b) throw new Error('unknown bucket ' + eventId + '/' + bucketKey);
        if (b.remaining <= 0) throw new Error('bucket full ' + eventId + '/' + bucketKey);
        if (b.remaining !== Infinity) b.remaining -= 1;
        b.assigned.push(person);
        person.assignedEventIds[eventId] = true;
        person.assignments.push({ eventId: eventId, bucketKey: bucketKey });
      },
      allBucketsOf: function (eventId) {
        return Object.keys(buckets)
          .filter(function (key) { return key.indexOf(eventId + '::') === 0; })
          .map(function (key) { return { bucketKey: key.slice((eventId + '::').length), info: buckets[key] }; });
      }
    };
  }

  // ============================================================
  // 重複送信の統合（設計ブリーフ 5章 / 指示書 ⑧）
  // 「名前」「年齢」「性別」が完全一致する行が複数あれば、
  // タイムスタンプが最も新しいものだけを残す。
  // タイムスタンプが読み取れない場合は全件残し、「重複疑い」フラグを立てる。
  // ============================================================

  function normalizeNameForDedupe(name) {
    return String(name || '').normalize('NFKC').replace(/[\s　]+/g, '');
  }

  // "2026/09/01 10:00:00" 形式を想定。読み取れなければ null。
  function parseTimestamp(raw) {
    if (!raw) return null;
    var m = String(raw).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    var t = new Date(
      parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
      parseInt(m[4], 10), parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0
    ).getTime();
    return isNaN(t) ? null : t;
  }

  function dedupeParticipants(participants) {
    var groups = {};
    var order = [];
    participants.forEach(function (p) {
      var key = normalizeNameForDedupe(p.name) + '::' + p.ageCategory + '::' + p.gender;
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(p);
    });

    var kept = [];
    order.forEach(function (key) {
      var group = groups[key];
      if (group.length === 1) { kept.push(group[0]); return; }

      var withTs = group.map(function (p) { return { p: p, t: parseTimestamp(p.timestampRaw) }; });
      var allParsed = withTs.every(function (x) { return x.t != null; });

      if (!allParsed) {
        group.forEach(function (p) {
          p.flag = '同一人物と思われる重複送信（' + group.length + '件）がありますが、タイムスタンプが読み取れず自動判定できません。人の目で確認してください。';
        });
        kept = kept.concat(group);
        return;
      }

      withTs.sort(function (a, b) { return b.t - a.t; }); // 新しい順
      kept.push(withTs[0].p);
      // それ以外（古い方）は破棄する（設計ブリーフ5章）
    });

    return kept;
  }

  // ============================================================
  // 参加者オブジェクトの組み立て
  // ============================================================

  function buildParticipants(formRows, classification, eventsMaster) {
    var participants = [];
    formRows.forEach(function (row, seq) {
      var participationForm = (row['参加形式'] || '').trim();
      if (participationForm !== '出場可') return; // 応援のみ等は割り当て対象外

      var wishesByEvent = {};
      var rawWantCount = 0;
      Object.keys(classification.eventColumns).forEach(function (eventId) {
        var v = firstNonEmpty(row, classification.eventColumns[eventId]);
        if (v) { wishesByEvent[eventId] = true; rawWantCount++; }
      });

      var name = (row['名前'] || '').trim();
      var p = {
        seq: seq,
        timestampRaw: (row['タイムスタンプ'] || '').trim(),
        name: name,
        furigana: (row['ふりがな'] || '').trim(),
        gender: (row['性別'] || '').trim(),
        ageCategory: (row['年齢'] || '').trim(),
        wishesByEvent: wishesByEvent,
        rawWantCount: rawWantCount,
        remarks: classification.remarksHeader ? (row[classification.remarksHeader] || '').trim() : '',
        displayName: name,
        assignedEventIds: {},
        assignments: [],
        resolvableWishes: [],
        notes: [],
        flag: ''
      };
      participants.push(p);
    });
    return participants;
  }

  function preprocessParticipant(p, eventsMaster) {
    var eventsById = eventsMaster._eventsById;
    Object.keys(p.wishesByEvent).forEach(function (eventId) {
      var event = eventsById[eventId];
      if (!event) return;
      var resolved = resolveSubquotaBucket(event, p, eventsMaster);
      if (!resolved) {
        p.notes.push('「' + event.name + '」を希望されましたが、性別・学年の対象枠に合致しないため対象外です。');
        return;
      }
      p.resolvableWishes.push({ eventId: eventId, bucketKey: resolved.key });
    });
  }

  // ============================================================
  // 割り当てロジック（設計ブリーフ 4章）
  //
  // 優先度は「チェックした種目数が少ない人ほど高い」という固定順で決まり、
  // 第1段階（保証パス）・第2段階（希望の上乗せパス）とも同じ優先順を使う
  // （4-1・4-2）。そのため実装上は同一の優先順リストに対して、
  // 割り当てられるものがなくなるまでラウンドを繰り返す1つのループでよい。
  // 参加種目数の上限は設けない（4-1）。「×（避けたい）」の概念は存在しない
  // （出場希望のチェックの有無のみ）。定員割れした種目に無記入の人を自動で
  // 回す「おまかせ埋め」は行わない（4-2「定員割れの扱い」）。
  // ============================================================

  function assignByFixedPriority(participants, tracker) {
    var order = participants.slice().sort(function (a, b) {
      return (a.rawWantCount - b.rawWantCount) || (a.seq - b.seq);
    });

    var changed = true;
    var guard = 0;
    while (changed && guard < 1000) {
      changed = false;
      guard++;
      order.forEach(function (p) {
        var candidates = p.resolvableWishes.filter(function (w) {
          return !p.assignedEventIds[w.eventId] && tracker.remaining(w.eventId, w.bucketKey) > 0;
        });
        if (candidates.length === 0) return;
        candidates.sort(function (a, b) {
          return (tracker.remaining(a.eventId, a.bucketKey) - tracker.remaining(b.eventId, b.bucketKey)) ||
            (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
        });
        tracker.assign(candidates[0].eventId, candidates[0].bucketKey, p);
        changed = true;
      });
    }
  }

  function finalizeFlags(participants) {
    participants.forEach(function (p) {
      if (p.assignments.length === 0 && p.rawWantCount > 0 && !p.flag) {
        p.flag = '希望した種目にすべて外れました。手動での割り当てをご検討ください。';
      }
    });
  }

  function runAssignment(eventsMaster, participants) {
    if (!eventsMaster._eventsById) {
      eventsMaster._eventsById = {};
      eventsMaster.events.forEach(function (ev) { eventsMaster._eventsById[ev.id] = ev; });
    }
    participants.forEach(function (p) { preprocessParticipant(p, eventsMaster); });
    var tracker = createTracker(eventsMaster);
    assignByFixedPriority(participants, tracker);
    finalizeFlags(participants);
    return tracker;
  }

  // ============================================================
  // Excel出力用の行データ組み立て（設計ブリーフ 6章）
  // 1シート構成。要確認の人を先頭にまとめ、続けて種目ごとの出場者一覧
  // （定員割れした小枠には「欠員」行を追加）を並べる。
  // ============================================================

  var OUTPUT_COLUMNS = ['要確認', '種目名', '時間帯', '氏名', '性別', '学年/年齢区分', '得点競技', '備考'];

  function byDisplayName(a, b) {
    return a.displayName < b.displayName ? -1 : (a.displayName > b.displayName ? 1 : 0);
  }

  function buildOutputRows(eventsMaster, participants, tracker) {
    var rows = [];

    participants
      .filter(function (p) { return p.flag; })
      .sort(byDisplayName)
      .forEach(function (p) {
        rows.push({
          '要確認': p.flag,
          '種目名': '（未割当）',
          '時間帯': '-',
          '氏名': p.displayName,
          '性別': p.gender,
          '学年/年齢区分': p.ageCategory,
          '得点競技': '-',
          '備考': p.remarks
        });
      });

    eventsMaster.events.forEach(function (event) {
      var assignedForEvent = participants.filter(function (p) {
        return p.assignments.some(function (a) { return a.eventId === event.id; });
      }).sort(byDisplayName);

      assignedForEvent.forEach(function (p) {
        rows.push({
          '要確認': '',
          '種目名': event.name,
          '時間帯': event.timeslot === 'AM' ? '午前' : '午後',
          '氏名': p.displayName,
          '性別': p.gender,
          '学年/年齢区分': p.ageCategory,
          '得点競技': event.scored ? '○' : '',
          '備考': p.remarks
        });
      });

      // 定員割れの小枠は不足人数分だけ「欠員」行を追加する（無制限枠は対象外）
      if (tracker) {
        getSubquotaBuckets(event).forEach(function (b) {
          var remaining = tracker.remaining(event.id, b.key);
          if (remaining === Infinity || remaining <= 0) return;
          for (var i = 0; i < remaining; i++) {
            rows.push({
              '要確認': '',
              '種目名': event.name,
              '時間帯': event.timeslot === 'AM' ? '午前' : '午後',
              '氏名': '欠員',
              '性別': '',
              '学年/年齢区分': '',
              '得点競技': event.scored ? '○' : '',
              '備考': ''
            });
          }
        });
      }
    });

    return rows;
  }

  // ============================================================
  // 公開インターフェース
  // ============================================================

  var Core = {
    normalizeEventHeader: normalizeEventHeader,
    buildEventNameIndex: buildEventNameIndex,
    classifyFormHeaders: classifyFormHeaders,
    firstNonEmpty: firstNonEmpty,
    gradeBandOf: gradeBandOf,
    ageBandOf: ageBandOf,
    getSubquotaBuckets: getSubquotaBuckets,
    resolveSubquotaBucket: resolveSubquotaBucket,
    createTracker: createTracker,
    normalizeNameForDedupe: normalizeNameForDedupe,
    parseTimestamp: parseTimestamp,
    dedupeParticipants: dedupeParticipants,
    buildParticipants: buildParticipants,
    preprocessParticipant: preprocessParticipant,
    runAssignment: runAssignment,
    buildOutputRows: buildOutputRows,
    OUTPUT_COLUMNS: OUTPUT_COLUMNS
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  } else {
    root.UndoukaiCore = Core;
  }
})(typeof window !== 'undefined' ? window : this);
