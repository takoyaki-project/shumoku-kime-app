// うんどうかい係 - コアロジック（名寄せ・割り当て・出力データ組み立て）
//
// ブラウザ（<script>タグ、非モジュール）でもNode（テスト用）でも
// そのまま読み込めるように、UMD風の素朴な形にしてある。
// DOM操作は一切含まない。app.js から呼び出して使う。

(function (root) {
  'use strict';

  // ============================================================
  // 名寄せ（名前の突き合わせ）
  // 設計ブリーフ 5章の手順どおり：
  // NFKC正規化 → 空白/記号除去 → カタカナ→ひらがな → 長音/小書き文字除去
  // ============================================================

  var SMALL_KANA = { 'ぁ':1, 'ぃ':1, 'ぅ':1, 'ぇ':1, 'ぉ':1, 'っ':1, 'ゃ':1, 'ゅ':1, 'ょ':1, 'ゎ':1 };

  function toHiragana(str) {
    return str.replace(/[ァ-ヶ]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
  }

  function compareKey(str) {
    if (!str) return '';
    var s = String(str).normalize('NFKC');
    // 空白・記号・長音を除去
    s = s.replace(/[\s　・,，、。.．\-‐–—ー\/／()（）]/g, '');
    s = toHiragana(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      if (!SMALL_KANA[s[i]]) out += s[i];
    }
    return out;
  }

  function buildMemberIndex(meiboRows) {
    return meiboRows.map(function (r, i) {
      var sei = r['姓（カタカナ）'] || '';
      var mei = r['名（カタカナ）'] || '';
      return {
        seq: i,
        ageCategory: (r['学年'] || '').trim(),
        sei: sei,
        mei: mei,
        displayName: r['表示名'] || (sei + ' ' + mei),
        seiKey: compareKey(sei),
        meiKey: compareKey(mei)
      };
    });
  }

  // formPerson: { ageCategory, sei, mei }
  // 戻り値: { status: 'exact'|'candidates'|'unknown', member, candidates }
  function matchToMeibo(members, formPerson) {
    var seiKey = compareKey(formPerson.sei);
    var meiKey = compareKey(formPerson.mei);
    var fullKey = seiKey + meiKey;

    var exact = members.filter(function (m) {
      return m.ageCategory === formPerson.ageCategory && (m.seiKey + m.meiKey) === fullKey;
    });
    if (exact.length === 1) {
      return { status: 'exact', member: exact[0], candidates: [] };
    }
    if (exact.length > 1) {
      return { status: 'candidates', member: null, candidates: exact };
    }

    var partial = members.filter(function (m) {
      if ((m.seiKey + m.meiKey) === fullKey) return true; // 名前は一致・学年だけ違う
      if (m.ageCategory === formPerson.ageCategory && (m.seiKey === seiKey || m.meiKey === meiKey)) return true;
      return false;
    });
    if (partial.length > 0) {
      return { status: 'candidates', member: null, candidates: partial };
    }
    return { status: 'unknown', member: null, candidates: [] };
  }

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
    '姓（カタカナ）', '名（カタカナ）', '住所', '電話番号（携帯）',
    '参加形式', '性別', '年齢', '参加区分'
  ];
  var WISH_COUNT_HEADER_HINT = 'いくつくらい';
  var REMARKS_HEADER_HINT = 'ご質問';
  var RELAY_HEADER_HINT_A = 'リレー';
  var RELAY_HEADER_HINT_B = '町内対抗';

  // フォームCSVのヘッダーを分類する。
  // 戻り値: { eventColumns: { eventId: [header,...] }, wishCountHeader, remarksHeader, relayHeader, unmatched: [header,...] }
  function classifyFormHeaders(headers, eventsMaster) {
    var nameIndex = buildEventNameIndex(eventsMaster);
    var ignoreSet = {};
    (eventsMaster.ignore_columns || []).forEach(function (c) { ignoreSet[c] = true; });

    var eventColumns = {};
    var wishCountHeader = null;
    var remarksHeader = null;
    var relayHeader = null;
    var unmatched = [];

    headers.forEach(function (h) {
      if (META_COLUMNS.indexOf(h) !== -1) return;
      if (ignoreSet[h]) return;
      if (h.indexOf(WISH_COUNT_HEADER_HINT) !== -1) { wishCountHeader = h; return; }
      if (h.indexOf(RELAY_HEADER_HINT_A) !== -1 && h.indexOf(RELAY_HEADER_HINT_B) !== -1) { relayHeader = h; return; }
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

    return {
      eventColumns: eventColumns,
      wishCountHeader: wishCountHeader,
      remarksHeader: remarksHeader,
      relayHeader: relayHeader,
      unmatched: unmatched
    };
  }

  function firstNonEmpty(row, columns) {
    for (var i = 0; i < columns.length; i++) {
      var v = (row[columns[i]] || '').trim();
      if (v) return v;
    }
    return '';
  }

  function markFromValue(v) {
    if (v === '出たい') return '○';
    if (v === '避けたい') return '×';
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

  function periodCompatible(participationPeriod, eventTimeslot) {
    if (participationPeriod === '午前のみ') return eventTimeslot === 'AM';
    if (participationPeriod === '午後のみ') return eventTimeslot === 'PM';
    // 「全日参加」または未記入・不明な値は制限しない（自己申告を信頼する設計方針に合わせる）
    return true;
  }

  // ============================================================
  // 小枠（サブクォータ）の構造化
  // 学年内訳が「1年/2年/3年」のように名簿にない粒度の場合は、
  // 名簿・回答データで判別できる学年帯（1-3年 / 4-6年）単位に
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

  // おまかせ埋め（無記入の人を回す）の際、対象学年・性別（target文言）に
  // 照らして妥当かどうかを判定する。
  // ※ 本人が明示的に「出たい」と答えた希望はこのチェックを通さない
  //   （設計ブリーフ3-3：自己申告を信頼し、システム側で強制チェックしない）。
  //   小枠（gender等）は対象年齢まで表現しきれない場合があるため
  //   （例：e05はtype=genderだがtargetは「中学生以上」）、
  //   小枠の有無に関わらずstage3では常にこのtarget判定も併用する。
  function isPlausibleForTarget(target, person) {
    var gb = gradeBandOf(person.ageCategory);
    if (target.indexOf('就学前児童') !== -1) {
      if (gb !== 'preschool') return false;
      if (target.indexOf('一人で') !== -1 && person.ageCategory.indexOf('一人で') === -1) return false;
      if (target.indexOf('保護者同伴') !== -1 && person.ageCategory.indexOf('保護者同伴') === -1) return false;
    } else if (target.indexOf('小学生') !== -1 || target.indexOf('1〜6年') !== -1) {
      if (gb !== 'low' && gb !== 'high') return false;
    } else if (target.indexOf('4〜6年') !== -1 || target.indexOf('4-6年') !== -1) {
      if (gb !== 'high') return false;
    } else if (target.indexOf('1〜3年') !== -1 || target.indexOf('1-3年') !== -1) {
      if (gb !== 'low') return false;
    } else if (target.indexOf('中学生以上') !== -1 || target.indexOf('40歳以上') !== -1 ||
               target.indexOf('50歳以上') !== -1 || target.indexOf('35歳以上') !== -1) {
      if (gb !== 'adult') return false;
      if (target.indexOf('50歳以上') !== -1 && person.ageCategory !== '５０歳〜') return false;
      if (target.indexOf('40歳以上') !== -1 && ['４０歳〜４９歳', '５０歳〜'].indexOf(person.ageCategory) === -1) return false;
      if (target.indexOf('35歳以上') !== -1 && ['３５歳〜３９歳', '４０歳〜４９歳', '５０歳〜'].indexOf(person.ageCategory) === -1) return false;
    }
    if ((target.indexOf('女子') !== -1 || target.indexOf('女児') !== -1 || target.indexOf('（女）') !== -1) && person.gender !== '女') return false;
    if ((target.indexOf('男子') !== -1 || target.indexOf('男児') !== -1 || target.indexOf('（男）') !== -1) && person.gender !== '男') return false;
    return true;
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
      listAssigned: function (eventId, bucketKey) {
        var b = buckets[k(eventId, bucketKey)];
        return b ? b.assigned : [];
      },
      allBucketsOf: function (eventId) {
        return Object.keys(buckets)
          .filter(function (key) { return key.indexOf(eventId + '::') === 0; })
          .map(function (key) { return { bucketKey: key.slice((eventId + '::').length), info: buckets[key] }; });
      }
    };
  }

  // ============================================================
  // 参加者オブジェクトの組み立て
  // ============================================================

  function buildParticipants(formRows, classification, eventsMaster) {
    var participants = [];
    formRows.forEach(function (row, seq) {
      var participationForm = (row['参加形式'] || '').trim();
      if (participationForm !== '出場可') return; // 応援のみ等は割り当て対象外

      var wishCountText = classification.wishCountHeader ? (row[classification.wishCountHeader] || '').trim() : '';
      var weight = eventsMaster.wish_count_weight[wishCountText];

      var wishesByEvent = {};
      var rawWantCount = 0;
      Object.keys(classification.eventColumns).forEach(function (eventId) {
        var v = firstNonEmpty(row, classification.eventColumns[eventId]);
        var mark = markFromValue(v);
        if (mark) wishesByEvent[eventId] = mark;
        if (mark === '○') rawWantCount++;
      });

      var p = {
        seq: seq,
        sei: (row['姓（カタカナ）'] || '').trim(),
        mei: (row['名（カタカナ）'] || '').trim(),
        gender: (row['性別'] || '').trim(),
        ageCategory: (row['年齢'] || '').trim(),
        participationPeriod: (row['参加区分'] || '').trim(),
        wishCountText: wishCountText,
        wishTarget: weight != null ? weight : rawWantCount,
        wishesByEvent: wishesByEvent,
        rawWantCount: rawWantCount,
        remarks: classification.remarksHeader ? (row[classification.remarksHeader] || '').trim() : '',
        relayPref: classification.relayHeader ? (row[classification.relayHeader] || '').trim() : '',
        displayName: null, // 名寄せ後に設定
        matchStatus: null,
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
      if (p.wishesByEvent[eventId] !== '○') return;
      var event = eventsById[eventId];
      if (!event) return;
      if (!periodCompatible(p.participationPeriod, event.timeslot)) {
        p.notes.push('「' + event.name + '」を希望されましたが、参加区分（' + (p.participationPeriod || '未記入') + '）と時間帯が合わないため対象外です。');
        return;
      }
      var resolved = resolveSubquotaBucket(event, p, eventsMaster);
      if (!resolved) {
        p.notes.push('「' + event.name + '」を希望されましたが、性別・学年の対象枠に合致しないため対象外です。');
        return;
      }
      p.resolvableWishes.push({ eventId: eventId, bucketKey: resolved.key });
    });
  }

  // ============================================================
  // 3段階の割り当てロジック（設計ブリーフ 4章）
  // ============================================================

  function stage1_guarantee(participants, tracker) {
    var order = participants.slice().sort(function (a, b) {
      return (a.rawWantCount - b.rawWantCount) || (a.wishTarget - b.wishTarget) || (a.seq - b.seq);
    });
    order.forEach(function (p) {
      if (p.assignments.length > 0) return;
      var candidates = p.resolvableWishes.filter(function (w) {
        return !p.assignedEventIds[w.eventId] && tracker.remaining(w.eventId, w.bucketKey) > 0;
      });
      if (candidates.length === 0) return;
      candidates.sort(function (a, b) {
        return (tracker.remaining(a.eventId, a.bucketKey) - tracker.remaining(b.eventId, b.bucketKey)) ||
          (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0);
      });
      tracker.assign(candidates[0].eventId, candidates[0].bucketKey, p);
    });
  }

  function stage2_wishBonus(participants, tracker) {
    var changed = true;
    var guard = 0;
    while (changed && guard < 1000) {
      changed = false;
      guard++;
      var order = participants.slice().sort(function (a, b) {
        return (a.assignments.length - b.assignments.length) || (a.rawWantCount - b.rawWantCount) || (a.seq - b.seq);
      });
      order.forEach(function (p) {
        if (p.assignments.length >= p.wishTarget) return;
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

  function stage3_fill(participants, eventsMaster, tracker) {
    eventsMaster.events.forEach(function (event) {
      if (event.subquota == null && event.capacity_total == null) return; // 無制限の種目はおまかせ埋めの対象外
      var buckets = getSubquotaBuckets(event);
      buckets.forEach(function (b) {
        var remaining = tracker.remaining(event.id, b.key);
        if (remaining <= 0 || remaining === Infinity) return;

        var pool = participants.filter(function (p) {
          if (p.assignedEventIds[event.id]) return false;
          if (!periodCompatible(p.participationPeriod, event.timeslot)) return false;
          var mark = p.wishesByEvent[event.id];
          if (mark === '×' || mark === '○') return false; // 無記入の人だけが対象
          if (event.subquota && !b.match(p, eventsMaster)) return false;
          return isPlausibleForTarget(event.target || '', p);
        });

        // 本人が「出られる」と申告した種目数（wishTarget）を超えてまで
        // おまかせで積み増すことはしない。申告数に達していない人だけが対象。
        var byPriority = function (a, c) { return (a.assignments.length - c.assignments.length) || (a.seq - c.seq); };
        var ordered = pool.filter(function (p) { return p.assignments.length < p.wishTarget; }).sort(byPriority);

        for (var i = 0; i < ordered.length && remaining > 0; i++) {
          tracker.assign(event.id, b.key, ordered[i]);
          remaining--;
        }
      });
    });
  }

  function finalizeFlags(participants) {
    participants.forEach(function (p) {
      if (p.assignments.length === 0 && p.rawWantCount > 0) {
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
    stage1_guarantee(participants, tracker);
    stage2_wishBonus(participants, tracker);
    stage3_fill(participants, eventsMaster, tracker);
    finalizeFlags(participants);
    return tracker;
  }

  // ============================================================
  // Excel出力用の行データ組み立て（設計ブリーフ 6章）
  // 1シート構成。要確認の人を先頭にまとめ、続けて種目ごとの出場者一覧、
  // 最後にリレー（町内対抗）希望者の参考情報を並べる。
  // ============================================================

  var OUTPUT_COLUMNS = ['要確認', '種目名', '時間帯', '出場者名', '性別', '学年/年齢区分', '得点競技', '備考', 'システムメモ'];

  function byDisplayName(a, b) {
    return a.displayName < b.displayName ? -1 : (a.displayName > b.displayName ? 1 : 0);
  }

  function buildOutputRows(eventsMaster, participants) {
    var rows = [];

    participants
      .filter(function (p) { return p.flag; })
      .sort(byDisplayName)
      .forEach(function (p) {
        rows.push({
          '要確認': p.flag,
          '種目名': '（未割当）',
          '時間帯': '-',
          '出場者名': p.displayName,
          '性別': p.gender,
          '学年/年齢区分': p.ageCategory,
          '得点競技': '-',
          '備考': p.remarks,
          'システムメモ': p.notes.join(' / ')
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
          '出場者名': p.displayName,
          '性別': p.gender,
          '学年/年齢区分': p.ageCategory,
          '得点競技': event.scored ? '○' : '',
          '備考': p.remarks,
          'システムメモ': p.notes.join(' / ')
        });
      });
    });

    participants
      .filter(function (p) { return p.relayPref; })
      .sort(byDisplayName)
      .forEach(function (p) {
        rows.push({
          '要確認': '',
          '種目名': 'リレー（町内対抗・参考情報）',
          '時間帯': '-',
          '出場者名': p.displayName,
          '性別': p.gender,
          '学年/年齢区分': p.ageCategory,
          '得点競技': '-',
          '備考': p.remarks,
          'システムメモ': '本人希望: ' + p.relayPref
        });
      });

    return rows;
  }

  // ============================================================
  // 公開インターフェース
  // ============================================================

  var Core = {
    compareKey: compareKey,
    buildMemberIndex: buildMemberIndex,
    matchToMeibo: matchToMeibo,
    normalizeEventHeader: normalizeEventHeader,
    buildEventNameIndex: buildEventNameIndex,
    classifyFormHeaders: classifyFormHeaders,
    firstNonEmpty: firstNonEmpty,
    markFromValue: markFromValue,
    gradeBandOf: gradeBandOf,
    ageBandOf: ageBandOf,
    periodCompatible: periodCompatible,
    getSubquotaBuckets: getSubquotaBuckets,
    resolveSubquotaBucket: resolveSubquotaBucket,
    createTracker: createTracker,
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
