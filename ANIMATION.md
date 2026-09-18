# 骨骼动画系统（原版 XSM 动画 + ALS 式混合）

本文档说明项目中角色动画的完整链路：**原版 `.xsm` 动画资产 → 离线烘焙 → 运行时播放/混合 → 游戏状态机**。

- 动画数据来源：`RPGproject/Characters/<id>/*.xsm`（EmotionFX 骨骼动画，游戏原始资产）
- 烘焙产物：`webapp/assets/chars/anims/*.json`
- 运行时播放器：`webapp/js/anim.js`
- 游戏侧接入：`webapp/js/main.js`
- 标定/回归工具：`webapp/tools/probe_*.js`、`tools/build_anims.py`

---

## 1. 总体结构

```
Characters/101/y09.xsm ─┐
Characters/101/y01.xsm ─┤  tools/build_anims.py        assets/chars/anims/idle.json
Characters/101/y02.xsm ─┼─────────────────────────▶    walk.json / run.json / sprint.json
Characters/101/fast.xsm─┤  解析 + 抽稀 + 标定           attack.json / jump.json
Characters/101/j01a.xsm─┤                              index.json
Characters/101/y04a.xsm─┘
                                    │
                                    ▼  fetch (boot 阶段预加载)
                        js/anim.js  AnimPlayer
                        ├─ 步态混合空间（idle/walk/run/sprint，按速度连续加权）
                        ├─ 共享步态相位 + 触地相位对齐
                        ├─ 步幅匹配播放速率（rate = speed / stride）
                        └─ 动作层（attack / jump 全身上覆）
                                    │
                                    ▼
                        js/main.js  updatePlayer()
                        速度平滑加减速 → 朝向 → ap.setSpeed(speed) → ap.update(dt)
```

角色仍由 `js/assets.js` 的 `makeChar()` 从 XAC 骨架 + 蒙皮网格构建（每实例独立骨架）；`makeChar` **不再**调用旧的过程化 `animateChar`，以保证 `AnimPlayer` 拿到的是纯净绑定姿态。

---

## 2. 资产管线：`tools/build_anims.py`

### 2.1 XSM 格式（已逆向）

```
file   : "XSM " + u8 major + u8 minor + u8 endian + u8 pad
chunk  : int32 type | int32 length | int32 version | data[length]
  0xC9 (v2)  运动元数据：float unused(=1.0), float fMaxAcceptableError, int32 fps,
             u8 exporterMajor, u8 exporterMinor, u8 pad[2],
             4×string(sourceApp / origFileName / exportDate / motionName)
  0xCA (v2)  骨骼动画主体
```

`0xCA` 数据体：

```
int32 numSubMotions
每个 sub-motion：
  4 × quat16   poseRot, bindPoseRot, poseScaleRot, bindPoseScaleRot   (4×8B = 32B)
  4 × vec3f    posePos, poseScale, bindPosePos, bindPoseScale         (4×12B = 48B)
  int32 × 4    numPosKeys, numRotKeys, numScaleKeys, numScaleRotKeys  (16B)
  float        fMaxError                                              (4B)
  string       nodeName (u32 长度 + 字符)          ← 至此 100B，随后是关键帧数组
  PosKey[numPosKeys]      vec3f pos;  float t
  RotKey[numRotKeys]      quat16 q;   float t
  ScaleKey / ScaleRotKey  （同上）
```

要点：
- `quat16` 各分量 `/ 32767` 得四元数（`xyzw`，与 XAC 骨架一致，可直接写 `bone.quaternion`）。
- 关键帧数组紧跟在 `nodeName` 之后，按 Pos → Rot → Scale → ScaleRot 顺序排列。
- 时间 `t` 单位为秒，30fps 采样（如 `y01` 时长 1.20s / 37 帧）。
- 单个文件含 200+ 条 sub-motion（含网格节点、IK 辅助骨骼等），只有约 90–130 条真正带旋转轨道。

`tools/probe_xsm.py` 是格式探针，可直接打印某文件的 sub-motion 列表：

```bash
python tools/probe_xsm.py ../Characters/101/y01.xsm
```

### 2.2 动画选型

选型依据是**时长 / 根骨骼位移 / 四肢摆幅**（`probe_xsm.py` 输出）：

| 用途 | 源文件 | 时长 | 特征 |
|---|---|---|---|
| `idle` | `y09.exported.xsm` | 2.67s | 几乎无位移，仅呼吸/重心微动 |
| `walk` | `y01.xsm` | 1.20s | 大腿摆幅 ~44°，重心起伏 4cm |
| `run` | `y02.xsm` | 0.80s | 大腿摆幅 58–76°，重心起伏 10cm |
| `sprint` | `fast.exported.xsm` | 0.47s | 摆幅最大、步频最高 |
| `attack` | `j01a.exported.xsm` | 1.33s | 剑法挥砍（j 系 = 剑招） |
| `jump` | `y04a.exported.xsm` | 0.67s | 起跳 |

> 角色目录里还有 `jxx`（剑招）、`zxx`（技能/位移）、`cxx`（剧情）等大量动画，如需扩展参照 §7。

### 2.3 烘焙与压缩

对每个 clip：

1. 只保留 `101.json` 中真实存在的骨骼名（自动过滤网格节点、IK 辅助骨）。
2. 剔除恒定旋转轨道（全帧与首帧夹角 < 0.4°）。
3. **关键帧抽稀**：贪心保留最远帧，使中间帧的线性插值误差 `< 0.35°`（旋转）/ `< 0.15cm`（位置）。
4. **循环无缝**：循环动画把末帧旋转强制对齐首帧；根骨骼 y 起伏按时间线性扣除首尾差，使 `y(0) == y(dur)`。
5. **根位移归一**：`Bip01` 位移动画只保留 y 起伏，x/z 归零（原地循环，水平位移交给游戏逻辑）。

压缩效果：1.7MB → **628KB**（6 个 clip）。

### 2.4 步幅 / 触地相位标定

两个额外输出字段，是"不打滑 + 不跳脚"的关键：

| 字段 | 含义 | 用途 |
|---|---|---|
| `stride` | 动画原生地面速度（m/s） | 播放速率 `rate = 实际速度 / stride` |
| `cphase` | 触地相位（0..1，触地点最低时对应的循环相位） | 多个步态共用一条腿部相位并按此对齐 |

**`stride` 求法**：在模型空间（角色原地播放）中找出"触地点（`Bip01 L/R Toe0`）贴地"的连续区间，取每个区间内
`触地点净后向位移 / 时长`（即支撑脚相对身体的后向速度），再取各区间的中位数。
该值就是动画的原生速度：以此速度播放时支撑脚在世界空间零漂移。

**权威值由真实渲染环境实测**（`tools/probe_stride.js`，three.js 实际数学），离线 FK 只作近似：

| clip | 离线 FK 估算 | 实测原生步速（采用） | cphase |
|---|---|---|---|
| walk | 1.11 | **1.05** | 0.812 |
| run | 3.42 | **4.18** | 0.531 |
| sprint | 6.04 | **6.33** | 0.536 |

偏差 >10% 时 `build_anims.py` 会打印 `[warn]` 并采用实测值（见 `VERIFIED_STRIDE` 表）。

```bash
python tools/build_anims.py          # 重新烘焙全部动画
```

---

## 3. 运行时：`js/anim.js`

### 3.1 加载

```js
import { loadAnims, AnimPlayer } from './anim.js';
G.anims = await loadAnims(['idle', 'walk', 'run', 'sprint', 'attack', 'jump']);
```

`loadAnim` 把 JSON 的 `r`/`p` 数组平铺成 `Float32Array`（`r` 每帧 5 个 float：`t,x,y,z,w`；`p` 每帧 4 个：`t,x,y,z`），
并缓存每个 clip 有旋转轨道的骨骼名列表 `names`（供性能优化用）。

### 3.2 `AnimPlayer` API

```js
const ap = new AnimPlayer(parts, clips);   // parts 来自 makeChar()
ap.setSpeed(v);                            // 每帧传入角色实际水平速度(m/s)，驱动步态混合空间
ap.playAction('attack', {                  // 播放全身上覆动作
  fadeIn: 0.05, fadeOut: 0.16, rate: 1.9,
  hold: false,                             // true = 停在末帧(跳跃)，需 releaseAction()
  eventAt: 0.3, onEvent: () => {},         // 可选：到点时回调（用于"出手帧"结算）
});
ap.releaseAction();                        // 释放 hold 动作（落地）
ap.update(dt);                             // 采样 + 混合 + 写回骨骼
```

### 3.3 步态混合空间（Locomotion Blend Space）

`setSpeed(v)` 不做离散切换，而是按下表锚点做 **smoothstep 连续加权**（最多同时激活 2 个 clip）：

| 锚点 | idle | walk | run | sprint |
|---|---|---|---|---|
| 速度 (m/s) | 0 | 1.05 | 4.2 | 6.3 |

锚点（`anchor`）与步幅（`stride`）**刻意分离**：锚点决定"谁占主导"，步幅只决定播放速率。
若两者绑定，在中间速度会把腿型差异很大的两段步态各掺一半，反而把脚抬离地面。

相位推进：

```
f = v / Σ(wᵢ · strideᵢ · durᵢ)        // 每秒循环数
phase += f · dt
每个步态 clip 采样时刻 = ((phase + cphaseᵢ) % 1) · durᵢ
```

该式的性质：**混合后支撑脚的落地速度 == 角色实际速度**（各 clip 的速率差被加权平均抵消），
因此任意速度下都不打滑；且所有步态共用 `phase`，切换时腿部动作连续、不会跳帧。
待机单独走自己的时间轴（`tIdle`，自然速率），参与同一套加权混合，因此 idle↔走跑的过渡也是连续的。

### 3.4 动作层（Action Layer）

攻击/跳跃是"全身上覆"动作，与步态层解耦：

```
状态机：in（淡入） → hold（播放；非 hold 动作在末尾 fadeOut 前转入 out） → out（淡出）
最终姿态 = slerp(步态混合结果, 动作姿态, actionW)
根骨骼 y = lerp(步态 y, 动作 y, actionW)
```

- 动作里没有轨道的骨骼保留步态结果，因此攻击时下肢仍可自然摆动。
- `hold: true`（跳跃）会停在末帧，落地时 `releaseAction()` 淡出，避免落地瞬间跳变。

### 3.5 性能

每帧只遍历"当前生效 clip 里有旋转轨道"的骨骼（通常 ~110 根），其余骨骼走第 6 步的
"上一帧驱动过、本帧不再驱动 → 恢复绑定姿态" 逻辑，避免全量 235 根骨骼的无谓写入。

---

## 4. 游戏侧接入：`js/main.js`

### 4.1 速度与加减速

```js
const MOVE_SPEED   = 4.2;   // = run 动画原生步速，速率 1.0
const SPRINT_SPEED = 6.3;   // = sprint 动画原生步速，速率 1.0
const accel = (p.grounded ? (target > p.speed ? 11 : 13) : 5) * dt;   // m/s²
```

速度不是瞬时到顶，而是平滑逼近目标值；由于播放速率与混合权重都跟随 `p.speed`，
**加减速全过程脚的落地速度都与位移匹配**，起步/收步不滑步。

### 4.2 每帧调用

```js
ap.setSpeed(p.speed);
ap.update(dt);
```

NPC 同理，但恒为 `setSpeed(0)`（即播放 idle 循环）。

### 4.3 动作触发

```js
// 跳跃（起跳时）
p.ap.playAction('jump', { fadeIn: 0.06, fadeOut: 0.18, rate: 1.1, hold: true });
// 落地时
p.ap.releaseAction();

// 攻击（tryAttack 内）
p.ap.playAction('attack', { fadeIn: 0.05, fadeOut: 0.16, rate: ranged ? 1.5 : 1.9 });
```

### 4.4 朝向约定（重要）

**原版模型的视觉前方是局部 −Z**（已用相机对照截图验证：相机置于角色 +Z 侧看到背面，置于 −Z 侧看到正脸）。
因此所有与"前方"相关的计算都要按 −Z 处理：

| 位置 | 写法 |
|---|---|
| 转向移动方向 | `p.yawFace = Math.atan2(-_f.x, -_f.z)` |
| 攻击命中前向 | `fwd = new V3(-sin(yaw), 0, -cos(yaw))` |
| 攻击自动面向目标 | `rotation.y = Math.atan2(-t.x, -t.z)` |
| NPC 面朝出生点 | `rotation.y = Math.atan2(bx - sx, bz - sz)` |
| 身体倾斜（`rotation.x` 前倾 / `rotation.z` 内倾） | 前倾取负、侧倾与偏航速率同号 |

同时 `p.obj.rotation.order = 'YXZ'`，保证俯仰/侧倾发生在角色自身坐标系内。

若这里搞反（把局部 +Z 当正前方），会出现两个连锁症状：角色**背对行进方向行走**，且支撑脚相对地面
**打滑 2 倍速度**（实测滑步率 204%）。

### 4.5 控制方向

移动映射为"屏幕语义"：`W` 朝屏幕内（远离相机）、`D` 朝屏幕右、`A/S` 同理：

```js
const a = Math.atan2(-ix, -iz);
const dir = G.yaw + a;               // 相机在角色身后，前后/左右都与屏幕一致
```

### 4.6 身体倾斜（ALS lean）

```js
leanA：随加速度平滑变化（前倾，±0.12 rad）
leanT：随偏航速率平滑变化（向弯道内侧倾，±0.12 rad）
空中衰减到 40%
```

数值很小、时间常数 ~0.25s，只做"动态感"的补充。

---

## 5. 关键约定与坑

| 事项 | 说明 |
|---|---|
| 模型前方 | 局部 **−Z**，见 §4.4 |
| 动画方向 | 步态动画按"角色朝 −Z 前进"制作；`stride` 取支撑脚相对身体的 +Z（后向）速度 |
| 单位 | 骨骼/模型空间为**厘米**，`group.scale = 0.01`，故世界单位 = 米（1 cm = 0.01 m） |
| 各动画地面参考不统一 | 走路脚趾最低约 3–5cm、跑步约 0、冲刺约 0 —— 触地判定必须**相对各自最低点**取窄带，不能用绝对高度 |
| 跑步/冲刺为前掌落地 | 踝关节最低点 **不等于** 支撑期（跑步的踝最低点出现在快速前摆时）；触地判定必须用 `Toe0` 骨 |
| 脚掌滚动 | 支撑期踝关节会滚动，踝速度 ≠ 触地速度，故步幅必须用 `Toe0` 轨迹求 |
| Y 起伏 | 只取 `Bip01` 位置轨道的 y 分量，叠加到绑定位置上；x/z 已归零 |
| 绑定姿态基准 | `makeChar()` 内部不再摆任何默认姿势，`AnimPlayer` 用构造时的骨骼姿态作为回退基准 |

---

## 6. 实测结果与回归工具

### 6.1 滑步实测（触地区间内支撑脚沿行进方向的净漂移）

| 状态 | 速度 (m/s) | 单次触地漂移 | 等效滑步 |
|---|---|---|---|
| 走路 | 1.05 | 0.005–0.05 m / 0.45–0.5s | 1–12% |
| **常规移动（跑）** | 4.2 | 0.010 m / 0.133s | **2%** |
| **冲刺** | 6.3 | 0.000–0.017 m / 0.13s | **0–1%** |
| 走→跑过渡 | 2.0 | 0.009–0.032 m | 5–8% |
| 低速过渡 | 0.8 | 0.03–0.06 m / 0.3–0.7s | ~10% |

（改造前：方向反了导致滑步率 ~204%。）

### 6.2 工具清单

启动本地服务后运行（默认端口 8471）：`python server.py 8471`

| 工具 | 作用 |
|---|---|
| `tools/probe_xsm.py <file>` | 打印 XSM 结构 / 骨骼轨道（纯 Python，无需浏览器） |
| `tools/build_anims.py` | 烘焙全部动画资产（重建 `assets/chars/anims/*`） |
| `tools/probe_stride.js` | **反求动画原生步速**（速率=1.0 下触地点相对速度），是 `stride` 权威值的来源 |
| `tools/probe_contact.js` | **滑步回归**：测每次触地的净漂移；改动动画/速度后必跑 |
| `tools/probe_dir.js` | 校验按 W 时角色是否远离相机（相机在身后） |
| `tools/probe_face.js` | 校验模型视觉朝向（+Z/−Z 侧各截一张图） |
| `tools/probe_combat.js` | 攻击判定方向回归（身前怪物是否掉血） |
| `tools/shot_anim.js` | 待机/走/跑/冲刺/攻击/跳跃逐状态截图 |

---

## 7. 扩展指南

### 7.1 增加新动画

1. 在 `tools/build_anims.py` 的 `ANIMS` 字典加一项：`'名称': ('101', '文件.xsm', 是否循环)`；
   若为移动类动画，同时加入 `GAITS`（会标定 stride/cphase）。
2. 运行 `python tools/build_anims.py`，再用 `tools/probe_stride.js` 实测原生步速并回填 `VERIFIED_STRIDE`。
3. `js/main.js` 的 `loadAnims([...])` 列表里加上名称。
4. 若要作为步态使用，在 `js/anim.js` 的 `anchors` 里给出混合锚点速度；若作为动作使用，直接 `playAction`。

### 7.2 调整移动手感

只改 `js/main.js` 顶部的 `MOVE_SPEED` / `SPRINT_SPEED` 与 `js/anim.js` 的 `anchors`：

- 想更快：提高速度会按比例提高播放速率（跑得"更急"），滑步率基本不变（与速度成正比的固有比例）。
- 要"零滑步的绝对观感"：把速度设成对应 clip 的 `stride`（速率 1.0）。

### 7.3 其他角色

所有角色共用 Bip01 骨架命名，因此同一套动画数据可直接给 102–107 使用；
缺失轨道的骨骼自动回落到各自绑定姿态。攻击动作目前统一使用 101 的剑法，如需差异化，
为对应角色目录另行烘焙一份动画并在 `AnimPlayer` 构造时传入不同的 `clips`。

---

## 8. 已知限制

1. **动画固有滑步比例**：走路 ~1–12%、跑/冲刺 ~0–2% 的漂移是原始资产自身的容差，无法用静态速率完全消除
   （除非引入脚部 IK/足锁）。当前水平已达到"肉眼基本不可辨"。
2. **横向漂移**：跑步触地期脚会横向滚动约 6–12cm（原始动画的落脚姿态），属正常现象，不影响行进方向观感。
3. **游泳**：仍复用步态动画（速度压到 55%），没有专属泳姿；若日后找到原版泳姿文件可替换。
4. **无脚部 IK**：坡度/台阶上不做脚底贴合，靠地形高度采样 + 平滑过渡掩盖。
5. **旧的过程化 `animateChar`** 仍保留在 `js/assets.js`（当前无调用方），作为无动画资产时的兜底参考。
