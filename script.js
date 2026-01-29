/**
 * ポーズ合わせゲーム
 * - 最大4人検出（MoveNet MultiPose / PoseNet multi-pose）
 * - お題ポーズと一致でOK、不一致でX
 * - 難易度3段階、プレイヤー別トータル点数、BGM
 */

const BGM_PATH = 'music/bgm.mp3';
// 難易度ごとの判定閾値（腕の状態が両方一致したときのみ合格）
const DIFFICULTY_THRESHOLD = { easy: 0.75, normal: 0.85, hard: 0.95 };
const COOLDOWN_MS = 2500;
const MIN_KEYPOINT_SCORE = 0.25;
const MOTION_THRESHOLD = 15;

// ★スムージング設定（0.0〜1.0: 小さいほど滑らかだが遅延する）
// ガクガク・飛びを抑えるため強めに設定（前のフレームを多く残す）
const SMOOTH_ALPHA = {
  torso: 0.5,        // 体幹
  limbs: 0.4,       // 肘・膝
  extremities: 0.3   // 手首・足首
};
// ★飛び防止: 1フレームでこれ以上動いたら制限をかける（ピクセル）
// 人間が素早く手を振ると1フレームで100px以上動くことがあるため緩和
const MAX_JUMP_PIXELS = 300;

// ★手のスムージング強化（手首は他より強く安定化して飛びを抑える）
// lerp では alpha = 新座標の反映率。小さいほど強くスムージング
const SMOOTH_ALPHA_HANDS = 0.2;

// 割り当ての安定化：前フレームとの距離が近いほど同一人物として扱うボーナス
var STICKY_DISTANCE_BONUS = 350;

const SKELETON_EDGES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle']
];

let detector = null;
let usePoseNet = false;
let currentDifficulty = 'normal';
let maxPlayerCount = 4;
let currentTargetIndex = 0;
let playerScores = [0, 0, 0, 0];
let playerCooldownUntil = [0, 0, 0, 0];
let lastPlayerPoses = [null, null, null, null];
let lastJudgeResult = [null, null, null, null];
let gameStarted = false;
let previousPosePositions = [null, null, null, null];

// ★スムージング用：前回の確定座標を保持
let smoothedPoses = [null, null, null, null];

const video = document.getElementById('webcam');
const statusEl = document.getElementById('status');
const targetCanvas = document.getElementById('targetCanvas');
const targetNameEl = document.getElementById('targetName');
const overlayCanvas = document.getElementById('overlayCanvas');
const bgmEl = document.getElementById('bgm');

// --- スムージング関数 ---
function lerp(start, end, amt) {
  return (1 - amt) * start + amt * end;
}

function smoothPoses(rawPoses, players) {
  // rawPoses: 今回検出されたポーズリスト
  // players: 割り当て済みのポーズ（未加工）
  // ここで players[p] の座標を smoothedPoses[p] とブレンドして書き換える

  for (let p = 0; p < 4; p++) {
    const raw = players[p];
    const prev = smoothedPoses[p];

    if (!raw) {
      // 検出されなかったら履歴もリセット（あるいは維持する手もあるが、今回はリセット）
      smoothedPoses[p] = null;
      continue;
    }

    // 初回検出時はそのまま採用
    if (!prev) {
      smoothedPoses[p] = JSON.parse(JSON.stringify(raw));
      continue;
    }

    // 各キーポイントについて補間を行う
    raw.keypoints.forEach((kp, idx) => {
      const prevKp = prev.keypoints[idx]; // 同じインデックス前提

      // キーポイントが見つからない、またはスコアが低すぎる場合は更新しない（前回の位置を維持）
      if (!kp || kp.score < MIN_KEYPOINT_SCORE) {
        if (prevKp) {
          kp.x = prevKp.x;
          kp.y = prevKp.y;
          kp.score = prevKp.score; // スコアも維持
        }
        return;
      }

      // 前回のデータがない場合はそのまま
      if (!prevKp) return;

      // 部位ごとのAlpha値を決定
      let alpha = SMOOTH_ALPHA.torso;
      if (kp.name.includes('wrist')) {
        alpha = SMOOTH_ALPHA_HANDS; // 手首は強めのスムージングで飛びを抑える
      } else if (kp.name.includes('ankle') || kp.name.includes('eye') || kp.name.includes('ear') || kp.name.includes('nose')) {
        alpha = SMOOTH_ALPHA.extremities;
      } else if (kp.name.includes('knee') || kp.name.includes('elbow')) {
        alpha = SMOOTH_ALPHA.limbs;
      }

      // ★飛び防止: 移動距離が大きすぎる場合は制限する
      let dx = kp.x - prevKp.x;
      let dy = kp.y - prevKp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > MAX_JUMP_PIXELS) {
        // 移動制限: 指定ピクセル以上動こうとしたら、その方向へ MAX_JUMP_PIXELS 分だけ動かす
        const ratio = MAX_JUMP_PIXELS / dist;
        kp.x = prevKp.x + dx * ratio;
        kp.y = prevKp.y + dy * ratio;
        // 急激に飛んだときはスムージングをさらに強くしてバタつきを抑える
        alpha *= 0.5;
      }

      // 線形補間 (Low Pass Filter)
      kp.x = lerp(prevKp.x, kp.x, alpha);
      kp.y = lerp(prevKp.y, kp.y, alpha);
    });

    // 結果を保存
    smoothedPoses[p] = JSON.parse(JSON.stringify(raw));

    // 割り当て配列の中身も書き換える（これで描画や判定に使われる）
    players[p] = raw;
  }
}
// ----------------------

function getTargetPoses() {
  var standing = {
    left_shoulder: { x: -0.5, y: -0.35 },
    right_shoulder: { x: 0.5, y: -0.35 },
    left_elbow: { x: -0.6, y: -0.1 },
    right_elbow: { x: 0.6, y: -0.1 },
    left_wrist: { x: -0.55, y: 0.15 },
    right_wrist: { x: 0.55, y: 0.15 },
    left_hip: { x: -0.4, y: 0.25 },
    right_hip: { x: 0.4, y: 0.25 },
    left_knee: { x: -0.45, y: 0.6 },
    right_knee: { x: 0.45, y: 0.6 },
    left_ankle: { x: -0.45, y: 0.9 },
    right_ankle: { x: 0.45, y: 0.9 }
  };
  return [
    { id: 'right_hand_up', name: '右手を上げる', keypoints: { ...standing, right_elbow: { x: 0.5, y: -0.5 }, right_wrist: { x: 0.45, y: -0.75 } } },
    { id: 'left_hand_up', name: '左手を上げる', keypoints: { ...standing, left_elbow: { x: -0.5, y: -0.5 }, left_wrist: { x: -0.45, y: -0.75 } } },
    { id: 'both_hands_up', name: '両手を上げる', keypoints: { ...standing, left_elbow: { x: -0.5, y: -0.55 }, right_elbow: { x: 0.5, y: -0.55 }, left_wrist: { x: -0.5, y: -0.8 }, right_wrist: { x: 0.5, y: -0.8 } } },
    { id: 'y_pose', name: 'Yのポーズ', keypoints: { ...standing, left_elbow: { x: -0.55, y: -0.5 }, right_elbow: { x: 0.55, y: -0.5 }, left_wrist: { x: -0.7, y: -0.8 }, right_wrist: { x: 0.7, y: -0.8 } } },
    { id: 'hands_hips', name: '腰に手を当てる', keypoints: { ...standing, left_wrist: { x: -0.4, y: 0.2 }, right_wrist: { x: 0.4, y: 0.2 } } },
    { id: 'flamingo', name: '片足立ち', keypoints: { ...standing, right_knee: { x: 0.7, y: 0.4 }, right_ankle: { x: 0.7, y: 0.6 } } }, // 足のポーズ例
    { id: 'stand_neutral', name: '気をつけ', keypoints: standing }
  ];
}

var TARGET_POSES = getTargetPoses();

function keypointsToMap(keypoints) {
  var m = {};
  if (!keypoints) return m;
  for (var i = 0; i < keypoints.length; i++) {
    var k = keypoints[i];
    if (k && k.name) m[k.name] = { x: k.x, y: k.y, score: k.score != null ? k.score : 1 };
  }
  return m;
}

function normalizePose(keypointMap) {
  var leftS = keypointMap.left_shoulder;
  var rightS = keypointMap.right_shoulder;
  // 肩が見えていないと正規化できない
  if (!leftS || !rightS || leftS.score < MIN_KEYPOINT_SCORE || rightS.score < MIN_KEYPOINT_SCORE) return null;

  var cx = (leftS.x + rightS.x) / 2;
  var cy = (leftS.y + rightS.y) / 2;
  // 肩幅を基準にスケール
  var scale = Math.sqrt(Math.pow(rightS.x - leftS.x, 2) + Math.pow(rightS.y - leftS.y, 2)) || 1;

  var out = {};
  for (var name in keypointMap) {
    var k = keypointMap[name];
    if (k.score != null && k.score < MIN_KEYPOINT_SCORE) continue;
    out[name] = { x: (k.x - cx) / scale, y: (k.y - cy) / scale };
  }
  return out;
}

function getArmState(wristY, shoulderY, hipY) {
  var dy = wristY - shoulderY;
  var dyHip = Math.abs(wristY - hipY);
  if (dy < -0.12) return 'up';      // 手首が肩より0.12以上上
  if (dyHip < 0.06) return 'hips';  // 手首が腰の近く
  return 'down';
}

function poseSimilarity(normUser, targetKeypoints) {
  // 動かす部位（腕の状態）のみで厳密に判定。左右両方一致したときだけ合格
  if (!normUser || !targetKeypoints) return 0;
  var leftS = normUser.left_shoulder;
  var rightS = normUser.right_shoulder;
  var leftW = normUser.left_wrist;
  var rightW = normUser.right_wrist;
  var leftH = normUser.left_hip;
  var rightH = normUser.right_hip;
  if (!leftS || !rightS) return 0;

  var shoulderY = (leftS.y + rightS.y) / 2;
  var hipY = leftH && rightH ? (leftH.y + rightH.y) / 2 : shoulderY + 0.55;
  var leftArmUser = leftW ? getArmState(leftW.y, shoulderY, hipY) : 'down';
  var rightArmUser = rightW ? getArmState(rightW.y, shoulderY, hipY) : 'down';

  var tShoulderY = (targetKeypoints.left_shoulder.y + targetKeypoints.right_shoulder.y) / 2;
  var tHipY = (targetKeypoints.left_hip && targetKeypoints.right_hip) ? (targetKeypoints.left_hip.y + targetKeypoints.right_hip.y) / 2 : 0.25;
  var leftArmTarget = targetKeypoints.left_wrist ? getArmState(targetKeypoints.left_wrist.y, tShoulderY, tHipY) : 'down';
  var rightArmTarget = targetKeypoints.right_wrist ? getArmState(targetKeypoints.right_wrist.y, tShoulderY, tHipY) : 'down';

  var leftMatch = leftArmUser === leftArmTarget;
  var rightMatch = rightArmUser === rightArmTarget;
  if (!leftMatch || !rightMatch) return 0;
  return 1.0;
}

function drawTargetPose() {
  var ctx = targetCanvas.getContext('2d');
  var w = targetCanvas.width;
  var h = targetCanvas.height;
  ctx.clearRect(0, 0, w, h);
  var pose = TARGET_POSES[currentTargetIndex];
  if (!pose || !pose.keypoints) {
    targetNameEl.textContent = '-';
    return;
  }
  targetNameEl.textContent = pose.name;
  var kp = pose.keypoints;
  // 描画用のスケール計算
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (var name in kp) {
    var p = kp[name];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  var rangeX = (maxX - minX) || 1;
  var rangeY = (maxY - minY) || 1;
  var pad = 30;
  var scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  var cx = (minX + maxX) / 2;
  var cy = (minY + maxY) / 2;

  function toCanvas(x, y) {
    return { x: w / 2 + (x - cx) * scale, y: h / 2 + (y - cy) * scale };
  }

  ctx.strokeStyle = '#333';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // ボーン描画
  for (var i = 0; i < SKELETON_EDGES.length; i++) {
    var a = SKELETON_EDGES[i][0];
    var b = SKELETON_EDGES[i][1];
    if (!kp[a] || !kp[b]) continue;
    var p1 = toCanvas(kp[a].x, kp[a].y);
    var p2 = toCanvas(kp[b].x, kp[b].y);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  // 関節描画
  ctx.fillStyle = '#2196F3';
  for (var name in kp) {
    var p = toCanvas(kp[name].x, kp[name].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function updateScoreDisplays() {
  for (var i = 0; i < 4; i++) {
    var el = document.getElementById('score' + (i + 1));
    if (el) el.textContent = playerScores[i];
  }
}

function updateScoreCardVisibility() {
  for (var i = 0; i < 4; i++) {
    var card = document.querySelector('.scores .score-card:nth-child(' + (i + 1) + ')');
    if (card) card.style.display = i < maxPlayerCount ? '' : 'none';
  }
}

function initPlayerCountButtons() {
  [1, 2, 3, 4].forEach(function (n) {
    var btn = document.getElementById('players' + n);
    if (!btn) return;
    btn.addEventListener('click', function () {
      maxPlayerCount = n;
      document.querySelectorAll('.player-count button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      updateScoreCardVisibility();
      for (var i = 0; i < 4; i++) {
        if (i >= n) smoothedPoses[i] = null;
      }
    });
  });
  var btn4 = document.getElementById('players4');
  if (btn4) btn4.classList.add('active');
}

function assignPlayers(poses) {
  var assigned = [null, null, null, null];
  if (!poses || poses.length === 0) return assigned;

  var canvasWidth = overlayCanvas ? overlayCanvas.width : 640;

  // 生データ（カメラ座標系）のままで距離計算。反転は描画直前にのみ行う
  var posesWithIndex = poses.map(function(pose, idx) {
    var center = getPoseCenter(pose.keypoints);
    return { pose: pose, index: idx, centerX: center.x, centerY: center.y };
  });
  posesWithIndex.sort(function(a, b) { return a.centerX - b.centerX; });

  var slotOrder = [0, 1, 2, 3];
  slotOrder.sort(function(a, b) {
    var aHasPrev = lastPlayerPoses[a] != null;
    var bHasPrev = lastPlayerPoses[b] != null;
    if (aHasPrev && !bHasPrev) return -1;
    if (!aHasPrev && bHasPrev) return 1;
    return 0;
  });

  for (var si = 0; si < 4; si++) {
    var p = slotOrder[si];
    var prev = smoothedPoses[p];
    var prevPose = null;
    if (prev) prevPose = prev;

    var bestIdx = -1;
    var bestScore = -Infinity;

    for (var i = 0; i < posesWithIndex.length; i++) {
      if (posesWithIndex[i].assigned) continue;

      var currentPose = posesWithIndex[i].pose;
      var currentCenter = getPoseCenter(currentPose.keypoints);

      var dist;
      if (prevPose) {
        dist = poseDistance(prevPose, currentPose);
        // 1フレームで画面の1/3以上移動したら別人扱い（飛び跳ね防止）
        if (dist >= canvasWidth / 3) continue;
      } else {
        dist = Math.abs(currentCenter.x - (p * (canvasWidth / 4)));
      }

      var score = -dist;
      if (prevPose && dist < STICKY_DISTANCE_BONUS) {
        score += (STICKY_DISTANCE_BONUS - dist) * 1.5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      posesWithIndex[bestIdx].assigned = true;
      assigned[p] = posesWithIndex[bestIdx].pose;
    }
  }

  return assigned;
}

function getPoseCenter(keypoints) {
  // 肩の中点を中心とする（安定しているため）
  var leftS = keypoints.find(function (k) { return k.name === 'left_shoulder'; });
  var rightS = keypoints.find(function (k) { return k.name === 'right_shoulder'; });
  if (leftS && rightS) return { x: (leftS.x + rightS.x) / 2, y: (leftS.y + rightS.y) / 2 };

  // 肩がない場合は全体の重心
  var sumX = 0, sumY = 0, count = 0;
  keypoints.forEach(k => {
      if (k.score > MIN_KEYPOINT_SCORE) { sumX += k.x; sumY += k.y; count++; }
  });
  if (count > 0) return { x: sumX/count, y: sumY/count };
  return { x: 0, y: 0 };
}

function getPoseHands(keypoints) {
  var leftW = keypoints.find(function (k) { return k.name === 'left_wrist'; });
  var rightW = keypoints.find(function (k) { return k.name === 'right_wrist'; });
  var center = getPoseCenter(keypoints);
  var leftX = leftW && leftW.score >= MIN_KEYPOINT_SCORE ? leftW.x : center.x - 80;
  var leftY = leftW && leftW.score >= MIN_KEYPOINT_SCORE ? leftW.y : center.y;
  var rightX = rightW && rightW.score >= MIN_KEYPOINT_SCORE ? rightW.x : center.x + 80;
  var rightY = rightW && rightW.score >= MIN_KEYPOINT_SCORE ? rightW.y : center.y;
  return { left: { x: leftX, y: leftY }, right: { x: rightX, y: rightY } };
}

function poseDistance(poseA, poseB) {
  var centerA = getPoseCenter(poseA.keypoints);
  var centerB = getPoseCenter(poseB.keypoints);
  var distCenter = Math.hypot(centerA.x - centerB.x, centerA.y - centerB.y);
  var handsA = getPoseHands(poseA.keypoints);
  var handsB = getPoseHands(poseB.keypoints);
  var distLeft = Math.hypot(handsA.left.x - handsB.left.x, handsA.left.y - handsB.left.y);
  var distRight = Math.hypot(handsA.right.x - handsB.right.x, handsA.right.y - handsB.right.y);
  return distCenter * 0.4 + distLeft * 0.3 + distRight * 0.3;
}

function startBgm() {
  if (!bgmEl) return;
  bgmEl.src = BGM_PATH;
  bgmEl.play().catch(function (e) {
    console.warn('BGM playback failed:', e.message);
  });
}

function calculateMotion(prevPose, currentPose) {
  if (!prevPose || !currentPose || !prevPose.keypoints || !currentPose.keypoints) return 0;
  var totalMovement = 0;
  var count = 0;
  for (var i = 0; i < currentPose.keypoints.length; i++) {
    var currKp = currentPose.keypoints[i];
    if (currKp.score < MIN_KEYPOINT_SCORE) continue;
    var prevKp = prevPose.keypoints[i]; // インデックス対応前提
    if (!prevKp || prevKp.score < MIN_KEYPOINT_SCORE) continue;

    var dx = currKp.x - prevKp.x;
    var dy = currKp.y - prevKp.y;
    totalMovement += Math.sqrt(dx * dx + dy * dy);
    count++;
  }
  return count > 0 ? totalMovement / count : 0;
}

function initDifficultyButtons() {
  ['Easy', 'Normal', 'Hard'].forEach(function (label) {
    var id = 'diff' + label;
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', function () {
      currentDifficulty = label.toLowerCase();
      document.querySelectorAll('.difficulty button').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (!gameStarted) {
        gameStarted = true;
        startBgm();
      }
    });
  });
  var normalBtn = document.getElementById('diffNormal');
  if (normalBtn) normalBtn.classList.add('active');
}

function initNextPoseButton() {
  var btn = document.getElementById('nextPoseBtn');
  if (btn) btn.addEventListener('click', function () {
    currentTargetIndex = (currentTargetIndex + 1) % TARGET_POSES.length;
    drawTargetPose();
    for (var i = 0; i < 4; i++) lastJudgeResult[i] = null;
  });
}

async function init() {
  try {
    statusEl.textContent = 'モデル読み込み中...';
    try {
      // MoveNet: ガクガクしない、関節精度が高い、高速（PoseNetより推奨）
      var model = poseDetection.SupportedModels.MoveNet;
      // 複数人同時追跡: MultiPose.Lightning / 1人精度重視: SinglePose.Thunder
      var detectorConfig = {
        modelType: 'MultiPose.Lightning',
        enableSmoothing: true,
        enableTracking: true,
        minPoseScore: 0.15,
        multiPoseMaxDimension: 384
      };
      detector = await poseDetection.createDetector(model, detectorConfig);
    } catch (modelErr) {
      console.warn('MoveNet load failed, falling back to PoseNet:', modelErr.message);
      usePoseNet = true;
      var model = poseDetection.SupportedModels.PoseNet;
      detector = await poseDetection.createDetector(model, {
          quantBytes: 4,
          architecture: 'MobileNetV1',
          outputStride: 16,
          inputResolution: { width: 500, height: 500 },
          multiplier: 0.75
      });
    }

    var stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 }
    });
    video.srcObject = stream;

    video.onloadedmetadata = function () {
      video.play();
      video.width = video.videoWidth;
      video.height = video.videoHeight;
      overlayCanvas.width = video.videoWidth;
      overlayCanvas.height = video.videoHeight;

      statusEl.textContent = '準備完了。難易度を選んでスタート！';
      drawTargetPose();
      initPlayerCountButtons();
      updateScoreCardVisibility();
      initDifficultyButtons();
      initNextPoseButton();
      updateScoreDisplays();
      detect();
    };
  } catch (err) {
    statusEl.textContent = 'エラー: ' + err.message;
    console.error(err);
  }
}

// ★シンプルな棒人間デザイン設定
const STYLE = {
  leftColor: '#00FFFF',   // 左半身 (シアン)
  rightColor: '#FF00FF',  // 右半身 (マゼンタ)
  bodyColor: '#FFFFFF',   // 体幹 (白)
  lineWidth: 6,           // 線の太さ
  jointRadius: 5,         // 関節の大きさ
  headRadius: 25,         // 頭の大きさ

  // ラベル設定
  labelColor: '#FFFFFF',        // 文字色
  labelFont: 'bold 20px Arial', // フォント
  labelMargin: 15               // 頭のてっぺんからどれくらい離すか
};

function drawOverlay(assignedPoses) {
  try {
    var ctx = overlayCanvas.getContext('2d');
    if (!ctx) return;

    var w = overlayCanvas.width;
    var h = overlayCanvas.height;
    ctx.clearRect(0, 0, w, h);

    if (!assignedPoses) return;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowBlur = 0;

    for (var p = 0; p < maxPlayerCount; p++) {
      var pose = assignedPoses[p];
      // キーポイントがない、またはすべてスコア不足ならスキップ
      if (!pose || !pose.keypoints) continue;

      var kp = pose.keypoints;

      // 座標変換（鏡写し）
      // PoseNet(flipHorizontal): 既に反転済み→w-xで描画。MoveNet: カメラ座標→そのまま描画（overlayのscaleX(-1)で反転）
      var km = {};
      var validCount = 0;
      kp.forEach(function(k) {
        if (k.score > MIN_KEYPOINT_SCORE) {
          km[k.name] = usePoseNet ? { x: w - k.x, y: k.y } : { x: k.x, y: k.y };
          validCount++;
        }
      });

      if (validCount < 5) continue;

      // --- 描画ヘルパー ---
      function drawLine(p1, p2, color) {
        if (p1 && p2) {
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.strokeStyle = color;
          ctx.lineWidth = STYLE.lineWidth;
          ctx.stroke();
        }
      }

      function drawJoint(name, color) {
        if (km[name]) {
          ctx.beginPath();
          ctx.arc(km[name].x, km[name].y, STYLE.jointRadius, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
        }
      }

      function getMidPoint(p1, p2) {
        if (!p1 || !p2) return null;
        return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      }

      // --- 1. ボーン（骨組み） ---
      var shoulderCenter = getMidPoint(km['left_shoulder'], km['right_shoulder']);
      var hipCenter = getMidPoint(km['left_hip'], km['right_hip']);

      // 肩・腰の横線
      if (km['left_shoulder'] && km['right_shoulder']) drawLine(km['left_shoulder'], km['right_shoulder'], STYLE.bodyColor);
      if (km['left_hip'] && km['right_hip']) drawLine(km['left_hip'], km['right_hip'], STYLE.bodyColor);

      // 背骨
      if (shoulderCenter && hipCenter) {
        drawLine(shoulderCenter, hipCenter, STYLE.bodyColor);
      } else {
        if (km['left_shoulder'] && km['left_hip']) drawLine(km['left_shoulder'], km['left_hip'], STYLE.bodyColor);
        if (km['right_shoulder'] && km['right_hip']) drawLine(km['right_shoulder'], km['right_hip'], STYLE.bodyColor);
      }

      // 手足
      drawLine(km['left_shoulder'], km['left_elbow'], STYLE.leftColor);
      drawLine(km['left_elbow'], km['left_wrist'], STYLE.leftColor);
      drawLine(km['left_hip'], km['left_knee'], STYLE.leftColor);
      drawLine(km['left_knee'], km['left_ankle'], STYLE.leftColor);

      drawLine(km['right_shoulder'], km['right_elbow'], STYLE.rightColor);
      drawLine(km['right_elbow'], km['right_wrist'], STYLE.rightColor);
      drawLine(km['right_hip'], km['right_knee'], STYLE.rightColor);
      drawLine(km['right_knee'], km['right_ankle'], STYLE.rightColor);

      // --- 2. ジョイント ---
      ['left_shoulder', 'left_elbow', 'left_wrist', 'left_hip', 'left_knee', 'left_ankle']
        .forEach(function(n) { drawJoint(n, STYLE.leftColor); });

      ['right_shoulder', 'right_elbow', 'right_wrist', 'right_hip', 'right_knee', 'right_ankle']
        .forEach(function(n) { drawJoint(n, STYLE.rightColor); });


      // --- 3. 顔と情報表示 ---
      var faceParts = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
      var fx = 0, fy = 0, fCount = 0;
      faceParts.forEach(function(name) {
        if (km[name]) {
          fx += km[name].x;
          fy += km[name].y;
          fCount++;
        }
      });

      if (fCount === 0 && shoulderCenter) {
        fx = shoulderCenter.x;
        fy = shoulderCenter.y - 50;
        fCount = 1;
      }

      if (fCount > 0) {
        var faceX = fx / fCount;
        var faceY = fy / fCount;

        // 顔の円
        ctx.beginPath();
        ctx.arc(faceX, faceY, STYLE.headRadius, 0, Math.PI * 2);
        ctx.strokeStyle = STYLE.bodyColor;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fill();

        // ★ラベル表示（プレイヤー番号 + 一致率）
        ctx.fillStyle = STYLE.labelColor;
        ctx.font = STYLE.labelFont;
        ctx.textAlign = 'center';

        var similarity = pose.similarity || 0;
        var scorePercent = Math.floor(similarity * 100);
        var labelText = 'P' + (p + 1) + ' (' + scorePercent + '%)';

        var labelY = faceY - STYLE.headRadius - STYLE.labelMargin;
        var textHeight = 24;

        if (labelY < textHeight) {
          ctx.textBaseline = 'top';
          labelY = faceY + STYLE.headRadius + 10;
        } else {
          ctx.textBaseline = 'bottom';
        }

        // 合格表示：一致率85%以上で緑色
        if (scorePercent >= 85) {
            ctx.fillStyle = '#00FF00';
        } else {
            ctx.fillStyle = '#FFFFFF';
        }

        // overlayCanvas に transform: scaleX(-1) がかかっているため、文字を正面向きにする
        ctx.save();
        ctx.translate(faceX, labelY);
        ctx.scale(-1, 1);
        ctx.translate(-faceX, -labelY);
        ctx.fillText(labelText, faceX, labelY);
        ctx.restore();
      }
    }

  } catch (err) {
    console.error('drawOverlay error', err);
  }
}


async function detect() {
  try {
    window.detectionRunning = true;
    if (!detector) { requestAnimationFrame(detect); return; }

    // readyState チェックの緩和
    if (!video || video.readyState < 2) {
      requestAnimationFrame(detect);
      return;
    }

    // ビデオサイズが正しく取得できるまで待つ（座標計算の狂い防止）
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      requestAnimationFrame(detect);
      return;
    }

    var vw = video.videoWidth;
    var vh = video.videoHeight;

    if (video.width !== vw || video.height !== vh) {
        video.width = vw;
        video.height = vh;
    }

    if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
      overlayCanvas.width = vw;
      overlayCanvas.height = vh;
    }

    // MoveNet / PoseNet 共通の推論設定
    var estimationConfig = {
      maxPoses: maxPlayerCount,
      flipHorizontal: true
    };
    if (usePoseNet) {
      estimationConfig.scoreThreshold = 0.15;
    }

    window.poseDetectionCount++;
    var poses;
    try {
      poses = await detector.estimatePoses(video, estimationConfig);
    } catch (poseErr) {
      console.warn('estimatePoses error:', poseErr);
      requestAnimationFrame(detect);
      return;
    }

    if (!poses) poses = [];

    // ★割り当て処理
    var assigned = assignPlayers(poses);

    // ★スムージング処理（ここで座標を安定化させる）
    smoothPoses(poses, assigned);

    var target = TARGET_POSES[currentTargetIndex];
    var threshold = DIFFICULTY_THRESHOLD[currentDifficulty] || 0.85;
    var now = Date.now();

    for (var p = 0; p < maxPlayerCount; p++) {
      lastPlayerPoses[p] = assigned[p];
      lastJudgeResult[p] = null;

      if (!assigned[p]) continue;

      // 類似度計算（スムージング後の座標を使用）
      if (target && target.keypoints) {
        var userMap = keypointsToMap(assigned[p].keypoints);
        var normUser = normalizePose(userMap);
        var sim = poseSimilarity(normUser, target.keypoints);

        assigned[p].similarity = sim;

        if (sim >= threshold) {
          if (now >= playerCooldownUntil[p]) {
            playerScores[p]++;
            playerCooldownUntil[p] = now + COOLDOWN_MS;
            updateScoreDisplays();
          }
          lastJudgeResult[p] = true;
        } else {
          lastJudgeResult[p] = false;
        }
      }
    }

    drawOverlay(assigned);

    for (var p = 0; p < 4; p++) {
      if (assigned[p]) {
        previousPosePositions[p] = JSON.parse(JSON.stringify(assigned[p]));
      } else {
        previousPosePositions[p] = null;
      }
    }

  } catch (err) {
    console.error('detect error', err);
  }
  requestAnimationFrame(detect);
}

init();
