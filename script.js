/**
 * ポーズ合わせゲーム
 * - 最大4人検出（PoseNet multi-pose）
 * - お題ポーズと一致でOK、不一致でX
 * - 難易度3段階、プレイヤー別トータル点数、BGM（music/bgm.mp3 に配置）
 */

const BGM_PATH = 'music/bgm.mp3';
const DIFFICULTY_THRESHOLD = { easy: 0.40, normal: 0.50, hard: 0.60 };
const COOLDOWN_MS = 2500;
const MIN_KEYPOINT_SCORE = 0.25;
const PHOTO_COOLDOWN_MS = 3000;
const MIN_POSE_SCORE_FOR_PHOTO = 0.5;

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
let lastPhotoTime = 0;
let photoCanvas = null;

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
    sum += Math.max(0, 1 - dist * 0.8);
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
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 2;
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
  ctx.fillStyle = '#2196F3';
  for (var name in kp) {
    var p = toCanvas(kp[name].x, kp[name].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
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
  var assigned = [];
  var used = {};
  for (var p = 0; p < 4; p++) {
    var bestIdx = -1;
    var bestDist = Infinity;
    var prev = lastPlayerPoses[p];
    var prevCenter = prev ? getPoseCenter(prev.keypoints) : null;
    for (var i = 0; i < poses.length; i++) {
      if (used[i]) continue;
      var kp = poses[i].keypoints;
      var center = getPoseCenter(kp);
      var dist = prevCenter ? Math.hypot(center.x - prevCenter.x, center.y - prevCenter.y) : i;
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      used[bestIdx] = true;
      assigned[p] = poses[bestIdx];
    } else {
      assigned[p] = null;
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

function takePhoto() {
  var now = Date.now();
  if (now - lastPhotoTime < PHOTO_COOLDOWN_MS) return;
  if (!photoCanvas) {
    photoCanvas = document.createElement('canvas');
    photoCanvas.width = video.videoWidth || 400;
    photoCanvas.height = video.videoHeight || 300;
  }
  var ctx = photoCanvas.getContext('2d');
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -photoCanvas.width, 0, photoCanvas.width, photoCanvas.height);
  ctx.restore();
  photoCanvas.toBlob(function (blob) {
    if (!blob) return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'pose_' + new Date().toISOString().replace(/[:.]/g, '-') + '.jpg';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    lastPhotoTime = now;
  }, 'image/jpeg', 0.9);
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
  var ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!assignedPoses) return;
  var w = overlayCanvas.width;
  var h = overlayCanvas.height;
  for (var p = 0; p < assignedPoses.length; p++) {
    var pose = assignedPoses[p];
    if (!pose || !pose.keypoints) continue;
    var kp = pose.keypoints;
    var leftS = kp.find(function (k) { return k.name === 'left_shoulder'; });
    var rightS = kp.find(function (k) { return k.name === 'right_shoulder'; });
    var leftH = kp.find(function (k) { return k.name === 'left_hip'; });
    var rightH = kp.find(function (k) { return k.name === 'right_hip'; });
    if (!leftS || !rightS) continue;
    var minX = Math.min(leftS.x, rightS.x);
    var maxX = Math.max(leftS.x, rightS.x);
    var centerX = (minX + maxX) / 2;
    var minY = (leftS.y + rightS.y) / 2;
    if (leftH && rightH) minY = Math.min(minY, leftH.y, rightH.y);
    var boxH = 80;
    var boxY = Math.max(0, minY - boxH - 10);
    var boxX = w - centerX + 40;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(boxX, boxY, 80, boxH);
    ctx.fillStyle = '#fff';
    ctx.font = '14px Arial';
    ctx.fillText('P' + (p + 1), boxX + 4, boxY + 18);
    ctx.fillText('' + playerScores[p], boxX + 4, boxY + 36);
    var result = lastJudgeResult[p];
    if (result === true) {
      ctx.fillStyle = '#4CAF50';
      ctx.fillText('OK', boxX + 4, boxY + 54);
    } else if (result === false) {
      ctx.fillStyle = '#f44336';
      ctx.fillText('X', boxX + 4, boxY + 54);
    }
  }
}

async function detect() {
  try {
    if (!detector) { requestAnimationFrame(detect); return; }
    var estimationConfig = { maxPoses: 4, flipHorizontal: true };
    var poses = await detector.estimatePoses(video, estimationConfig);
    if (!poses || !poses.length) {
      lastPlayerPoses = [null, null, null, null];
      drawOverlay(null);
      requestAnimationFrame(detect);
      return;
    }
    var hasValidPose = false;
    for (var i = 0; i < poses.length; i++) {
      var pose = poses[i];
      var keypoints = pose.keypoints || [];
      var validKeypointCount = 0;
      for (var j = 0; j < keypoints.length; j++) {
        var kp = keypoints[j];
        if (kp && kp.score && kp.score >= MIN_KEYPOINT_SCORE) {
          validKeypointCount++;
        }
      }
      if (validKeypointCount >= 8) {
        hasValidPose = true;
        break;
      }
    }
    if (hasValidPose) {
      takePhoto();
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
    }
    drawOverlay(assigned);
  } catch (err) {
    console.error('detect error', err);
  }
  requestAnimationFrame(detect);
}

init();
