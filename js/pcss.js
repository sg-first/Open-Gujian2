// pcss.js —— 软阴影（PCSS, Percentage-Closer Soft Shadows）
// 参考 three.js 官方示例 webgl_shadowmap_pcss 的做法：运行时改写
// ShaderChunk.shadowmap_pars_fragment，把 PCF_SOFT 分支替换成 PCSS 采样。
// 效果与 UE4 默认阴影一致：接触点锐利、离遮挡物越远阴影越宽越软。
// 使用方法：把 DirectionalLight.shadow.type 设为 PCFSoftShadowMap，
//           shadow.radius 控制基础软度（UV texel 数），shadow.mapSize 建议 2048。
import * as THREE from 'three';

const PCSS = /* glsl */`
  #define PCSS_BLOCKER_SAMPLES 9
  #define PCSS_FILTER_SAMPLES 16

  // 16 点泊松盘（单位圆内均匀分布）
  const vec2 poissonDisk[PCSS_FILTER_SAMPLES] = vec2[PCSS_FILTER_SAMPLES](
    vec2( -0.94201624, -0.39906216 ), vec2(  0.94558609, -0.76890725 ),
    vec2( -0.094184101, -0.92938870 ), vec2(  0.34495938,  0.29387760 ),
    vec2( -0.91588581,  0.45771432 ), vec2( -0.81544232, -0.87912464 ),
    vec2( -0.38277543,  0.27676845 ), vec2(  0.97484398,  0.75648379 ),
    vec2(  0.44323325, -0.97511554 ), vec2(  0.53744581, -0.47373420 ),
    vec2( -0.26496911, -0.41893023 ), vec2(  0.79197514,  0.19090188 ),
    vec2( -0.24188840,  0.99706507 ), vec2( -0.81409955,  0.91437590 ),
    vec2(  0.19984126,  0.78641367 ), vec2(  0.14383161, -0.14100790 )
  );

  // shadowCoord.z 为阴影相机归一化深度 [0,1]
  float PCSS( sampler2D shadowMap, vec2 shadowMapSize, float shadowRadius, vec4 shadowCoord ) {
    vec2 uv = shadowCoord.xy;
    float zReceiver = shadowCoord.z;
    float texel = 1.0 / shadowMapSize.x;

    // 1) 遮挡物搜索：估算最近遮挡物平均深度
    float searchRadius = texel * max( shadowRadius * 5.0, 6.0 );
    float blockerSum = 0.0;
    float blockerCount = 0.0;
    for ( int i = 0; i < PCSS_BLOCKER_SAMPLES; i ++ ) {
      float d = unpackRGBAToDepth( texture2D( shadowMap, uv + poissonDisk[ i ] * searchRadius ) );
      if ( d < zReceiver ) {
        blockerSum += d;
        blockerCount += 1.0;
      }
    }

    // 2) 半影宽度：接触点处为 0（锐利），遮挡距离越远越宽（越软）
    float penumbra = texel * max( shadowRadius * 0.5, 1.5 );
    if ( blockerCount > 0.0 ) {
      float zBlocker = blockerSum / blockerCount;
      float ratio = ( zReceiver - zBlocker ) / max( zBlocker, 1e-4 );
      penumbra = clamp( ratio, 0.0, 6.0 ) * searchRadius;
      penumbra = max( penumbra, texel );
    }

    // 3) 用泊松盘做 PCF 过滤
    float sum = 0.0;
    for ( int i = 0; i < PCSS_FILTER_SAMPLES; i ++ ) {
      sum += texture2DCompare( shadowMap, uv + poissonDisk[ i ] * penumbra, zReceiver );
    }
    return sum / float( PCSS_FILTER_SAMPLES );
  }
`;

// 精确锚定本地 r160 chunk 内文（不同版本措辞可能变化，失败则保持原样）
const PARS_ANCHOR = `float texture2DCompare( sampler2D depths, vec2 uv, float compare ) {
\t\treturn step( compare, unpackRGBAToDepth( texture2D( depths, uv ) ) );
\t}`;
const PCF_SOFT_ANCHOR = `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
\t\t\tvec2 texelSize = vec2( 1.0 ) / shadowMapSize;`;

const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
let patched = chunk.replace(PARS_ANCHOR, PARS_ANCHOR + '\n' + PCSS);
if (patched !== chunk) {
  const patched2 = patched.replace(PCF_SOFT_ANCHOR, `#elif defined( SHADOWMAP_TYPE_PCF_SOFT )
\t\t\tshadow = PCSS( shadowMap, shadowMapSize, shadowRadius, shadowCoord );
\t\t#elif defined( SHADOWMAP_TYPE_PCF_SOFT_DISABLED )
\t\t\tvec2 texelSize = vec2( 1.0 ) / shadowMapSize;`);
  if (patched2 !== patched) {
    THREE.ShaderChunk.shadowmap_pars_fragment = patched2;
    console.log('[pcss] soft-shadow patch installed');
  } else {
    console.warn('[pcss] PCF_SOFT anchor not found; soft shadows fall back to PCF');
  }
} else {
  console.warn('[pcss] chunk anchor not found; soft shadows fall back to PCF');
}
