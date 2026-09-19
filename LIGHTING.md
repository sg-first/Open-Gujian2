# 光照管线文档

本文档说明项目中光照与画质管线。目标是在浏览器里逼近 UE4 级别的画面：
**ACES 色调映射 + PCSS 软阴影 + IBL 全局光照 + GTAO + Bloom + 昼夜系统**。

涉及文件：

| 文件 | 职责 |
|---|---|
| `js/main.js` | 渲染器/后处理链/光源/昼夜/IBL 刷新/地表材质 |
| `js/pcss.js` | 运行时改写 ShaderChunk，把 PCF 阴影替换为 PCSS 软阴影 |
| `js/world.js` | 地表分块/植被/水面/天空 ShaderMaterial |
| `js/env.js` | 解析原版 `vscene`，输出各时段光照/雾/天空关键帧 |

---

## 1. 渲染器基线（main.js `initScene`）

```js
G.renderer.outputColorSpace = THREE.SRGBColorSpace;
G.renderer.toneMapping = THREE.ACESFilmicToneMapping;   // UE4 同款
G.renderer.toneMappingExposure = 1.15;
G.renderer.shadowMap.enabled = true;
G.renderer.shadowMap.type = THREE.PCFSoftShadowMap;      // 实际由 pcss.js 接管
G.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
```

要点：

- `antialias: false` —— 抗锯齿交给后处理链的 **MSAA 4x 渲染目标 + FXAA**（见 §6），
  不用 canvas 内建 MSAA（后处理会丢弃它）。
- `toneMapping` 设在 renderer 上，但**真正的 ACES 映射发生在 `OutputPass`**（§6），
  renderer 上的设置只是让 OutputPass 读取到正确参数。
- `setPixelRatio` 上限 1.5：高 DPI 屏（如 3x retina）全分辨率跑 GTAO+Bloom 代价过高。

---

## 2. 光源体系

| 光源 | 类型 | 强度 | 作用 |
|---|---|---|---|
| `G.sun` | `DirectionalLight` | 昼夜插值，白天峰值 ≈4.2 | 太阳直射 + 阴影 |
| `G.hemi` | `HemisphereLight` | 0.15~0.68 | 天空色/地面色兜底，颜色取自 vscene 的 dif/amb |
| `G.ambient` | `AmbientLight` | 0.35 固定 | IBL 之外的最后一道兜底，**刻意压低** |

IBL（§4）建立后，环境光贡献主要来自 `scene.environment`，
Ambient/Hemisphere 只补 IBL 刷新间隔内的暗部，强度过高会冲淡 GI 立体感。

### 阴影相机跟随玩家

```js
sc.near = 10; sc.far = 900;
sc.left = -90; sc.right = 90; sc.top = 90; sc.bottom = -90;   // 贴身 180m 视锥
G.sun.shadow.mapSize.set(2048, 2048);
G.sun.shadow.bias = -0.0006;
G.sun.shadow.normalBias = 0.35;   // 过大会在清晨侧光时造成大片地形错误自阴影
G.sun.shadow.radius = 6;          // PCSS 基础搜索/过滤尺度
```

每帧 `updateSunShadow()` 把阴影相机锚定在玩家位置：光源放在
`玩家位置 + sunDir * 380`，target 指向玩家。**180m 贴身视锥**保证 2048 贴图
对近景足够锐利（≈9cm/texel），远景靠雾遮掩阴影缺失。

---

## 3. PCSS 软阴影（pcss.js）

three.js 内置 PCF 的阴影边缘硬度恒定；PCSS（Percentage-Closer Soft Shadows）
与 UE4 默认行为一致：**接触点锐利，离遮挡物越远越宽越软**。

实现方式是运行时补丁（必须在任何材质首次编译前 import，靠副作用生效）：

1. 在 `THREE.ShaderChunk.shadowmap_pars_fragment` 的 `texture2DCompare`
   函数后插入 PCSS 的 GLSL（16 点泊松盘 + 9 次遮挡搜索 + 16 次 PCF 过滤）。
2. 把 `SHADOWMAP_TYPE_PCF_SOFT` 分支的采样替换为 `PCSS(...)`，原分支挪到
   `PCF_SOFT_DISABLED` 保留。
3. 用精确锚点字符串匹配，锚不到就保持原样降级为普通 PCF，并 console.warn。

算法三步：

```
1) Blocker search  : 在 shadowRadius*5 texel 邻域采样 9 点，求遮挡物平均深度
2) Penumbra width  : ratio = (zReceiver - zBlocker) / zBlocker → 半影宽度（接触点为 0）
3) PCF filter      : 用半影宽度缩放泊松盘半径，16 点比较采样求平均
```

开销：每像素每光源 ≈25 次阴影贴图采样（只有一盏投影光源，可接受）。

---

## 4. IBL 全局光照（SkyLight 等效）

```js
G.pmrem = new THREE.PMREMGenerator(G.renderer);
G.envScene.add(new THREE.Mesh(G.sky.mesh.geometry, G.sky.mat));  // 程序化天空入环境
// 地图含水域时再放一个绿色地面反照球（y=-5600, BackSide），提供地面反弹
G.envRT = G.pmrem.fromScene(G.envScene, 0.04, 10, 12000);
G.scene.environment = G.envRT.texture;
```

- 等效 UE4 的 **SkyLight**：所有 `MeshStandardMaterial` 的间接漫反射/镜面反射
  都来自这张 PMREM 立方体图——包括地形、植被、角色、建筑。
- **刷新节流**：一昼夜 10 分钟，IBL **每 12 秒重建一次**（≈2.9 游戏小时），
  天色渐变肉眼平滑。严禁每帧重建——清晨太阳移动快时会绕过节流压垮渲染。
  旧 RT 及时 `dispose()`。
- 刷新入口在 `updateDayNight()` 末尾的 `updateEnvironmentIBL(dt)`。

---

## 5. 昼夜系统（`updateDayNight`）

光照/雾/天空全部由原版 `vscene` 的 4 个时段关键帧（5/9/15/20 点）插值驱动，
每张地图有各自参数，不同区域天色不同。硬编码配色仅作 vscene 缺失时的 fallback。

- **太阳**：方位/高度来自原版水面材质的 `sunDirection`；
  `intensity` 由 `SunLum`、昼夜系数、太阳高度共同钳制（峰值 4.2）。
- **Hemisphere**：color ← vscene 的 dif，groundColor ← amb×0.8。
- **雾**：`FogColor × FogColorMultiplier`，但朝天空底色 lerp 0.45——
  原版雾色按 HDR 调的，直接用会把远景压成深色块，让地平线接不上。
  `near/far` 由 `FogIntensity` 推导，雾色同时用作 `setClearColor`。
- **天空**：`FilterTop/Middle/BottomColor` 三段渐变 + `SunColor/SunSize/SunLum`
  日月 + `CloudColor/CloudAlpha/CloudCurve` 云层（`world.js createSky`）。

昼夜总长 `600s`（10 分钟）。

---

## 6. 后处理链

```
RenderPass ─→ GTAO ─→ UnrealBloom ─→ OutputPass(ACES+sRGB) ─→ FXAA ─→ 屏幕
```

渲染目标是 **HalfFloatType + MSAA 4x**（`samples: 4`），
整条链在 HDR 线性空间运行，最后由 OutputPass 一次性做 ACES 色调映射 + sRGB 转换。

### GTAO（环境光遮蔽）

```js
G.gtao.blendIntensity = 0.85;
G.gtao.updateGtaoMaterial({ radius: 0.4, distanceExponent: 2.0, thickness: 1.2,
  scale: 1.1, samples: 12, screenSpaceRadius: false, distanceFallOff: 1.0 });
```

**特殊处理**：GTAO 的深度/法线 pass 用 overrideMaterial，不识别 alphaTest 植被面片，
也会把不写深度的天空/水面当成遮挡体。因此渲染 AO 时临时隐藏
`sky.mesh / water.mesh / 各 chunk 植被`（包装了 `G.gtao.render`，主画面不受影响）。

### Bloom

```js
new UnrealBloomPass(size, 0.18 /* strength */, 0.6 /* radius */, 0.85 /* threshold */)
```

阈值 0.85 + 低强度：只让太阳、水面高光这类真正过曝的区域泛光，不糊画面。

### OutputPass + FXAA

- `OutputPass` 读 renderer 的 `toneMapping`（ACES）与 `outputColorSpace`（sRGB），
  是全链唯一的色调映射点。
- `FXAAShader` 作为最后一个 pass，分辨率参数在 resize 时同步更新。
  因为前面已有 MSAA 4x，FXAA 只负责清几何边缘的残余锯齿。

---

## 7. 地表材质管线（`world.terrainMat`）

`MeshStandardMaterial` + colormap，`roughness 1.0 / metalness 0 / envMapIntensity 0.22`，
原版法线图 `normalScale = 2.1`。通过 `onBeforeCompile` 注入三段逻辑：

### 7.1 颜色分层（替换 `#include <map_fragment>`）

- **坡度分层**：缓坡=土/草（colormap 为主），陡坡（`smoothstep(0.26,0.70,vSlope)`）=石作，
  高处（`vAlt`）=裸岩。让山体不再是"涂绿的纸"。
- **四张细节贴图、双尺度**：
  - `c1` dirt ×0.0345（+0.0417 转 90° 混合，打破单一走向）——大尺度基底
  - `c2` stone ×0.0750 / `c3` slab ×0.1250 —— 岩石层
  - `c4` dirt ×0.2900 —— 近景高频颗粒，以 `det*(0.55+0.9*lum)` 方式 35% 叠入
- **色彩合成**：colormap 保留大尺度色相（草绿/沙黄/雪白），
  细节以 `base * mix(1.0, mod, 0.75)` 叠加，其中 `mod = det/dl` 保证细节贴图
  均值≈1、不改变整体明度；再按坡度/高度向石色混合，岸线 3m 内压暖（滩涂）。

### 7.2 细节凹凸（替换 `#include <normal_fragment_maps>`）

用细节高度场 `detH = dot(det, luma)` 的**屏幕空间梯度**扰动法线：

```glsl
float bumpFade = (1.0 - smoothstep(50.0, 240.0, length(vWp - cameraPosition))) * uBump;
vec2 dH = vec2( dFdx(detH), dFdy(detH) ) * bumpFade;
// 三维 screen-space 偏导构建切线基，等价 baked bump 流程
normal = normalize( abs(fDet)*normal - sign(fDet)*(dH.x*R1 + dH.y*R2) );
```

- `dFdx/dFdy` 求屏幕空间导数，对贴图分辨率不敏感，无需 UV 导数。
- `bumpFade`：50m 内全强度，240m 外淡出，防远景法线噪点闪烁。
- `uBump = 0.9` 为总强度。

### 7.3 顶点属性

地形 chunk 几何带 `aSlope`（坡度）、`aAlt`（海拔）属性，
顶点着色器直传 fragment（`main.js` 替换 `#include <begin_vertex>`）。

---

## 8. 植被 / 水面 / 天空材质

### 植被（world.js）

- `MeshStandardMaterial`，`alphaTest 0.45`，`envMapIntensity 0.3`，
  交叉面片（billboard 双片）`castShadow + receiveShadow`（alphaTest 深度材质自动生效）。
- 交叉面片无合理法线 → 顶点注入强制 `objectNormal = (0,1,0)`，按地面法线受光，
  与地表明暗一致。
- 风摆：`aPhase/aSway` 属性 + 全局 `vegTime` uniform，顶点着色器注入位移。

### 水面（world.js `createWater`）

`ShaderMaterial`（transparent, depthWrite:false, renderOrder 2），全部参数来自
原版 `vscene` 的 `PlanarWater` 串。渲染：

```
法线  = 双层 normal 图扰动（0.012 频率 + 流向 uFlow）
菲涅尔 = pow(1 - dot(V,N), 4)
本体  = mix(bright,dark)×2.8 × exp(-chromaticExtinction × 深度)   // 曝光补偿 ×2.8
天光  = mix(col, uSkyHorizon, fres × (0.55 + 0.4 × reflectionParams))
镜面  = sunColor × pow(dot(N,H)) × 2.4                            // 太阳高光
alpha = clamp(uOpacity + fres×0.55, 0.3, 0.96)                    // 掠射角更不透明
```

原生接入 three 的 fog chunk（`fog: true`）。

### 天空（world.js `createSky`）

R=9000 球体 BackSide：三段渐变（Top/Middle/Bottom）+ `SkyLumScale` 有界曝光修正
（原版是 0.2~6.0 的 HDR 曝光系数，直接乘会顶到纯白）+ 日/月核心
（`pow(sd, 2400/SunSize)`）+ 大气散射晕 + 云层。不写深度、不受雾。
这张天空同时被 PMREM 采成 IBL（§4），保证天光与背景一致。

---

## 9. 关键参数速查

| 参数 | 值 | 位置 |
|---|---|---|
| 色调映射 | ACES, exposure 1.15 | main.js initScene |
| 像素比上限 | 1.5 | main.js initScene |
| 阴影贴图 | 2048², 180m 视锥, radius 6 | main.js initScene |
| shadow.bias / normalBias | -0.0006 / 0.35 | main.js initScene |
| PCSS 采样 | 9 blocker + 16 filter | pcss.js |
| IBL 刷新间隔 | 12s | updateEnvironmentIBL |
| 昼夜周期 | 600s（10 分钟） | updateDayNight |
| GTAO | blendIntensity 0.85, samples 12, radius 0.4 | main.js initScene |
| Bloom | strength 0.18, radius 0.6, threshold 0.85 | main.js initScene |
| 雾 | near/far 由 FogIntensity 推导，基线 500/5200 | updateDayNight |
| 细节凹凸 | uBump 0.9，50→240m 淡出 | terrainMat onBeforeCompile |
| 细节平铺 | dirt .0345/.2900, stone .0750, slab .1250 | terrainMat onBeforeCompile |
| 法线图强度 | normalScale 2.1 | terrainMat |

---

## 10. 已知注意事项

1. **pcss.js 必须 import 在最前**：它靠副作用改写 ShaderChunk，
   若在材质编译后加载则补丁不生效（静默降级 PCF）。
2. **GTAO 隐藏集合**（`G._gtaoHidden`）是手工维护的：新增不写深度/alphaTest 的
   大物体（如新水面、粒子）要加进去，否则 AO 会把它当遮挡体或漏采。
3. **normalBias 0.35 是上限**：清晨低角度侧光时再大会造成大片地形错误自阴影；
   换 bias 补偿时两者要联动调。
4. **IBL 禁止每帧重建**：`fromScene` 全场景渲染 6 面，清晨太阳移动快时会
   绕过 12s 节流判断之外的正确性——任何改动都必须保留节流。
5. **细节贴图要求**：必须无缝平铺（RepeatWrapping 常开）、亮度均值接近中性灰
   （`mod = det/dl` 依赖均值≈1）；分辨率无硬性要求，建议 512/1024 POT 正方形。
6. **原版色值的 HDR/LDR 差异**：vscene 的雾色、水色都按 HDR 曝光调校，
   移植时需曝光补偿（水体 ×2.8、天空 lum 映射 0.80~1.12、雾色向天空 lerp 0.45），
   新增移植材质时注意同类处理。
