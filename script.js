/**
 * ポーズ合わせゲーム (MoveNet MultiPose Lightning版)
 * * 改良点:
 * 1. MoveNet使用による認識精度と速度の向上
 * 2. 距離ベースのトラッキング（人が動いてもIDが入れ替わりにくい）
 * 3. 部位ごとの強力なスムージング処理
 * 4. 判定時の視覚エフェクト強化
 */

const BGM_PATH = 'music/bgm.mp3';

// 難易度ごとの判定しきい値（ポイントが入りやすいように調整）
const DIFFICULTY_THRESHOLD = { easy: 0.60, normal: 0.72, hard: 0.85 };

const CONFIG = {
    maxPlayers: 4,
    minScore: 0.3,       // これ以下の信頼度の関節は無視
    holdFrames: 5,       // OK判定を維持するフレーム数（5フレームで得点）
    cooldown: 2000,      // 得点後のクールダウン(ms)
    smoothAlpha: 0.5,    // 補間係数 (小さいほど滑らかだが遅れる)
    matchDist: 0.88      // スムージング用の重み
};

// スケルトンのデザイン
const STYLE = {
    lineColor: '#ffffff',
    lineWidth: 6,
    jointColor: '#2196F3',
    jointRadius: 6,
    matchColor: '#00FF00', // マッチした時の色
    font: 'bold 24px Arial'
};

// 関節の接続定義
const EDGES = [
    ['nose','left_eye'], ['nose','right_eye'], ['left_eye','left_ear'], ['right_eye','right_ear'],
    ['left_shoulder','right_shoulder'], ['left_shoulder','left_elbow'], ['left_elbow','left_wrist'],
    ['right_shoulder','right_elbow'], ['right_elbow','right_wrist'], ['left_shoulder','left_hip'],
    ['right_shoulder','right_hip'], ['left_hip','right_hip'], ['left_hip','left_knee'],
    ['left_knee','left_ankle'], ['right_hip','right_knee'], ['right_knee','right_ankle']
];

// グローバル変数
let detector = null;
let video = document.getElementById('webcam');
let overlay = document.getElementById('overlayCanvas');
let ctx = overlay.getContext('2d');
let targetCanvas = document.getElementById('targetCanvas');
let statusEl = document.getElementById('status');
let bgm = document.getElementById('bgm');
let loadingEl = document.getElementById('loading');

let state = {
    players: [],
    targetIndex: 0,
    difficulty: 'normal',
    maxPlayers: 4,
    isRunning: false,
    autoSwitch: false,
    autoSwitchInterval: 10000,
    autoSwitchTimerId: null
};

// 初期化（プレイヤースロット作成）
for (let i = 0; i < 4; i++) {
    state.players.push({
        id: i,
        keypoints: null,
        smoothed: null,
        matchCount: 0,
        score: 0,
        cooldownUntil: 0,
        assigned: false
    });
}

// ----------------------------------------------------------------------
// ターゲットポーズ定義
// ----------------------------------------------------------------------
function getTargetPoses() {
    const standing = {
        left_shoulder: { x: -0.5, y: -0.35 }, right_shoulder: { x: 0.5, y: -0.35 },
        left_elbow: { x: -0.6, y: -0.1 }, right_elbow: { x: 0.6, y: -0.1 },
        left_wrist: { x: -0.55, y: 0.15 }, right_wrist: { x: 0.55, y: 0.15 },
        left_hip: { x: -0.4, y: 0.25 }, right_hip: { x: 0.4, y: 0.25 }
    };
    return [
        { name: '右手を上げる', keypoints: { ...standing, right_elbow: { x: 0.5, y: -0.5 }, right_wrist: { x: 0.45, y: -0.75 } } },
        { name: '左手を上げる', keypoints: { ...standing, left_elbow: { x: -0.5, y: -0.5 }, left_wrist: { x: -0.45, y: -0.75 } } },
        { name: '両手を上げる', keypoints: { ...standing, left_elbow: { x: -0.5, y: -0.55 }, right_elbow: { x: 0.5, y: -0.55 }, left_wrist: { x: -0.5, y: -0.8 }, right_wrist: { x: 0.5, y: -0.8 } } },
        { name: 'Yのポーズ', keypoints: { ...standing, left_elbow: { x: -0.6, y: -0.5 }, right_elbow: { x: 0.6, y: -0.5 }, left_wrist: { x: -0.7, y: -0.8 }, right_wrist: { x: 0.7, y: -0.8 } } },
        { name: 'コマネチ', keypoints: { ...standing, left_wrist: { x: 0.1, y: 0.4 }, right_wrist: { x: -0.1, y: 0.4 }, left_elbow: { x: -0.6, y: 0.0 }, right_elbow: { x: 0.6, y: 0.0 } } },
        { name: '気をつけ', keypoints: standing }
    ];
}
const TARGET_POSES = getTargetPoses();

// ----------------------------------------------------------------------
// メイン処理
// ----------------------------------------------------------------------
async function init() {
    try {
        loadingEl.style.display = 'block';
        statusEl.textContent = 'TensorFlow.jsを初期化しています...';

        // TensorFlow.jsのバックエンドを初期化（WebGPUはWindowsで問題があるためWebGLを優先）
        if (typeof tf !== 'undefined') {
            try {
                await tf.setBackend('webgl');
            } catch (be) {
                console.warn('WebGL backend failed, using default:', be.message);
            }
            await tf.ready();
        }

        statusEl.textContent = 'MoveNetモデルを読み込んでいます...';

        // MoveNet MultiPose Lightning (高速・複数人対応)
        try {
            var model = poseDetection.SupportedModels.MoveNet;
            var modelType = (typeof poseDetection.movenet !== 'undefined' && poseDetection.movenet.modelType)
                ? poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING
                : 'MultiPose.Lightning';
            var detectorConfig = {
                modelType: modelType,
                enableSmoothing: true,
                enableTracking: true,
                minPoseScore: 0.25
            };
            detector = await poseDetection.createDetector(model, detectorConfig);
        } catch (modelErr) {
            console.warn('MoveNet load failed, falling back to PoseNet:', modelErr.message);
            var model = poseDetection.SupportedModels.PoseNet;
            detector = await poseDetection.createDetector(model, {
                architecture: 'MobileNetV1',
                outputStride: 16,
                inputResolution: { width: 500, height: 500 },
                multiplier: 0.75
            });
        }

        // カメラセットアップ
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
        });
        video.srcObject = stream;

        await new Promise(function (resolve) { video.onloadedmetadata = resolve; });
        video.play();

        // キャンバスサイズ合わせ
        video.width = video.videoWidth;
        video.height = video.videoHeight;
        overlay.width = video.videoWidth;
        overlay.height = video.videoHeight;

        loadingEl.style.display = 'none';
        statusEl.textContent = '準備完了！';

        state.isRunning = true;
        drawTargetPose();
        detectLoop();

        initUI();

        if (bgm) {
            fetch(BGM_PATH, { method: 'HEAD' }).then(function (res) {
                if (res.ok) {
                    bgm.src = BGM_PATH;
                    bgm.play().catch(function () {});
                }
            }).catch(function () {});
        }

    } catch (e) {
        loadingEl.style.display = 'none';
        statusEl.textContent = 'エラー: ' + e.message;
        console.error(e);
    }
}

// 検出ループ
async function detectLoop() {
    if (!state.isRunning) return;

    // 1. 推論実行
    var poses = [];
    if (detector && video.readyState >= 2) {
        try {
            poses = await detector.estimatePoses(video, {
                maxPoses: state.maxPlayers,
                flipHorizontal: true
            });
        } catch (e) {
            console.warn(e);
        }
    }

    // 2. プレイヤー割り当て (重要: IDを維持する処理)
    assignPosesToPlayers(poses);

    // 3. 判定と描画
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, 0, overlay.width, overlay.height);

    var now = Date.now();
    var target = TARGET_POSES[state.targetIndex];
    var threshold = DIFFICULTY_THRESHOLD[state.difficulty];

    for (var i = 0; i < state.maxPlayers; i++) {
        var p = state.players[i];

        if (!p.assigned || !p.smoothed) {
            p.matchCount = 0;
            continue;
        }

        var isMatch = false;
        var sim = 0;

        if (target) {
            var normUser = normalizePose(keypointsToMap(p.smoothed));
            sim = poseSimilarity(normUser, target.keypoints);
            isMatch = sim >= threshold;
        }

        if (isMatch) {
            p.matchCount++;
            if (p.matchCount >= CONFIG.holdFrames && now > p.cooldownUntil) {
                p.score++;
                p.cooldownUntil = now + CONFIG.cooldown;
                p.matchCount = 0;
                updateScoreUI(i);
            }
        } else {
            p.matchCount = Math.max(0, p.matchCount - 2);
        }

        var isCoolingDown = now < p.cooldownUntil;
        var baseColor = isMatch ? STYLE.matchColor : (isCoolingDown ? '#FFD700' : STYLE.jointColor);

        drawSkeleton(p.smoothed, baseColor, 'P' + (i + 1));
    }

    requestAnimationFrame(detectLoop);
}

// ----------------------------------------------------------------------
// プレイヤー割り当てロジック (トラッキングの肝)
// ----------------------------------------------------------------------
function assignPosesToPlayers(newPoses) {
    state.players.forEach(function (p) { p.assigned = false; });

    if (newPoses.length === 0) return;

    var sortedPoses = newPoses.map(function (pose) {
        return {
            pose: pose,
            center: getCenter(pose.keypoints),
            assignedTo: -1
        };
    });
    sortedPoses.sort(function (a, b) { return a.center.x - b.center.x; });

    var width = overlay.width;
    var MAX_DIST = width * 0.3;

    // 1. ID維持フェーズ
    state.players.forEach(function (player) {
        if (!player.smoothed) return;

        var prevCenter = getCenter(player.smoothed);
        var bestIdx = -1;
        var minDist = Infinity;

        for (var i = 0; i < sortedPoses.length; i++) {
            if (sortedPoses[i].assignedTo !== -1) continue;
            var dist = Math.hypot(sortedPoses[i].center.x - prevCenter.x, sortedPoses[i].center.y - prevCenter.y);

            if (dist < minDist && dist < MAX_DIST) {
                minDist = dist;
                bestIdx = i;
            }
        }

        if (bestIdx !== -1) {
            updatePlayerPose(player, sortedPoses[bestIdx].pose.keypoints);
            sortedPoses[bestIdx].assignedTo = player.id;
        }
    });

    // 2. 新規割り当てフェーズ
    for (var i = 0; i < sortedPoses.length; i++) {
        if (sortedPoses[i].assignedTo !== -1) continue;

        var targetSlot = state.players.find(function (p) { return !p.assigned; });
        if (targetSlot) {
            updatePlayerPose(targetSlot, sortedPoses[i].pose.keypoints);
        }
    }
}

function updatePlayerPose(player, rawKeypoints) {
    player.assigned = true;
    player.keypoints = rawKeypoints;

    if (!player.smoothed) {
        player.smoothed = rawKeypoints.map(function (kp) {
            return { x: kp.x, y: kp.y, score: kp.score, name: kp.name };
        });
    } else {
        player.smoothed = rawKeypoints.map(function (kp, idx) {
            var prev = player.smoothed[idx];
            var alpha = (kp.score > 0.6) ? CONFIG.smoothAlpha : 0.9;
            return {
                x: prev.x * alpha + kp.x * (1 - alpha),
                y: prev.y * alpha + kp.y * (1 - alpha),
                score: kp.score,
                name: kp.name
            };
        });
    }
}

function getCenter(keypoints) {
    var ls = keypoints.find(function (k) { return k.name === 'left_shoulder'; });
    var rs = keypoints.find(function (k) { return k.name === 'right_shoulder'; });
    if (ls && rs && ls.score > 0.2 && rs.score > 0.2) {
        return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    }
    var lh = keypoints.find(function (k) { return k.name === 'left_hip'; });
    var rh = keypoints.find(function (k) { return k.name === 'right_hip'; });
    if (lh && rh) {
        return { x: (lh.x + rh.x) / 2, y: (lh.y + rh.y) / 2 };
    }
    var sx = 0, sy = 0, c = 0;
    keypoints.forEach(function (k) {
        if (k.score > 0.3) { sx += k.x; sy += k.y; c++; }
    });
    return c > 0 ? { x: sx / c, y: sy / c } : { x: 0, y: 0 };
}

// ----------------------------------------------------------------------
// 描画関連
// ----------------------------------------------------------------------
function drawSkeleton(keypoints, color, label) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    var kpMap = {};
    keypoints.forEach(function (k) { kpMap[k.name] = k; });

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = STYLE.lineWidth;

    EDGES.forEach(function (edge) {
        var a = kpMap[edge[0]];
        var b = kpMap[edge[1]];
        if (a && b && a.score > CONFIG.minScore && b.score > CONFIG.minScore) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
        }
    });
    ctx.stroke();

    keypoints.forEach(function (k) {
        if (k.score > CONFIG.minScore) {
            ctx.beginPath();
            ctx.arc(k.x, k.y, STYLE.jointRadius, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    });

    var nose = kpMap['nose'];
    var ear = kpMap['left_ear'] || kpMap['right_ear'];
    var target = nose || ear || keypoints[0];

    if (target && target.score > CONFIG.minScore) {
        ctx.save();
        ctx.translate(target.x, target.y - 40);
        ctx.scale(-1, 1);
        ctx.fillStyle = STYLE.lineColor;
        ctx.font = STYLE.font;
        ctx.textAlign = 'center';
        ctx.fillText(label, 0, 0);
        ctx.restore();
    }
}

// ----------------------------------------------------------------------
// UI & ユーティリティ
// ----------------------------------------------------------------------
function initUI() {
    document.querySelectorAll('.player-count button').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            state.maxPlayers = parseInt(e.target.dataset.count, 10);
            document.querySelectorAll('.player-count button').forEach(function (b) { b.classList.remove('active'); });
            e.target.classList.add('active');

            for (var i = 1; i <= 4; i++) {
                var card = document.getElementById('card' + i);
                if (card) card.style.display = i <= state.maxPlayers ? '' : 'none';
            }
            state.players.forEach(function (p) { p.smoothed = null; p.matchCount = 0; });
        });
    });

    document.querySelectorAll('.difficulty button').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            state.difficulty = e.target.dataset.diff;
            document.querySelectorAll('.difficulty button').forEach(function (b) { b.classList.remove('active'); });
            e.target.classList.add('active');
            if (bgm.paused) bgm.play().catch(function () {});
        });
    });

    document.getElementById('nextPoseBtn').addEventListener('click', function () {
        state.targetIndex = (state.targetIndex + 1) % TARGET_POSES.length;
        drawTargetPose();
    });

    var autoSwitchBtn = document.getElementById('autoSwitchBtn');
    if (autoSwitchBtn) {
        autoSwitchBtn.addEventListener('click', function () {
            state.autoSwitch = !state.autoSwitch;
            if (state.autoSwitch) {
                if (state.autoSwitchTimerId) clearInterval(state.autoSwitchTimerId);
                state.autoSwitchTimerId = setInterval(function () {
                    state.targetIndex = (state.targetIndex + 1) % TARGET_POSES.length;
                    drawTargetPose();
                }, state.autoSwitchInterval);
                autoSwitchBtn.textContent = '自動切り替え ON (10秒)';
                autoSwitchBtn.classList.add('active');
            } else {
                if (state.autoSwitchTimerId) {
                    clearInterval(state.autoSwitchTimerId);
                    state.autoSwitchTimerId = null;
                }
                autoSwitchBtn.textContent = '自動切り替え OFF';
                autoSwitchBtn.classList.remove('active');
            }
        });
    }
}

function updateScoreUI(idx) {
    var el = document.getElementById('score' + (idx + 1));
    var card = document.getElementById('card' + (idx + 1));
    if (el) el.textContent = state.players[idx].score;
    if (card) {
        card.classList.add('active');
        setTimeout(function () { card.classList.remove('active'); }, 200);
    }
}

function keypointsToMap(kps) {
    var m = {};
    kps.forEach(function (k) { m[k.name] = k; });
    return m;
}

function normalizePose(km) {
    var ls = km.left_shoulder, rs = km.right_shoulder;
    if (!ls || !rs || ls.score < 0.3 || rs.score < 0.3) return null;

    var cx = (ls.x + rs.x) / 2;
    var cy = (ls.y + rs.y) / 2;
    var scale = Math.hypot(rs.x - ls.x, rs.y - ls.y) || 1;

    var out = {};
    for (var name in km) {
        if (km[name].score < 0.3) continue;
        out[name] = {
            x: (km[name].x - cx) / scale,
            y: (km[name].y - cy) / scale
        };
    }
    return out;
}

function getArmState(wristY, shoulderY, hipY) {
    var dy = wristY - shoulderY;
    var dyHip = Math.abs(wristY - hipY);
    if (dy < -0.12) return 'up';
    if (dyHip < 0.06) return 'hips';
    return 'down';
}

function poseSimilarity(user, target) {
    if (!user || !target) return 0;
    var leftS = user.left_shoulder;
    var rightS = user.right_shoulder;
    var leftW = user.left_wrist;
    var rightW = user.right_wrist;
    var leftH = user.left_hip;
    var rightH = user.right_hip;
    if (!leftS || !rightS) return 0;

    var shoulderY = (leftS.y + rightS.y) / 2;
    var hipY = (leftH && rightH) ? (leftH.y + rightH.y) / 2 : shoulderY + 0.55;
    var leftArmUser = leftW ? getArmState(leftW.y, shoulderY, hipY) : 'down';
    var rightArmUser = rightW ? getArmState(rightW.y, shoulderY, hipY) : 'down';

    var tShoulderY = (target.left_shoulder.y + target.right_shoulder.y) / 2;
    var tHipY = (target.left_hip && target.right_hip) ? (target.left_hip.y + target.right_hip.y) / 2 : 0.25;
    var leftArmTarget = target.left_wrist ? getArmState(target.left_wrist.y, tShoulderY, tHipY) : 'down';
    var rightArmTarget = target.right_wrist ? getArmState(target.right_wrist.y, tShoulderY, tHipY) : 'down';

    var leftMatch = leftArmUser === leftArmTarget;
    var rightMatch = rightArmUser === rightArmTarget;
    if (!leftMatch || !rightMatch) return 0;
    return 1.0;
}

function drawTargetPose() {
    var targetCtx = targetCanvas.getContext('2d');
    var w = targetCanvas.width;
    var h = targetCanvas.height;
    targetCtx.clearRect(0, 0, w, h);

    var pose = TARGET_POSES[state.targetIndex];
    document.getElementById('targetName').textContent = pose.name;

    var kps = pose.keypoints;
    targetCtx.strokeStyle = '#fff';
    targetCtx.lineWidth = 3;
    targetCtx.beginPath();

    var toScreen = function (p) {
        return { x: w / 2 + p.x * 60, y: h / 2 + p.y * 60 + 20 };
    };

    [
        ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
        ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
        ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip']
    ].forEach(function (edge) {
        if (kps[edge[0]] && kps[edge[1]]) {
            var p1 = toScreen(kps[edge[0]]);
            var p2 = toScreen(kps[edge[1]]);
            targetCtx.moveTo(p1.x, p1.y);
            targetCtx.lineTo(p2.x, p2.y);
        }
    });
    targetCtx.stroke();

    targetCtx.beginPath();
    targetCtx.arc(w / 2, h / 2 - 0.5 * 60 + 20, 10, 0, 2 * Math.PI);
    targetCtx.stroke();
}

init();
