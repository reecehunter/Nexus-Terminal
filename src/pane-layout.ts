export type SplitDirection = 'columns' | 'rows';
export type PaneLayout =
  | { kind: 'pane'; id: string }
  | {
      kind: 'split';
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PaneLayout;
      second: PaneLayout;
    };
export interface Rectangle {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface PaneRectangle extends Rectangle {
  id: string;
}
export interface DividerRectangle extends Rectangle {
  id: string;
  direction: SplitDirection;
  ratio: number;
  position: number;
}

export function splitPane(
  layout: PaneLayout,
  paneId: string,
  newPaneId: string,
  direction: SplitDirection,
  splitId: string,
): PaneLayout {
  if (layout.kind === 'pane')
    return layout.id === paneId
      ? {
          kind: 'split',
          id: splitId,
          direction,
          ratio: 0.5,
          first: layout,
          second: { kind: 'pane', id: newPaneId },
        }
      : layout;
  return {
    ...layout,
    first: splitPane(layout.first, paneId, newPaneId, direction, splitId),
    second: splitPane(layout.second, paneId, newPaneId, direction, splitId),
  };
}
export function removePane(layout: PaneLayout, paneId: string): PaneLayout | null {
  if (layout.kind === 'pane') return layout.id === paneId ? null : layout;
  const first = removePane(layout.first, paneId);
  const second = removePane(layout.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}
export function resizeSplit(layout: PaneLayout, splitId: string, ratio: number): PaneLayout {
  if (layout.kind === 'pane' || !Number.isFinite(ratio)) return layout;
  if (layout.id === splitId) return { ...layout, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  return {
    ...layout,
    first: resizeSplit(layout.first, splitId, ratio),
    second: resizeSplit(layout.second, splitId, ratio),
  };
}
export function layoutRectangles(layout: PaneLayout): {
  panes: PaneRectangle[];
  dividers: DividerRectangle[];
} {
  const panes: PaneRectangle[] = [];
  const dividers: DividerRectangle[] = [];
  function visit(node: PaneLayout, rectangle: Rectangle) {
    if (node.kind === 'pane') {
      panes.push({ ...rectangle, id: node.id });
      return;
    }
    const columns = node.direction === 'columns';
    const position = columns
      ? rectangle.left + rectangle.width * node.ratio
      : rectangle.top + rectangle.height * node.ratio;
    dividers.push({
      ...rectangle,
      id: node.id,
      direction: node.direction,
      ratio: node.ratio,
      position,
    });
    visit(node.first, {
      ...rectangle,
      width: columns ? rectangle.width * node.ratio : rectangle.width,
      height: columns ? rectangle.height : rectangle.height * node.ratio,
    });
    visit(node.second, {
      ...rectangle,
      left: columns ? position : rectangle.left,
      top: columns ? rectangle.top : position,
      width: columns ? rectangle.width * (1 - node.ratio) : rectangle.width,
      height: columns ? rectangle.height : rectangle.height * (1 - node.ratio),
    });
  }
  visit(layout, { left: 0, top: 0, width: 100, height: 100 });
  return { panes, dividers };
}

export function paneInDirection(
  layout: PaneLayout,
  focusedId: string,
  direction: string,
): string | null {
  const panes = layoutRectangles(layout).panes;
  const source = panes.find((pane) => pane.id === focusedId);
  if (!source) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  const center = (pane: PaneRectangle) =>
    horizontal ? pane.left + pane.width / 2 : pane.top + pane.height / 2;
  const cross = (pane: PaneRectangle) =>
    horizontal ? pane.top + pane.height / 2 : pane.left + pane.width / 2;
  // Prefer an adjacent pane that overlaps the source's perpendicular span.
  return (
    panes
      .filter(
        (pane) =>
          pane.id !== focusedId && (center(pane) - center(source)) * (forward ? 1 : -1) > 0.001,
      )
      .map((pane) => {
        const overlap = horizontal
          ? Math.min(source.top + source.height, pane.top + pane.height) -
            Math.max(source.top, pane.top)
          : Math.min(source.left + source.width, pane.left + pane.width) -
            Math.max(source.left, pane.left);
        return {
          id: pane.id,
          score:
            (overlap > 0.001 ? 0 : 1000) +
            Math.abs(center(pane) - center(source)) +
            Math.abs(cross(pane) - cross(source)),
        };
      })
      .sort((a, b) => a.score - b.score)[0]?.id ?? null
  );
}
