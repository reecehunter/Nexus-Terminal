import { describe, expect, it } from 'vitest';
import {
  layoutRectangles,
  removePane,
  resizeSplit,
  splitPane,
  type PaneLayout,
} from './pane-layout';

const initial: PaneLayout = { kind: 'pane', id: 'first' };
describe('split layout', () => {
  it('combines side-by-side and stacked splits into a complete non-overlapping layout', () => {
    const columns = splitPane(initial, 'first', 'second', 'columns', 'columns');
    const nested = splitPane(columns, 'second', 'third', 'rows', 'rows');
    expect(layoutRectangles(nested).panes).toEqual([
      { id: 'first', left: 0, top: 0, width: 50, height: 100 },
      { id: 'second', left: 50, top: 0, width: 50, height: 50 },
      { id: 'third', left: 50, top: 50, width: 50, height: 50 },
    ]);
    expect(layoutRectangles(nested).dividers).toHaveLength(2);
  });
  it('collapses only the closed pane’s parent and preserves siblings and their split ratios', () => {
    const nested = resizeSplit(
      splitPane(
        splitPane(initial, 'first', 'second', 'columns', 'columns'),
        'second',
        'third',
        'rows',
        'rows',
      ),
      'rows',
      0.7,
    );
    const remaining = removePane(nested, 'first')!;
    const rectangles = layoutRectangles(remaining).panes;
    expect(rectangles.map((pane) => [pane.id, pane.width])).toEqual([
      ['second', 100],
      ['third', 100],
    ]);
    expect(rectangles[0].height).toBeCloseTo(70);
    expect(rectangles[1].height).toBeCloseTo(30);
    expect(removePane(removePane(remaining, 'second')!, 'third')).toBeNull();
  });
  it('bounds divider sizes and ignores invalid values or unknown split IDs', () => {
    const layout = splitPane(initial, 'first', 'second', 'columns', 'split');
    expect(layoutRectangles(resizeSplit(layout, 'split', -1)).panes[0].width).toBe(15);
    expect(layoutRectangles(resizeSplit(layout, 'split', 2)).panes[0].width).toBe(85);
    expect(resizeSplit(layout, 'split', NaN)).toBe(layout);
    expect(layoutRectangles(resizeSplit(layout, 'missing', 0.7))).toEqual(layoutRectangles(layout));
    expect(removePane(layout, 'missing')).toEqual(layout);
  });
});

it('navigates spatially in nested layouts without wrapping at edges', async () => {
  const { paneInDirection } = await import('./pane-layout');
  const layout = splitPane(
    splitPane(initial, 'first', 'second', 'columns', 'x'),
    'second',
    'third',
    'rows',
    'y',
  );
  expect(paneInDirection(layout, 'third', 'up')).toBe('second');
  expect(paneInDirection(layout, 'third', 'left')).toBe('first');
  expect(paneInDirection(layout, 'first', 'right')).toBe('second');
  expect(paneInDirection(layout, 'first', 'left')).toBeNull();
  expect(paneInDirection(layout, 'missing', 'right')).toBeNull();
});
