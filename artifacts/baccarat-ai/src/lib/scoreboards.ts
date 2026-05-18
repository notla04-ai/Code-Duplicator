import type { HandResult, Side, PairFlags } from './types';

export const ROAD_ROWS = 6;
export const CELL_SIZE = 18;

// ─── Bead Road ─────────────────────────────────────────────────────────────────
// Raw chronological display: every hand in order, with final number, pair flags, natural flag

export interface BeadRoadCell {
  side: Side;
  finalNumber: number;
  pairFlags: PairFlags;
  naturalFlag: boolean;
  index: number; // original hand index
  col: number;
  row: number;
}

export function buildBeadRoad(hands: HandResult[]): BeadRoadCell[] {
  return hands.map((hand, i) => ({
    side: hand.side,
    finalNumber: hand.number,
    pairFlags: hand.pairFlags ?? 'none',
    naturalFlag: hand.naturalFlag ?? false,
    index: i,
    col: Math.floor(i / ROAD_ROWS),
    row: i % ROAD_ROWS,
  }));
}

// ─── Big Road ─────────────────────────────────────────────────────────────────
// Casino-standard: Ties do NOT break streaks — they attach to previous B/P cell.
// Same side continues downward. Opposite side starts new column.
// Dragon tail: when column depth reaches 6, same-side overflow goes right at row 5.

export interface BigRoadCell {
  side: Side;
  ties: number;
  col: number;
  row: number;
}

export function buildBigRoad(hands: HandResult[]): BigRoadCell[] {
  const cells: BigRoadCell[] = [];
  let col = -1;
  let row = 0;
  let lastBPSide: 'B' | 'P' | null = null;
  let pendingTies = 0;
  let dragonMode = false;

  for (const hand of hands) {
    if (hand.side === 'T') {
      pendingTies++;
      continue;
    }

    if (lastBPSide === null) {
      col = 0;
      row = 0;
      dragonMode = false;
    } else if (hand.side === lastBPSide) {
      if (dragonMode) {
        // Dragon tail: same side continues rightward at bottom row
        col++;
      } else {
        row++;
        if (row >= ROAD_ROWS) {
          // Overflow: enter dragon tail — shift right, stay at bottom
          col++;
          row = ROAD_ROWS - 1;
          dragonMode = true;
        }
      }
    } else {
      // Opposite side: start fresh column at top, exit dragon tail
      col++;
      row = 0;
      dragonMode = false;
    }

    cells.push({ side: hand.side, ties: pendingTies, col, row });
    pendingTies = 0;
    lastBPSide = hand.side as 'B' | 'P';
  }

  // Attach any trailing ties to the last B/P cell
  if (pendingTies > 0 && cells.length > 0) {
    cells[cells.length - 1].ties += pendingTies;
  }

  return cells;
}

// Build a 2D column-depth grid from Big Road cells
export function buildBigRoadGrid(cells: BigRoadCell[]): (Side | null)[][] {
  if (cells.length === 0) return [];
  const maxCol = Math.max(...cells.map(c => c.col));
  const grid: (Side | null)[][] = Array.from({ length: maxCol + 1 }, () => []);
  for (const cell of cells) {
    while (grid[cell.col].length <= cell.row) grid[cell.col].push(null);
    grid[cell.col][cell.row] = cell.side;
  }
  return grid;
}

// ─── Derived Roads ─────────────────────────────────────────────────────────────
// Big Eye Boy (offset=1), Small Road (offset=2), Cockroach Pig (offset=3)
//
// WoO-standard algorithm:
//   For each Big Road cell at (col, row):
//
//   NEW COLUMN  (row == 0):
//     Compare depth of (col−1) vs depth of (col−1−offset).
//     Equal depth → RED. Different depth → BLUE.
//     Requires col >= offset+1.
//
//   SAME COLUMN (row > 0):
//     refCol = col − offset.
//     Compare: does grid[refCol][row] exist vs does grid[refCol][row−1] exist?
//     Same (both exist or both absent) → RED. Different → BLUE.
//     Requires col >= offset.

export type DerivedColor = 'R' | 'B';

export interface DerivedCell {
  color: DerivedColor;
  col: number;
  row: number;
}

function gridDepth(grid: (Side | null)[][], col: number): number {
  if (col < 0 || col >= grid.length) return 0;
  return grid[col].length;
}

function gridExists(grid: (Side | null)[][], col: number, row: number): boolean {
  if (col < 0 || col >= grid.length) return false;
  if (row < 0 || row >= grid[col].length) return false;
  return grid[col][row] !== null;
}

function buildDerivedRoadCells(
  bigRoadCells: BigRoadCell[],
  offset: number,
): DerivedCell[] {
  const grid = buildBigRoadGrid(bigRoadCells);
  const result: DerivedCell[] = [];
  let dCol = 0, dRow = 0;
  let lastColor: DerivedColor | null = null;

  for (const cell of bigRoadCells) {
    const { col, row } = cell;
    let color: DerivedColor;

    if (row === 0) {
      if (col < offset + 1) continue;
      const d1 = gridDepth(grid, col - 1);
      const d2 = gridDepth(grid, col - 1 - offset);
      color = d1 === d2 ? 'R' : 'B';
    } else {
      if (col < offset) continue;
      const refCol = col - offset;
      const cur   = gridExists(grid, refCol, row);
      const above = gridExists(grid, refCol, row - 1);
      color = cur === above ? 'R' : 'B';
    }

    if (lastColor === null || color !== lastColor) {
      if (lastColor !== null) dCol++;
      dRow = 0;
    } else {
      dRow++;
    }
    if (dRow >= ROAD_ROWS) { dCol++; dRow = 0; }
    result.push({ color, col: dCol, row: dRow });
    lastColor = color;
  }
  return result;
}

export function buildBigEyeBoy(cells: BigRoadCell[]): DerivedCell[] {
  return buildDerivedRoadCells(cells, 1);
}

export function buildSmallRoad(cells: BigRoadCell[]): DerivedCell[] {
  return buildDerivedRoadCells(cells, 2);
}

export function buildCockroachPig(cells: BigRoadCell[]): DerivedCell[] {
  return buildDerivedRoadCells(cells, 3);
}

export function roadMaxCols(cells: { col: number }[]): number {
  if (cells.length === 0) return 8;
  return Math.max(8, Math.max(...cells.map(c => c.col)) + 2);
}

// ─── Machine-readable encoded pressure sequence ───────────────────────────────

export interface EncodedPressureEntry {
  index: number;
  side: Side;
  finalNumber: number;
  band: 'LOW' | 'HIGH' | 'STRONG_HIGH' | 'KILL_SHOT';
  score: number; // -1.00 to +1.00
  label: string; // e.g. "B_HIGH"
}

export function buildEncodedPressureSequence(hands: HandResult[]): EncodedPressureEntry[] {
  return hands.map((hand, i) => {
    const n = hand.number;
    let band: EncodedPressureEntry['band'];
    if (n >= 8) band = 'KILL_SHOT';
    else if (n >= 6) band = 'STRONG_HIGH';
    else if (n >= 5) band = 'HIGH';
    else band = 'LOW';

    const bandScore =
      band === 'KILL_SHOT' ? 1.00 :
      band === 'STRONG_HIGH' ? 0.80 :
      band === 'HIGH' ? 0.60 : 0.25;

    const score = hand.side === 'T' ? 0 : hand.side === 'B' ? bandScore : -bandScore;
    const label = hand.side === 'T' ? `T_${band}` : `${hand.side}_${band}`;

    return { index: i, side: hand.side, finalNumber: n, band, score, label };
  });
}
