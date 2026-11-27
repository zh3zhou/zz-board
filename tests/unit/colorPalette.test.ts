import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ColorPalette, colorChannels, colorFromChannels, DEFAULT_COLOR_SLOTS } from '../../src/web/ColorPalette.js';

describe('shared RGB palette', () => {
  it('round trips RGB and clamps native numeric inputs', () => {
    expect(colorFromChannels(colorChannels('#E7c95c'))).toBe('#e7c95c');
    expect(colorFromChannels([-1, 999, 127.8])).toBe('#00ff80');
    expect(colorChannels('invalid')).toEqual([35, 32, 29]);
  });
  it('offers six distinct accessible editable color positions', () => {
    expect(new Set(DEFAULT_COLOR_SLOTS).size).toBe(6);
    const html = renderToStaticMarkup(createElement(ColorPalette, { label: '荧光笔颜色', value: DEFAULT_COLOR_SLOTS[0]!, slots: DEFAULT_COLOR_SLOTS, onChange: () => {} }));
    expect(html.match(/aria-label="荧光笔颜色自定义色 /g)).toHaveLength(6);
    expect(html).not.toContain('type="color"');
  });
});
