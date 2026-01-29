/**
 * ポーズ合わせゲーム
 * - 最大4人検出（PoseNet multi-pose）
 * - お題ポーズと一致でOK、不一致でX
 * - 難易度3段階、プレイヤー別トータル点数、BGM（music/bgm.mp3 に配置）
 */

const BGM_PATH = 'music/bgm.mp3';
const DIFFICULTY_THRESHOLD = { easy: 0.65, normal: 0.80, hard: 0.90 };
const COOLDOWN_MS = 2500;
const MIN_KEYPOINT_SCORE = 0.25;
const MOTION_THRESHOLD = 15;

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
  labelFont: 'bold 24px Arial', // フォント
  labelMargin: 15               // 頭のてっぺんからどれくらい離すか
};

const COCO_KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle'
];

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
let currentDifficulty = 'normal';
let currentTargetIndex = 0;
let playerScores = [0, 0, 0, 0];
let playerCooldownUntil = [0, 0, 0, 0];
let lastPlayerPoses = [null, null, null, null];
let lastJudgeResult = [null, null, null, null];
let gameStarted = false;
let previousPosePositions = [null, null, null, null];
let smoothedKeypoints = [null, null, null, null];
const SMOOTH_ALPHA = 0.88;

const video = document.getElementById('webcam');
const statusEl = document.getElementById('status');
const targetCanvas = document.getElementById('targetCanvas');
const targetNameEl = document.getElementById('targetName');
const overlayCanvas = document.getElementById('overlayCanvas');
const bgmEl = document.getElementById('bgm');

function getTargetPoses() {
  var shoulderW = 1.0;
  var cx = 0;
  var cy = 0;
  var standing = {
    left_shoulder: { x: -0.5, y: -0.35 },
    right_shoulder: { x: 0.5, y: -0.35 },
    left_elbow: { x: -0.6, y: -0.1 },
    right_elbow: { x: 0.6, y: -0.1 },
    left_wrist: { x: -0.55, y: 0.15 },
    right_wrist: { x: 0.55, y: 0.15 },
    left_hip: { x: -0.4, y: 0.25 },
    right_hip: { x: 0.4, y: 0.25 }
  };
  return [
    { id: 'right_hand_up', name: '右手を上げる', keypoints: { left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 }, left_elbow: { x: -0.55, y: -0.1 }, right_elbow: { x: 0.5, y: -0.5 }, left_wrist: { x: -0.5, y: 0.1 }, right_wrist: { x: 0.45, y: -0.75 }, left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 } } },
    { id: 'left_hand_up', name: '左手を上げる', keypoints: { left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 }, left_elbow: { x: -0.5, y: -0.5 }, right_elbow: { x: 0.55, y: -0.1 }, left_wrist: { x: -0.45, y: -0.75 }, right_wrist: { x: 0.5, y: 0.1 }, left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 } } },
    { id: 'both_hands_up', name: '両手を上げる', keypoints: { left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 }, left_elbow: { x: -0.5, y: -0.55 }, right_elbow: { x: 0.5, y: -0.55 }, left_wrist: { x: -0.5, y: -0.8 }, right_wrist: { x: 0.5, y: -0.8 }, left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 } } },
    { id: 'y_pose', name: 'Yのポーズ', keypoints: { left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 }, left_elbow: { x: -0.55, y: -0.5 }, right_elbow: { x: 0.55, y: -0.5 }, left_wrist: { x: -0.6, y: -0.75 }, right_wrist: { x: 0.6, y: -0.75 }, left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 } } },
    { id: 'hands_hips', name: '腰に手を当てる', keypoints: { left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 }, left_elbow: { x: -0.55, y: 0.05 }, right_elbow: { x: 0.55, y: 0.05 }, left_wrist: { x: -0.5, y: 0.2 }, right_wrist: { x: 0.5, y: 0.2 }, left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 } } },
    { id: 'stand_neutral', name: '立って手を下ろす', keypoints: standing }
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
  var leftH = keypointMap.left_hip;
  var rightH = keypointMap.right_hip;
  if (!leftS || !rightS || (leftS.score != null && leftS.score < MIN_KEYPOINT_SCORE) || (rightS.score != null && rightS.score < MIN_KEYPOINT_SCORE)) return null;
  var cx = (leftS.x + rightS.x) / 2;
  var cy = (leftS.y + rightS.y) / 2;
  var scale = Math.sqrt(Math.pow(rightS.x - leftS.x, 2) + Math.pow(rightS.y - leftS.y, 2)) || 1;
  var out = {};
  for (var name in keypointMap) {
    var k = keypointMap[name];
    if (k.score != null && k.score < MIN_KEYPOINT_SCORE) continue;
    out[name] = { x: (k.x - cx) / scale, y: (k.y - cy) / scale };
  }
  return out;
}

function poseSimilarity(normUser, targetKeypoints) {
  if (!normUser || !targetKeypoints) return 0;
  var sum = 0;
  var count = 0;
  for (var name in targetKeypoints) {
    if (!normUser[name]) continue;
    var tu = normUser[name];
    var tt = targetKeypoints[name];
    var dx = tu.x - tt.x;
    var dy = tu.y - tt.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    sum += Math.max(0, 1 - dist * 1.6);
    count++;
  }
  if (count === 0) return 0;
  return sum / count;
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
  var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (var name in kp) {
    var p = kp[name];
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  var rangeX = (maxX - minX) || 1;
  var rangeY = (maxY - minY) || 1;
  var pad = 20;
  var scale = Math.min((w - pad * 2) / rangeX, (h - pad * 2) / rangeY);
  var cx = (minX + maxX) / 2;
  var cy = (minY + maxY) / 2;
  function toCanvas(x, y) {
    return { x: w / 2 + (x - cx) * scale, y: h / 2 + (y - cy) * scale };
  }
  // スケルトンラインを描画（太め、滑らか、影付き）
  ctx.save();
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = '#2196F3';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
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
  ctx.restore();
  
  // キーポイント（関節）を描画（グラデーション、影付き）
  for (var name in kp) {
    var p = toCanvas(kp[name].x, kp[name].y);
    ctx.save();
    var gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 8);
    gradient.addColorStop(0, '#64b5f6');
    gradient.addColorStop(0.7, '#2196F3');
    gradient.addColorStop(1, '#1565c0');
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    
    // 内側の白い点
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function updateScoreDisplays() {
  for (var i = 0; i < 4; i++) {
    var el = document.getElementById('score' + (i + 1));
    if (el) el.textContent = playerScores[i];
  }
}

function assignPlayers(poses) {
  var now = Date.now();
  var assigned = [null, null, null, null];
  
  if (!poses || poses.length === 0) return assigned;
  
  // canvasの幅を取得（反転計算に必要）
  var canvasWidth = overlayCanvas ? overlayCanvas.width : 640; // デフォルト値
  
  // ポーズをx座標でソート（左から順に1P、2P...）
  // flipHorizontal: trueで既に反転されているため、drawOverlayと同じく w - x で反転後の座標を計算
  var posesWithIndex = poses.map(function(pose, idx) {
    var center = getPoseCenter(pose.keypoints);
    // 反転後の座標を計算（drawOverlayと同じ変換）
    var flippedX = canvasWidth - center.x;
    return { pose: pose, index: idx, centerX: flippedX };
  });
  posesWithIndex.sort(function(a, b) {
    return a.centerX - b.centerX; // x座標が小さい（左側）から順
  });
  
  // 前回のポーズがある場合は、前回のポーズに最も近いものを優先
  for (var p = 0; p < 4; p++) {
    var prev = lastPlayerPoses[p];
    var prevCenter = prev ? getPoseCenter(prev.keypoints) : null;
    // 前回のポーズも反転後の座標で計算
    if (prevCenter) {
      prevCenter = { x: canvasWidth - prevCenter.x, y: prevCenter.y };
    }
    
    var bestIdx = -1;
    var bestDist = Infinity;
    
    for (var i = 0; i < posesWithIndex.length; i++) {
      if (posesWithIndex[i].assigned) continue; // 既に割り当て済み
      
      var currentPose = posesWithIndex[i].pose;
      var currentCenter = getPoseCenter(currentPose.keypoints);
      // 現在のポーズも反転後の座標で計算
      var flippedCurrentX = canvasWidth - currentCenter.x;
      var flippedCurrentCenter = { x: flippedCurrentX, y: currentCenter.y };
      
      var dist;
      if (prevCenter) {
        // 前回のポーズがある場合は距離で判定（反転後の座標で）
        dist = Math.hypot(flippedCurrentCenter.x - prevCenter.x, flippedCurrentCenter.y - prevCenter.y);
      } else {
        // 前回のポーズがない場合は、x座標の順序で判定（反転後の座標で）
        dist = Math.abs(flippedCurrentX - (p * 200)); // 仮の位置
      }
      
      if (dist < bestDist) {
        bestDist = dist;
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
  var leftS = keypoints.find(function (k) { return k.name === 'left_shoulder'; });
  var rightS = keypoints.find(function (k) { return k.name === 'right_shoulder'; });
  if (leftS && rightS) return { x: (leftS.x + rightS.x) / 2, y: (leftS.y + rightS.y) / 2 };
  return { x: 0, y: 0 };
}

function startBgm() {
  if (!bgmEl) return;
  bgmEl.src = BGM_PATH;
  bgmEl.play().catch(function (e) {
    if (e && e.name !== 'NotAllowedError') console.warn('BGM playback failed:', e.message);
  });
}

function calculateMotion(prevPose, currentPose) {
  if (!prevPose || !currentPose || !prevPose.keypoints || !currentPose.keypoints) {
    return 0;
  }
  var totalMovement = 0;
  var count = 0;
  for (var i = 0; i < currentPose.keypoints.length; i++) {
    var currKp = currentPose.keypoints[i];
    if (!currKp || !currKp.score || currKp.score < MIN_KEYPOINT_SCORE) continue;
    var prevKp = prevPose.keypoints.find(function (k) { return k && k.name === currKp.name; });
    if (!prevKp || !prevKp.score || prevKp.score < MIN_KEYPOINT_SCORE) continue;
    var dx = currKp.x - prevKp.x;
    var dy = currKp.y - prevKp.y;
    totalMovement += Math.sqrt(dx * dx + dy * dy);
    count++;
  }
  return count > 0 ? totalMovement / count : 0;
}

function initDifficultyButtons() {
  ['Easy', 'Normal', 'Hard'].forEach(function (label, idx) {
    var id = 'diff' + label;
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', function () {
      currentDifficulty = label.toLowerCase();
      document.querySelectorAll('.difficulty button').forEach(function (b) { b.classList.remove('active'); });
      if (btn) btn.classList.add('active');
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
    var model = poseDetection.SupportedModels.PoseNet;
    detector = await poseDetection.createDetector(model);
    var stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
    video.onloadedmetadata = function () {
      video.play();
      
      // ビデオタグ自体にwidth/height属性を設定（TensorFlow.jsが正しくサイズを認識するために必須）
      video.width = video.videoWidth;
      video.height = video.videoHeight;
      
      overlayCanvas.width = video.videoWidth || 400;
      overlayCanvas.height = video.videoHeight || 300;
      console.log('カメラサイズ:', video.videoWidth, 'x', video.videoHeight);
      console.log('overlayCanvasサイズ:', overlayCanvas.width, 'x', overlayCanvas.height);
      statusEl.textContent = '準備完了。難易度を選んでポーズを合わせてね。';
      drawTargetPose();
      initDifficultyButtons();
      initNextPoseButton();
      updateScoreDisplays();
      detect();
    };
  } catch (err) {
    statusEl.textContent = 'エラー: ' + (err && err.message ? err.message : String(err));
  }
}

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

    for (var p = 0; p < assignedPoses.length; p++) {
      var pose = assignedPoses[p];
      if (!pose || !pose.keypoints) {
        smoothedKeypoints[p] = null;
        continue;
      }
      
      var kp = pose.keypoints;

      // 座標変換（鏡写し）
      var rawKm = {};
      var validCount = 0;
      kp.forEach(function(k) {
        if (k.score > MIN_KEYPOINT_SCORE) {
          rawKm[k.name] = { x: w - k.x, y: k.y };
          validCount++;
        }
      });

      if (validCount < 5) continue;

      // スムージング（ゆらぎ軽減）
      var prev = smoothedKeypoints[p];
      var km = {};
      for (var name in rawKm) {
        var raw = rawKm[name];
        if (prev && prev[name]) {
          km[name] = {
            x: prev[name].x * SMOOTH_ALPHA + raw.x * (1 - SMOOTH_ALPHA),
            y: prev[name].y * SMOOTH_ALPHA + raw.y * (1 - SMOOTH_ALPHA)
          };
        } else {
          km[name] = { x: raw.x, y: raw.y };
        }
      }
      smoothedKeypoints[p] = km;

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
      
      // 中点を計算するヘルパー
      function getMidPoint(p1, p2) {
        if (!p1 || !p2) return null;
        return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      }

      // --- 1. ボーン（骨組み） ---
      
      // ★胴体（背骨スタイルに変更）
      var shoulderCenter = getMidPoint(km['left_shoulder'], km['right_shoulder']);
      var hipCenter = getMidPoint(km['left_hip'], km['right_hip']);

      // 肩の横線
      if (km['left_shoulder'] && km['right_shoulder']) {
        drawLine(km['left_shoulder'], km['right_shoulder'], STYLE.bodyColor);
      }
      // 腰の横線
      if (km['left_hip'] && km['right_hip']) {
        drawLine(km['left_hip'], km['right_hip'], STYLE.bodyColor);
      }
      // 背骨（肩の中点 〜 腰の中点）
      if (shoulderCenter && hipCenter) {
        drawLine(shoulderCenter, hipCenter, STYLE.bodyColor);
      } else {
        // もし背骨が描けない場合（腰が見えてないなど）は、脇腹を描くフォールバック
        drawLine(km['left_shoulder'], km['left_hip'], STYLE.bodyColor);
        drawLine(km['right_shoulder'], km['right_hip'], STYLE.bodyColor);
      }

      // 左手足
      drawLine(km['left_shoulder'], km['left_elbow'], STYLE.leftColor);
      drawLine(km['left_elbow'], km['left_wrist'], STYLE.leftColor);
      drawLine(km['left_hip'], km['left_knee'], STYLE.leftColor);
      drawLine(km['left_knee'], km['left_ankle'], STYLE.leftColor);

      // 右手足
      drawLine(km['right_shoulder'], km['right_elbow'], STYLE.rightColor);
      drawLine(km['right_elbow'], km['right_wrist'], STYLE.rightColor);
      drawLine(km['right_hip'], km['right_knee'], STYLE.rightColor);
      drawLine(km['right_knee'], km['right_ankle'], STYLE.rightColor);

      // --- 2. ジョイント ---
      ['left_shoulder', 'left_elbow', 'left_wrist', 'left_hip', 'left_knee', 'left_ankle']
        .forEach(function(n) { drawJoint(n, STYLE.leftColor); });
      
      ['right_shoulder', 'right_elbow', 'right_wrist', 'right_hip', 'right_knee', 'right_ankle']
        .forEach(function(n) { drawJoint(n, STYLE.rightColor); });


      // --- 3. 顔とラベル ---
      var faceParts = ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'];
      var fx = 0, fy = 0, minFaceY = Infinity, fCount = 0;
      faceParts.forEach(function(name) {
        if (km[name]) {
          fx += km[name].x;
          fy += km[name].y;
          if (km[name].y < minFaceY) minFaceY = km[name].y;
          fCount++;
        }
      });

      // 顔が見つからない場合は肩の中点の上を使う
      if (fCount === 0 && shoulderCenter) {
        fx = shoulderCenter.x;
        fy = shoulderCenter.y - 50;
        minFaceY = shoulderCenter.y - 80;
        fCount = 1;
      }

      if (fCount > 0) {
        var faceX = fx / fCount;
        var faceY = fy / fCount;
        if (minFaceY === Infinity) minFaceY = faceY;

        // 顔の円
        ctx.beginPath();
        ctx.arc(faceX, faceY, STYLE.headRadius, 0, Math.PI * 2);
        ctx.strokeStyle = STYLE.bodyColor;
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fill();

        // ラベル：頭のてっぺんの上（顔キーポイントの最上部より上に配置）
        ctx.fillStyle = STYLE.labelColor;
        ctx.font = STYLE.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        var labelY = minFaceY - STYLE.headRadius - STYLE.labelMargin - 20;
        var textHeight = 24;
        if (labelY < textHeight) labelY = textHeight;

        ctx.save();
        ctx.translate(faceX, labelY);
        ctx.scale(-1, 1);
        ctx.translate(-faceX, -labelY);
        ctx.fillText('P' + (p + 1), faceX, labelY);
        ctx.restore();
      }
    }

  } catch (err) {
    console.error('drawOverlay error', err);
  }
}

window.detectionRunning = false;
window.poseDetectionCount = 0;
window.motionDetectionCount = 0;

async function detect() {
  try {
    window.detectionRunning = true;
    if (!detector) { requestAnimationFrame(detect); return; }
    if (!video || video.readyState < 2) {
      requestAnimationFrame(detect);
      return;
    }
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (vw === 0 || vh === 0 || !isFinite(vw) || !isFinite(vh)) {
      requestAnimationFrame(detect);
      return;
    }
    if (overlayCanvas.width !== vw || overlayCanvas.height !== vh) {
      overlayCanvas.width = vw;
      overlayCanvas.height = vh;
      console.log('overlayCanvasサイズを更新:', vw, 'x', vh);
    }
    var estimationConfig = {
      maxPoses: 4,
      flipHorizontal: true,
      scoreThreshold: 0.25
    };
    window.poseDetectionCount++;
    var poses;
    try {
      poses = await detector.estimatePoses(video, estimationConfig);
    } catch (poseErr) {
      if (poseErr && poseErr.message && poseErr.message.includes('roi width cannot be 0')) {
        console.warn('estimatePoses: ビデオサイズが無効です。', 'videoWidth:', video.videoWidth, 'videoHeight:', video.videoHeight, 'readyState:', video.readyState);
        requestAnimationFrame(detect);
        return;
      }
      throw poseErr;
    }
    if (!poses || !poses.length) {
      lastPlayerPoses = [null, null, null, null];
      drawOverlay(null);
      requestAnimationFrame(detect);
      return;
    }
    var assigned = assignPlayers(poses);
    var target = TARGET_POSES[currentTargetIndex];
    var threshold = DIFFICULTY_THRESHOLD[currentDifficulty] || 0.8;
    var now = Date.now();
    for (var p = 0; p < 4; p++) {
      lastPlayerPoses[p] = assigned[p];
      lastJudgeResult[p] = null;
      if (!assigned[p] || !target || !target.keypoints) continue;
      var userMap = keypointsToMap(assigned[p].keypoints);
      var normUser = normalizePose(userMap);
      var sim = poseSimilarity(normUser, target.keypoints);
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
      if (p === 0 && sim > 0) {
        console.log('P1 similarity:', sim.toFixed(3), 'threshold:', threshold.toFixed(3), 'match:', sim >= threshold);
      }
    }
    try {
      drawOverlay(assigned);
    } catch (drawErr) {
      console.error('drawOverlay呼び出しエラー', drawErr);
    }
    for (var p = 0; p < 4; p++) {
      if (assigned[p]) {
        previousPosePositions[p] = JSON.parse(JSON.stringify(assigned[p]));
      } else {
        previousPosePositions[p] = null;
      }
    }
  } catch (err) {
    if (err && err.message && err.message.includes('roi width cannot be 0')) {
      console.warn('detect: ビデオサイズが無効です。スキップします。', 'videoWidth:', video.videoWidth, 'videoHeight:', video.videoHeight);
    } else {
      console.error('detect error', err);
    }
  }
  requestAnimationFrame(detect);
}

init();
