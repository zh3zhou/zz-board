import type { SkinManifestV3 } from './skin.js';

/** New versions sit alongside the frozen V1 and V2 packages. */
export const officialSkinRecipes: SkinManifestV3[] = [
  {
    schemaVersion: 3, skinId: 'ink-constellation', version: '3.0.0', displayName: '夜墨',
    description: '细点落在石墨桌面上，铜色标记引向下一张便签。暖灰字适合低光阅读。',
    foundation: { paper: '#191A1B', text: '#F1EAE0', accent: '#D4A374', priority: { attention: '#E5C9A0', high: '#A25034' }, material: 'matte' },
    components: {
      background: { accent: '#B49B7D', pattern: 'dots', patternOpacity: 0.15 },
      chrome: { panel: '#232426', panelElevated: '#2D2E2F', accentSoft: '#443629', radius: 13 },
      taskBubble: { fill: '#2B2C2C', border: '#75634F', elevation: 2 },
      note: { fill: '#35322F', border: '#817361', material: 'paper' },
      link: { color: '#B79C7C', width: 1.6, opacity: 0.77 },
      inkPalette: { colors: ['#E8DFD0', '#D4A374', '#9AB7AC', '#CC9690'] }
    },
    motion: { kind: 'drift', durationMs: 19000, amplitudePx: 4, shadowPulse: 0.03 },
    assets: []
  },
  {
    schemaVersion: 3, skinId: 'archive-paper', version: '3.0.0', displayName: '静纸',
    description: '象牙白纸面配深褐墨迹，留白与浅纤维让长段中文也容易读。',
    foundation: { paper: '#E9E4D9', text: '#302D27', accent: '#76583B', priority: { attention: '#E8D4A8', high: '#934A32' }, material: 'paper' },
    components: {
      background: { pattern: 'fibers', patternOpacity: 0.055 },
      chrome: { panel: '#F7F3EA', panelElevated: '#FFFCF6', radius: 10 },
      taskBubble: { fill: '#F5F0E4', border: '#B1A38B' },
      note: { fill: '#FFFAEE', border: '#B5A48A', borderStrength: 0.32, elevation: 1 },
      link: { color: '#8B7C64', width: 1.5, opacity: 0.78 },
      inkPalette: { colors: ['#302D27', '#76583B', '#426B66', '#78546B'] }
    },
    motion: { kind: 'none', durationMs: 18000, amplitudePx: 0, shadowPulse: 0 },
    assets: []
  },
  {
    schemaVersion: 3, skinId: 'glass-drift', version: '3.0.0', displayName: '流光玻璃',
    description: '青灰网格透过磨砂层，浅色反光描出边缘。前景保留足够的阅读密度。',
    foundation: { paper: '#CFDFE0', text: '#183337', accent: '#286B70', priority: { attention: '#B5DDDA', high: '#1C656D' }, material: 'glass' },
    components: {
      background: { accent: '#508086', pattern: 'grid', patternOpacity: 0.15 },
      chrome: { panel: '#E8F2F0EE', panelElevated: '#F6FBFA', border: '#82A3A4', radius: 17, elevation: 2 },
      taskBubble: { fill: '#F2FAFAAC', border: '#76A3A5', shape: { kind: 'ellipse', aspectLockedDefault: false }, elevation: 2 },
      note: { fill: '#EFF8F3DB', border: '#85A8A1', elevation: 2 },
      link: { color: '#467B7C', highlight: '#286B70', opacity: 0.86 },
      inkPalette: { colors: ['#183337', '#286B70', '#97674E', '#625E86'] }
    },
    motion: { kind: 'drift', durationMs: 20000, amplitudePx: 5, shadowPulse: 0.03 },
    assets: []
  },
  {
    schemaVersion: 3, skinId: 'sketch-collage', version: '3.0.0', displayName: '手绘拼贴',
    description: '炭笔虚线串起蜡黄纸片与素描卡。纸角保留轻微的不齐，字面平整。',
    foundation: { paper: '#EAE1CF', text: '#302F2A', accent: '#9F503B', priority: { attention: '#F2D18A', high: '#A04432' }, material: 'paper' },
    components: {
      background: { accent: '#8D795E', pattern: 'wash', patternOpacity: 0.19 },
      chrome: { panel: '#F6EFE0', panelElevated: '#FFF9EC', radius: 7, border: '#958876' },
      taskBubble: { fill: '#F7F5E7', border: '#635F53', borderStrength: 0.94, shape: { kind: 'softBlob', cornerRadii: [43, 56, 46, 54, 52, 43, 58, 48], aspectLockedDefault: false } },
      note: { fill: '#F2DA98', border: '#7A684D', borderStrength: 0.92, shape: { kind: 'softBlob', cornerRadii: [5, 10, 7, 3, 8, 5, 9, 6], aspectLockedDefault: false } },
      link: { color: '#625E53', highlight: '#9F503B', style: 'dotted', width: 2.2, opacity: 0.91 },
      inkPalette: { colors: ['#33322D', '#9F503B', '#456B69', '#715A83'], widths: [1.5, 3, 7, 14] }
    },
    motion: { kind: 'drift', durationMs: 18000, amplitudePx: 3, shadowPulse: 0.025 },
    assets: []
  }
];
